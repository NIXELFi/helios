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
--   Replace the role-holder predicate with the same two-clause pattern used
--   for user_roles_read in 20260610100000:
--
--       user_id = auth.uid()           -- own activity (check-in/out, etc.)
--       OR pdm.is_admin()              -- global admin / owner: full cross-vault read
--
--   Rationale:
--     1. Closes the cross-vault leak: a per-vault viewer can no longer read
--        another vault's structural or lock events.
--     2. Matches the existing RLS helper style (is_admin is already security
--        definer, stable, and used by every other policy that needs admin bypass).
--     3. Admins retain full audit visibility (they are trusted with cross-vault
--        operations by design — force_unlock, role management, etc.).
--     4. Non-admin users see only their own audit rows. This is intentionally
--        conservative: a future migration can add per-vault member visibility
--        once audit_log grows a vault_id column stamped at write time.
--     5. The frontend never reads audit_log directly — all audit display goes
--        through security-definer RPCs (vault_insights_extra) or the service
--        role. The rls-vault-scoped-reads tests confirm no client code relies
--        on direct audit_log reads by non-admin non-self callers.
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
    or pdm.is_admin()
  );
