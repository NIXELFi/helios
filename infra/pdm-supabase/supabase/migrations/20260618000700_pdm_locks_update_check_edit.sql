-- v4.4.6 fix: locks UPDATE RLS WITH CHECK verifies only ownership, not edit role.
--
-- locks_update_self_or_admin (20260610110000) gates the self branch on
-- "user_id = auth.uid()" alone. The locks_insert policy already requires
-- can_edit_in(), but a direct UPDATE lets a user re-point file_id (or re-open
-- released_at) onto a file in a vault they can NOT edit -- a write-isolation
-- bypass the insert path closes. Add the vault edit check to the self branch of
-- WITH CHECK so an updated lock still has to land on a file the caller may edit
-- (the admin branch already implies membership via is_admin_in).
--
-- The USING clause is unchanged, so the owner can still SELECT/target their own
-- lock. The legitimate RPC release flow (check_in / cancel_checkout set
-- released_at) runs SECURITY DEFINER and bypasses RLS entirely, so this does not
-- affect releases. CREATE/REPLACE the policy only. Idempotent.

drop policy if exists locks_update_self_or_admin on pdm.locks;
create policy locks_update_self_or_admin on pdm.locks
  for update to authenticated
  using (user_id = (select auth.uid()) or pdm.is_admin_in(pdm.file_vault_id(file_id)))
  with check (
    (user_id = (select auth.uid()) and pdm.can_edit_in(pdm.file_vault_id(file_id)))
    or pdm.is_admin_in(pdm.file_vault_id(file_id))
  );
