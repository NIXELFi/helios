# Org & Access + Dashboard Customization — Design Spec

- **Date:** 2026-06-17
- **Status:** Draft **Rev 2** (post design-review; supersedes Rev 1)
- **Target release:** v4.4.2 (ships with the shared-subsystem bug fix already on `feat/v4.4.2-org-access`)
- **Related:** bug fix `8595e90`; feature report "Improved Dashboard Customization" (`support.reports`)

> **Rev 2 note.** A design review corrected Rev 1's central premise. The PM schema **already** models subteam-scoped roles — `pm.subteam_memberships(user_id, subteam_id, role)` and `pm.effective_role()` (the *more permissive* of project/subteam role, with a guard that a global subteam role never grants access to a season the user never joined: `20260602000000_pm_schema.sql:493-547`). It is simply **unwired in the client** (`selectCanEditTask` uses project role only; no UI writes `pm.subteam_memberships`) and **not unified with Vault**. So this is **consolidate + surface + bridge**, not "invent." Rev 1's standalone `org` schema is dropped in favor of building on the existing `pm.*` helpers.

---

## 1. Motivation

The v4.4.2 "dashboard photos editable by the subteam's lead/admin + more stats" report surfaced a deeper issue: org structure is **hardcoded/fragmented** — subteams are global, EV vs IC isn't modeled, the PM subteam-role engine is dormant, and Vault has a *separate* role system. Principle (locked): **org structure is editable data with an admin tool, never hardcoded.**

## 2. Current state (verified against live DB `dlmyixonuyckxkknolku`)

| Area | Today |
|------|-------|
| Projects/seasons | `SDM26`, `SDM27` (IC), `SDM27e` (EV) — `pm.projects` (carry car identity). |
| Subteams | 11 **global** rows in `pm.subteams`. A **separate** `pdm.subteams` drives the Vault signup picker (different seed list). Signup stores subteam as a **free-text name string** in `auth.users.raw_user_meta_data`, *not* an FK. |
| PM roles | `pm.team_role {admin,lead,engineer,viewer}`. `pm.team_memberships` (per season) **+ `pm.subteam_memberships` (global per-subteam override)**. Resolver `pm.effective_role` = MAX(project, subteam), season-guarded. **Dormant: no client write path; `selectCanEditTask` ignores subteam roles.** |
| Vault roles | `pdm.user_roles {owner,admin,editor,viewer}`, per-vault. Default-deny already. UI `vault/screens/AdminScreen.tsx`. **Leak to audit:** `pm.pdm_team_role` collapses *any* pdm admin → PM `admin` regardless of vault scope. |
| Dashboards | Per-user **localStorage only** (`pm/lib/dashboardSettings.ts`). |

## 3. Goals / non-goals

**Goals**
1. **Data-driven structure:** map each subteam → project/program (`SDM27`/`SDM27e`/shared), editable in-app.
2. **Unify access** across Vault + PM on the **existing** `pm` role engine + a thin org-wide officer tier; cumulative, **default-deny**, grant-down-only.
3. New **Executive** = owner-level capability, labeled exec (collapses Pres/COO/CFO/Chief).
4. **Top-level "Org & Access"** admin surface in the main sidebar (out of the Vault tool).
5. Dashboard **histogram** (client-only) + **shared photos** (server, role-gated).

**Non-goals (this release):** editable capability matrix / custom roles (Phase C, §9); per-program differentiation of Executive; dropping legacy tables.

## 4. Role & capability model (Phase A — fixed capabilities)

| Role | Scope | Inherits | Source of truth |
|------|-------|----------|------------------|
| `owner` | org-wide | everything | bootstrap (single, Nick) |
| `executive` | org-wide | lead everywhere | **new** org-officer record |
| `lead` (`vp` = display alias) | per subteam | engineer (that subteam) | `pm.subteam_memberships` |
| `engineer` | per subteam | viewer (that subteam) | `pm.subteam_memberships` / `pm.team_memberships` |
| `viewer` | per subteam/season | — | memberships |
| _(none)_ | — | — | **default for new accounts** |

`vp` is a **display alias of `lead`**, *not* a new enum value (avoids an irreversible Postgres enum addition for an unconfirmed label — §11).

**Capability → minimum role** (Phase A, fixed in SQL helpers):

| Capability | Requires |
|------------|----------|
| View | `viewer` in scope |
| Edit tasks / check-in files in a subteam | `engineer` in that subteam (via `pm.effective_role`/`pdm.can_edit_in`) |
| Manage subteam content (subsystems, dashboard photos) | `lead` (subteam) |
| Grant **engineer/viewer** within a subteam | `lead` (subteam) |
| Edit org structure (subteam↔project), manage subteam list, grant **lead/executive** | `executive`/`owner` |

**Grant-down rule:** you may grant only roles **at or below your own scope** (a lead grants engineer/viewer only within subteams they lead; exec grants lead/engineer; only **owner** grants/edits `executive` and `owner` — see §6 bootstrap). Default-deny applies to **new accounts** *and* to the **new lead-grant power** (existing leads do not silently inherit org-wide grant ability — §8).

## 5. Data model

### 5.1 Build on the existing PM engine (no new `org` schema)
- **Subteam roles:** reuse `pm.subteam_memberships` + `pm.effective_role` (already correct + season-guarded). Add the **client write path** + RPC `pm.set_subteam_role/revoke_subteam_role` (mirrors the pdm grant RPCs' guards).
- **Org-wide officer tier (new, shared by Vault+PM):** `pm.org_officers (user_id pk, role text check (role in ('owner','executive')), granted_by, granted_at)`. Both `pm.is_any_admin`/`pm.effective_role` **and** `pdm.is_admin*` consult it (so an exec is admin everywhere in *both* products — the single shared tier that prevents two-sources-of-truth, review #7).
- **Client role payload:** new `pm.my_org_roles()` returning org-officer role + per-subteam roles, so `selectCanEditTask` can compute effective role across a task's **multiple** subteams (MAX over memberships — `pmStore.ts:438-442`). This is a real client permission-model rewrite, not a one-liner.

### 5.2 Subteam ↔ project mapping
`pm.project_subteams (project_id, subteam_id, pk(project_id, subteam_id))`. "Shared" = linked to ≥2 projects. **Seed:** existing (project × subteam) cross-product so behavior is unchanged day one; admins prune EV-only/IC-only via the tool. **Do not** derive role grants from this seed (review #3).

### 5.3 Subteam-table reconciliation (load-bearing — its own workstream)
`pm.subteams` is canonical. Required before any role cutover:
1. Repoint the Vault signup picker + admin from `pdm.subteams` to `pm.subteams`.
2. Build a **name→id reconciliation table** mapping every distinct `auth.users.raw_user_meta_data->>'subteam'` string (and every `pdm.subteams` name: Operations/Finance/MarCom/etc.) to a `pm.subteams` id; create any missing canonical subteams.
3. Backfill so no existing user is left unmapped. **Any unmapped user is a parity failure** (§8).

### 5.4 Dashboard photos
- Bucket `dashboard-photos` (private), **path convention `{project_id}/{subteam_id|all}/{uuid}`** so the storage policy can parse subteam and gate it (review #10).
- `pm.dashboard_photos (id, project_id, subteam_id null, storage_path, caption, sort_order, created_by, created_at)`.
- RLS: **select** = viewer-in-scope; **insert/update/delete** = `lead`+ of that subteam (or exec/owner) on the **table**, and a storage policy that extracts `subteam_id` from the path and applies the same check.

## 6. RLS cutover & owner bootstrap
- Repoint **every** consumer of the old gates, enumerated, not just `is_admin_in/can_edit_in`: `pdm.is_admin()` (no-arg) and its dependents (`force_unlock`, `admin_list_users`, subteam-create RPC, `support.reports` policies, storage policies), `pm.is_any_admin`, **`pm.pdm_team_role`** (fix the any-vault-admin→pm-admin leak). State for each: delegates to the shared tier, or intentionally unchanged. Parity test covers each.
- **Owner bootstrap / break-glass:** keep "can't change your own role" + "owner is bootstrap-managed," but add a **service-role seed RPC** to set the first owner/exec (recovery path). Resolve the contradiction in Rev 1 (exec must **not** be able to grant `owner`/`executive`; only owner can — §4).
- Cutover is the **highest-risk step**; ships behind §8 verification and is reversible by repointing helpers (old tables retained).

## 7. Frontend
**7.1 "Org & Access" sidebar section** (shared, top-level): **People & Roles** (grants scoped to actor; new accounts = *No access*; absorbs `AdminScreen`'s table + **grant audit**), **Org Structure** (subteams × projects matrix; subteam add/remove moves here from `SubteamsPanel`), **Roles & Permissions** (roles incl. Executive; Phase A shows §4 matrix read-only).
**7.2 Histogram widget** (client-only, **independently shippable**): new `kind:"histogram"` in `dashboardSettings.ts` (union + `makeWidget` + `normalizeWidget`), `dashboardMetrics.ts` (compute task counts bucketed by `start_date` over `[min…max]`; config: date field, granularity week/month auto, task set), `DashboardViewClient.tsx` (render + config bar). Tests in `dashboardMetrics.test.ts`.
**7.3 Photos widget** (server, role-gated): `kind:"photos"`; content from `pm.dashboard_photos` for scope; add/replace/remove gated by `can_manage(scope)`; hooks `useDashboardPhotos/useUpload/useDelete`.

## 8. Migration & verification (the risky part)
- **Preserve existing access; default-deny only for new signups.** Seed from **all three** existing sources (review #1): `pm.team_memberships`, **`pm.subteam_memberships`** (do NOT drop these), `pdm.user_roles`.
  - owner → `org_officers.owner`; **global** (`vault_id IS NULL`) Vault `admin` → `executive`; **per-vault** Vault admin → `lead` on that vault's subteams (NOT org-wide exec — review #2); PM `admin` → `executive`; existing `lead`/`engineer`/`viewer` rows carried over as-is.
  - **Do not** expand project-`lead` → lead-on-all-subteams-with-grant-power (review #3). Existing project-leads keep edit access; the **grant capability** is default-deny until the owner assigns subteam leads explicitly.
- Apply via Supabase **Management API** (the `support.reports` precedent), commit SQL mirrors under `infra/pdm-supabase/supabase/migrations/`, and **explicitly expose new schemas/objects in PostgREST** (a known footgun that has bitten every prior schema rollout — make it a checklist item, review #13).
- **Verification gate before the RLS flip:** parity check that every current user's effective capabilities — including **grant capability**, not just view/edit — are ≥ pre-migration (no lockouts, no new escalations), plus an RLS suite over role × capability across `pm`, `pdm`, `dashboard_photos`. Every unmapped subteam name (§5.3) fails the gate.
- **Rollback:** helpers are shims; revert by repointing at old tables (never dropped this release).

## 9. Phasing (build/verify order)
1. **Histogram widget** + bug fix (done) — zero backend, safe → can ship even if the rest slips.
2. `pm.project_subteams` + `pm.org_officers` + `set_subteam_role` RPC + `my_org_roles()` (additive, no enforcement).
3. Subteam-table reconciliation + backfill (§5.3); access-preserving migration (§8); run parity verification.
4. "Org & Access" admin UI (reads/writes new tables; grant audit).
5. **RLS flip** to the shared tier (PM + Vault + photos), gated on §8.
6. **Dashboard photos** (depends on 5).

**Recommended staging if "all at once" is too risky:** PM-side unification + dashboard (steps 1–4, 6-minus-vault) can ship in v4.4.2; the **Vault RLS bridge** (step 5 for `pdm`) is the highest-risk and may warrant its own verified follow-up. Flag for owner decision.

Phase **C** (later): make the §4 matrix editable with lockout guardrails.

## 10. Testing
Unit (histogram metric; effective-role/officer logic; mapping reducers; widget normalization); component (Org & Access grant-scoping + default-deny; widgets); SQL/RLS (role × capability across `pm`/`pdm`/`dashboard_photos` + storage path policy); **migration parity** (no user loses view/edit/**grant** access; no unmapped subteam).

## 11. Open questions
1. `vp` vs `lead` — shipping `vp` as a **display alias** of `lead`; confirm that's acceptable vs a distinct capability.
2. Per-vault Vault-admin mapping — plan: → subteam `lead` (not exec). Confirm.
3. "All at once" vs staged Vault bridge (§9) — owner call.
