# Per-Vault Roles + SolidWorks Data Cards — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** (A) Scope a user's admin/editor/viewer role per vault (editor in SDM27, viewer in SDM26) instead of one global role. (B) Surface a file's SolidWorks custom properties as a data card, syncing bidirectionally with the `.sldprt/.slddrw` file.

**Status:** Decided with the user 2026-05-30. NOT yet implemented. Branch `feat/pdm-swpdm-parity`. Test against **SDM26** (populated); SDM27 is empty.

---

## Feature A — Per-vault roles (additive, NULL = global)

**Design (keeps every existing test green):** `pdm.user_roles` gains a nullable `vault_id`. A row with `vault_id IS NULL` is a **global** role (applies to all vaults — preserves today's behavior and the bootstrap `owner`). A row with `vault_id` set grants that role **only in that vault**. The global `is_admin()` stays as-is; new vault-aware helpers are added and the data-table RLS policies switch to them. Because existing grants are global, prior behavior is unchanged.

### Task A1: Migration — schema + vault-aware helpers
**File:** `infra/pdm-supabase/supabase/migrations/20260531000000_pdm_per_vault_roles.sql`

- [ ] **Step 1: schema.**
```sql
alter table pdm.user_roles add column if not exists vault_id uuid references pdm.vaults(id) on delete cascade;
-- Drop the user_id PK; uniqueness is now (user_id, vault_id) with NULL = the single "global" slot.
alter table pdm.user_roles drop constraint if exists user_roles_pkey;
create unique index if not exists user_roles_user_vault_uniq
  on pdm.user_roles (user_id, coalesce(vault_id, '00000000-0000-0000-0000-000000000000'::uuid));
```
- [ ] **Step 2: vault-aware helpers (NEW — do NOT drop is_admin(); policies depend on it).**
```sql
-- owner (global) OR a global admin OR an admin of this specific vault.
create or replace function pdm.is_admin_in(p_vault_id uuid)
returns boolean language sql stable security definer set search_path=pdm,public as $$
  select exists (select 1 from pdm.user_roles
    where user_id = auth.uid() and role in ('owner','admin')
      and (vault_id is null or vault_id = p_vault_id));
$$;
-- the above OR a global/this-vault editor.
create or replace function pdm.can_edit_in(p_vault_id uuid)
returns boolean language sql stable security definer set search_path=pdm,public as $$
  select exists (select 1 from pdm.user_roles
    where user_id = auth.uid() and role in ('owner','admin','editor')
      and (vault_id is null or vault_id = p_vault_id));
$$;
grant execute on function pdm.is_admin_in(uuid), pdm.can_edit_in(uuid) to authenticated;
```
- [ ] **Step 3: repoint data-table RLS to the vault-aware helpers.** Drop + recreate the policies in `20260507000200_pdm_rls_structure.sql` (folders/files insert/update/delete) and `20260508000400` (files/folders editor-insert) and `20260507000300` (locks insert) so each references the **row's** vault:
  - `pdm.folders`, `pdm.files`: `with check (pdm.is_admin_in(vault_id))` / `using (pdm.is_admin_in(vault_id))`; editor-insert → `can_edit_in(vault_id)`.
  - `pdm.locks` insert: the row has `file_id`, not `vault_id` → resolve: `can_edit_in((select vault_id from pdm.files where id = file_id))`.
  - `pdm.versions` insert (lockholder policy): already gated by holding the lock; leave as-is (the lock acquisition is now vault-gated).
- [ ] **Step 4: vault-scope the RPC editor checks.** In `add_and_lock` (idempotent, `20260511001100`) and `set_revision` (`20260530140000`) replace the global `role in ('admin','editor')` / `is_admin()` checks with `pdm.can_edit_in(<vault of the file>)`. In `force_unlock` replace `is_admin()` with `is_admin_in(<vault of the lock's file>)`.
- [ ] **Step 5: test + apply.** New `tests/rls-per-vault-roles.test.ts`: a user with `(editor, SDM26)` can check out/in in SDM26 but is denied in SDM27; a global editor (vault_id null) works in both; verify the existing global-role suite still passes. Apply via psql (avoid db:reset/env-wipe) + `NOTIFY pgrst,'reload schema'`. Run the FULL backend suite — expect all prior tests green (global roles unchanged) + new ones.

### Task A2: Role-management RPCs gain a vault dimension
**File:** same migration or `20260531000100_pdm_role_rpcs_vault.sql`
- [ ] `set_user_role(p_target, p_role, p_vault_id uuid default null)` — null ⇒ global grant (unchanged); set ⇒ per-vault. Fix the `on conflict` to target the new expression index (write it explicitly in plpgsql: update-if-exists-else-insert keyed on `(user_id, coalesce(vault_id, ZERO))`). Per-vault grant authorized by `is_admin_in(p_vault_id)`; admin-grant still owner-only.
- [ ] `revoke_user_role(p_target, p_vault_id default null)` — null ⇒ remove the global row; set ⇒ remove that vault's row.
- [ ] New `pdm.list_vault_roles(p_vault_id)` returning each user + their effective role in that vault (global row falls back). Keep `admin_list_users()` working (join the global row) for back-compat.
- [ ] Update the `setRole` **test helper** (`tests/setup.ts`) to write a global row via delete-then-insert (supabase-js `upsert` can't target the coalesce index). Add a `setVaultRole(userId, role, vaultId)` helper for the new tests.

### Task A3: Client — per-vault role awareness
**Files:** `apps/desktop/src/modules/vault/data/useMyRole.ts`, `useIsAdmin.ts`, `useIsOwner.ts`, `screens/AdminScreen.tsx`, `data/useSetUserRole.ts`, `useRevokeUserRole.ts`
- [ ] `useMyRole`/`useIsAdmin` resolve the role for the **active vault** (call the vault-aware RPC or compute from a per-vault listing). `canEdit` in `BrowseScreen` becomes per-active-vault.
- [ ] `AdminScreen`: add a vault selector; manage roles per vault; show effective (global vs per-vault) role. `useSetUserRole`/`useRevokeUserRole` pass the active vault id.
- [ ] Tests for each hook + AdminScreen per-vault behavior (vitest).

---

## Feature B — Data cards synced from SolidWorks custom properties

**Decision:** bidirectional sync between a file's SolidWorks custom properties and a Helios data card.

**⚠️ Spike first.** SolidWorks custom properties are stored in the CFB container in a SW-specific layout (not always standard OLE `\005SummaryInformation` property sets, and the layout has changed across SW versions). Before committing to the bidirectional design, **validate the read against a real SDM26 file**:
- [ ] **B0 (spike):** download a known `.sldprt` from the SDM26 vault (via the glassypdm-probe tooling or Helios storage), and reverse-engineer where its custom properties live in the CFB. Extend `crates/pdm-sw-parser` with an experiment that dumps stream names + candidate property bytes. Confirm we can reliably read name/value pairs. **If the format is intractable, fall back to the "in-app fields per vault" model and re-confirm with the user.**

Assuming the spike succeeds:
- [ ] **B1 (Rust read):** `pdm_sw_parser::parse_custom_properties(bytes) -> Vec<(String, String)>`; Tauri command `parse_sw_properties(path)`. Tests against the SDM26 sample.
- [ ] **B2 (storage):** `pdm.file_properties (file_id, version_id, name, value)` (or a jsonb column on versions) + RLS (read all; write via RPC `pdm_set_file_properties`, editor+ vault-scoped via `can_edit_in`). Properties are captured at check-in (extend `useRecordRefs`-style post-check-in hook) and/or read on demand.
- [ ] **B3 (UI):** a "Properties" section in `FileDetailPanel` showing name/value; editable when `canEdit`.
- [ ] **B4 (Rust write-back — hardest):** write edited values back into the `.sldprt` CFB property stream so the next check-in carries them. This is the risky part (mutating CFB streams without corrupting the file); gate behind the spike and consider read-only-first shipping.

---

## Sequencing note
Feature A is a coherent backend+client unit; ship A1+A2 (backend, verified, all tests green) before A3 (client). Feature B should start with the B0 spike against SDM26 before any schema/UI work — the bidirectional write-back (B4) may be deferred to a read-only-first release.
