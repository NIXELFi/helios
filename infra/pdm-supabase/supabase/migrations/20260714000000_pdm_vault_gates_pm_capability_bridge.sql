-- Bridge the pm capability model into the pdm vault gates.
--
-- The 2026-06-17 org-access design (docs/superpowers/specs/
-- 2026-06-17-org-access-and-dashboard-design.md) introduced pm.roles /
-- pm.role_capabilities / pm.role_memberships with vault.view / vault.edit /
-- vault.admin capabilities, and the Org & Access UI has been granting roles
-- (Engineer / Lead / VP / Executive) that carry them. But only the ADDITIVE
-- phase (20260617000000) ever shipped: pdm.is_member_in / can_edit_in /
-- is_admin_in and the storage INSERT policy still consult ONLY pdm.user_roles,
-- so an org-tool grant never affected vault access. Since 20260622000200
-- flipped the signup baseline to 'viewer', every post-06-22 member's effective
-- vault access has been read-only regardless of org role — engineers and even
-- subteam leads hit "new row violates row-level security policy" on upload
-- (reported 2026-07-13, Zachary Smith, engineer@Chassis).
--
-- Fix: the three vault-aware helpers and the storage INSERT policy accept
-- EITHER source of truth — a legacy pdm.user_roles row, OR a pm role
-- membership whose role carries the matching vault.* capability. Legacy rows
-- keep working untouched; capability edits made in the role editor take
-- effect immediately (no role list is hardcoded here).
--
-- Scoping note: pm role memberships are subteam-scoped while vaults are
-- season-scoped (SDM25/26/27/...) — no vault<->subteam mapping exists (open
-- question 2 in the design spec). Until one does, a vault.* capability held
-- via ANY membership grants team-wide access to ALL vaults, matching the
-- legacy convention where members held GLOBAL (vault_id IS NULL) editor rows.

-- 1. Does the caller hold a pm role carrying this capability (any scope)?
create or replace function pdm.has_vault_capability(p_cap text)
returns boolean language sql stable security definer set search_path = pm, pdm, public as $$
  select exists (
    select 1
    from pm.role_memberships m
    join pm.role_capabilities rc on rc.role_id = m.role_id
    where m.user_id = (select auth.uid())
      and rc.capability_key = p_cap
  );
$$;
revoke all on function pdm.has_vault_capability(text) from public, anon;
grant execute on function pdm.has_vault_capability(text) to authenticated;

-- 2. Repoint the vault-aware helpers: legacy pdm.user_roles OR capability.
--    Every data-table policy (files/folders/locks/versions reads+writes, the
--    storage SELECT policy) and every RPC role check (add_and_lock, check_in,
--    delete_file, set_revision, force_unlock, ...) routes through these three,
--    so this is the whole enforcement surface except the storage INSERT
--    policy handled in section 3.
create or replace function pdm.is_member_in(p_vault_id uuid)
returns boolean language sql stable security definer set search_path = pdm, public as $$
  select exists (
    select 1 from pdm.user_roles
    where user_id = auth.uid()
      and (vault_id is null or vault_id = p_vault_id)
  ) or pdm.has_vault_capability('vault.view');
$$;

create or replace function pdm.can_edit_in(p_vault_id uuid)
returns boolean language sql stable security definer set search_path = pdm, public as $$
  select exists (
    select 1 from pdm.user_roles
    where user_id = auth.uid() and role in ('owner', 'admin', 'editor')
      and (vault_id is null or vault_id = p_vault_id)
  ) or pdm.has_vault_capability('vault.edit');
$$;

create or replace function pdm.is_admin_in(p_vault_id uuid)
returns boolean language sql stable security definer set search_path = pdm, public as $$
  select exists (
    select 1 from pdm.user_roles
    where user_id = auth.uid() and role in ('owner', 'admin')
      and (vault_id is null or vault_id = p_vault_id)
  ) or pdm.has_vault_capability('vault.admin');
$$;

-- 3. storage.objects INSERT: same bridge. Content-addressed uploads happen
--    BEFORE the file/version row exists (no vault to scope by), so like the
--    legacy branch this is capability-anywhere; the key-shape checks are
--    unchanged from 20260610110000.
drop policy if exists "vault-objects insert for editors" on storage.objects;
create policy "vault-objects insert for editors" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'vault-objects'
    and (
      exists (
        select 1 from pdm.user_roles
        where user_id = (select auth.uid()) and role in ('owner', 'admin', 'editor')
      )
      or pdm.has_vault_capability('vault.edit')
    )
    and name ~ '^[0-9a-f]{2}/[0-9a-f]{64}$'
    and split_part(name, '/', 1) = left(split_part(name, '/', 2), 2)
  );
