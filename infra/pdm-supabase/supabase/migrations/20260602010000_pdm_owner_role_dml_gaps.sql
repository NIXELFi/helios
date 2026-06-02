-- Fix: the 'owner' role (added in 20260529000000_pdm_owner_role_and_admin_panel)
-- was never added to several write policies that predate it and hardcoded
-- `role in ('admin', 'editor')`. Per the documented model — "owner counts as
-- admin everywhere is_admin() is consulted" — an owner must be able to create
-- folders/files, acquire locks, and upload objects.
--
-- Symptom: an owner adding a new file to the Vault got
--   "new row violates row-level security policy"
-- on the storage.objects upload (apps/desktop/.../useAddLocalFile.ts step 3),
-- because the storage INSERT policy only allowed admin/editor.
--
-- This brings the four pre-owner write policies in line with the role model by
-- adding 'owner' to each allowed-role list. (pdm.add_and_lock already uses
-- pdm.is_admin(), so it needs no change.)

-- 1. storage.objects — upload to the vault-objects bucket.
drop policy if exists "vault-objects insert for editors" on storage.objects;
create policy "vault-objects insert for editors" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'vault-objects'
    and exists (
      select 1 from pdm.user_roles
      where user_id = auth.uid() and role in ('owner', 'admin', 'editor')
    )
  );

-- 2. pdm.folders — create folder.
alter policy folders_insert_editor on pdm.folders
  with check (
    exists (
      select 1 from pdm.user_roles
      where user_id = auth.uid() and role in ('owner', 'admin', 'editor')
    )
  );

-- 3. pdm.files — create file.
alter policy files_insert_editor on pdm.files
  with check (
    exists (
      select 1 from pdm.user_roles
      where user_id = auth.uid() and role in ('owner', 'admin', 'editor')
    )
  );

-- 4. pdm.locks — acquire a lock.
alter policy locks_insert on pdm.locks
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from pdm.user_roles
      where user_id = auth.uid() and role in ('owner', 'admin', 'editor')
    )
  );
