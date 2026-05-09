alter table pdm.locks enable row level security;

-- Read: any authenticated user.
create policy locks_read on pdm.locks
  for select to authenticated using (true);

-- Insert: editors and admins. The user_id must equal the caller; clients can't
-- create a lock on someone else's behalf.
create policy locks_insert on pdm.locks
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from pdm.user_roles
      where user_id = auth.uid() and role in ('admin', 'editor')
    )
  );

-- Update (release): the caller must be the lock holder OR an admin (force-release).
-- Note: real release/force-release should go through pdm.cancel_checkout /
-- pdm.force_unlock RPCs, but allowing direct UPDATE keeps integration tests
-- straightforward and is harmless because the caller still must satisfy this rule.
create policy locks_update_self_or_admin on pdm.locks
  for update to authenticated
  using (user_id = auth.uid() or pdm.is_admin())
  with check (user_id = auth.uid() or pdm.is_admin());

-- No delete policy: rows are never deleted, only updated to set released_at.
