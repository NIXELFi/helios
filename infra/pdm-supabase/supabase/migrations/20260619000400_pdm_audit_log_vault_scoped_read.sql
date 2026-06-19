-- Vault-scoped audit_log SELECT (2026-06-19 audit M6: cross-vault metadata leak).
--
-- BUG M6:
--   20260610100000_pdm_vault_scoped_reads.sql tightened audit_log SELECT from
--   using(true) (any authenticated user) to:
--
--       exists (select 1 from pdm.user_roles ur where ur.user_id = auth.uid())
--
--   This is still too broad: any role-holder (global OR per-vault) can read
--   EVERY row in audit_log — including rows for actions in vaults they are
--   not a member of. A viewer in vault A can read check-in/force-unlock/
--   role-change events from vault B via a direct PostgREST read.
--
-- ROOT CAUSE:
--   audit_log has no vault_id column. The 2026-06-10 migration explicitly
--   deferred per-target vault resolution ("follow-up: stamp vault_id at write
--   time and scope by it"), leaving the policy intentionally incomplete.
--   Per-target-type resolution (lock→file→vault, version→file→vault, etc.)
--   is fragile: `user_role` events carry a user_id in target_id, not a
--   vaultable entity, so the join pattern cannot cover all action types.
--
-- FIX:
--   Replace the role-holder predicate with a two-clause pattern:
--
--       user_id = auth.uid()           -- own activity (check-in/out, etc.)
--       OR exists (                    -- GLOBALLY-scoped admin/owner only
--           select 1 from pdm.user_roles
--           where user_id = auth.uid()
--             and role in ('owner','admin')
--             and vault_id is null     -- vault_id IS NULL = global grant
--         )
--
--   WHY NOT pdm.is_admin():
--     After 20260531000000_pdm_per_vault_roles.sql, pdm.user_roles gained a
--     nullable vault_id column. pdm.is_admin() (20260529000000 lines 38-41)
--     queries user_roles with NO vault_id filter:
--
--         exists (select 1 from pdm.user_roles
--                 where user_id = auth.uid() and role in ('owner','admin'))
--
--     A per-vault admin row (role='admin', vault_id='vault-A') satisfies
--     is_admin(), so a user who is admin in ONE vault could read EVERY vault's
--     audit rows. We do NOT change is_admin() — other policies and RPCs rely on
--     it for vault-scoped admin checks (e.g. force_unlock, folders, files).
--     Instead, we inline the global-only predicate (vault_id IS NULL) here so
--     only truly-global grants (owner or admin promoted globally, vault_id NULL)
--     receive cross-vault audit visibility.
--
--   Rationale:
--     1. Closes the cross-vault leak: a per-vault admin/viewer can no longer
--        read another vault's structural or lock events.
--     2. Global owners/admins (vault_id IS NULL) retain full audit visibility —
--        they are trusted with cross-vault operations by design (force_unlock,
--        role management, etc.).
--     3. Non-global-admin users see only their own audit rows. This is
--        intentionally conservative: a future migration can add per-vault member
--        visibility once audit_log grows a vault_id column stamped at write time.
--     4. The frontend never reads audit_log directly — all audit display goes
--        through security-definer RPCs (vault_insights_extra) or the service
--        role. The rls-vault-scoped-reads tests confirm no client code relies on
--        direct audit_log reads by non-admin non-self callers.
--
-- TRADEOFF NOTE:
--   Non-admin members lose visibility into other members' actions in their own
--   vault. Until vault_id is stamped on write, there is no safe way to expose
--   a "vault activity feed" to non-admins via direct RLS. A future RPC
--   (security definer, takes p_vault_id) can bridge this gap without changing
--   the RLS policy. This is safer than a fragile per-target-type join that
--   would silently admit rows whose target_type is unrecognized.

drop policy if exists audit_log_read on pdm.audit_log;
create policy audit_log_read on pdm.audit_log
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or exists (
      select 1 from pdm.user_roles
      where user_id = (select auth.uid())
        and role in ('owner', 'admin')
        and vault_id is null
    )
  );
