-- Editors (and admins) need to be able to create folders + files. Originally
-- this was admin-only as a conservative default; in practice the workflow is
-- driver-by-designer (editor) and forcing every file/folder creation through
-- an admin handoff is awful UX.
--
-- We replace the admin-only insert policies with admin-or-editor.

drop policy if exists folders_insert_admin on pdm.folders;
create policy folders_insert_editor on pdm.folders
  for insert to authenticated
  with check (
    exists (
      select 1 from pdm.user_roles
      where user_id = auth.uid() and role in ('admin', 'editor')
    )
  );

drop policy if exists files_insert_admin on pdm.files;
create policy files_insert_editor on pdm.files
  for insert to authenticated
  with check (
    exists (
      select 1 from pdm.user_roles
      where user_id = auth.uid() and role in ('admin', 'editor')
    )
  );

-- Update + delete on folders/files remain admin-only (renaming/moving folders
-- and deleting files have larger blast radius).
