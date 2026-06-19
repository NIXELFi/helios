-- Vault restore path: ancestor re-anchor (H4) + current-role check (M5).
--
-- BUG H4 (restore_file has no ancestor re-anchor):
--   pdm.restore_file only cleared deleted_at/deleted_by on the file row. If
--   the file's parent folder (or any ancestor) is soft-deleted (e.g. an admin
--   deleted the subtree first, then a user restores one file from the recycle
--   bin), the file becomes live but folder_id still points at a deleted folder.
--   useFolders excludes deleted folders, so the file vanishes from the browse
--   tree even though it is live. FIX: copy the ancestor re-anchor loop already
--   present in restore_folder into restore_file.
--
-- BUG M5 (restore skips current-role check):
--   Both restore_file and restore_folder allowed the original deleter to restore
--   regardless of their CURRENT vault role. Because both functions are SECURITY
--   DEFINER (bypassing RLS), a user who deleted a file while an editor but has
--   since been demoted to viewer (or had their role revoked entirely) could still
--   restore it. FIX: require can_edit_in(v_vault) for the non-admin restore path
--   in both functions.
--
-- Scope: CREATE OR REPLACE on pdm.restore_file and pdm.restore_folder only.
-- Everything else (columns, delete_file, delete_folder, wrappers, grants) is
-- untouched. Wrappers are re-declared idempotently to be safe.

-- 1. pdm.restore_file  -------------------------------------------------------
--    Changes vs 20260603100000_pdm_drafts_and_soft_delete.sql:
--      • M5: guard now requires can_edit_in(v_vault) for the non-admin path.
--      • H4: after clearing deleted_at on the file, walk parent_id chain and
--            clear deleted_at on any soft-deleted ancestor FOLDERS (not files).
CREATE OR REPLACE FUNCTION pdm.restore_file(p_file_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pdm', 'public'
AS $function$
declare
  v_caller  uuid := auth.uid();
  v_vault   uuid;
  v_deleter uuid;
  v_folder  uuid;
  v_parent  uuid;
begin
  if v_caller is null then raise exception 'authentication required'; end if;
  select vault_id, deleted_by, folder_id
    into v_vault, v_deleter, v_folder
    from pdm.files where id = p_file_id;
  if v_vault is null then raise exception 'file not found'; end if;

  -- M5: admins/owners can always restore; the original deleter can only
  --     restore if they CURRENTLY hold edit rights in this vault.
  if not (
    pdm.is_admin_in(v_vault)
    or ( (v_deleter is not distinct from v_caller) and pdm.can_edit_in(v_vault) )
  ) then
    raise exception 'only the person who deleted it (and still has edit access), or an admin, can restore it';
  end if;

  -- Restore the file itself.
  update pdm.files set deleted_at = null, deleted_by = null
    where id = p_file_id;

  -- H4: Re-anchor. Walk the folder ancestor chain; clear deleted_at on any
  --     soft-deleted ancestor folder so the file is browsable after restore.
  --     We do NOT restore files inside those folders — only the folder rows
  --     themselves (matching the pattern used by restore_folder).
  v_parent := v_folder;
  while v_parent is not null loop
    update pdm.folders
       set deleted_at = null, deleted_by = null, delete_batch = null
     where id = v_parent and deleted_at is not null;
    select parent_id into v_parent from pdm.folders where id = v_parent;
  end loop;

  begin
    insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
      values (v_caller, 'restore', 'file', p_file_id, jsonb_build_object('restored', true));
  exception when others then null; end;
end; $function$;

-- 2. pdm.restore_folder  -----------------------------------------------------
--    Changes vs 20260606000000_pdm_folder_soft_delete.sql:
--      • M5: guard now requires can_edit_in(v_vault) for the non-admin path.
--      • Re-anchor loop already existed — preserved verbatim.
CREATE OR REPLACE FUNCTION pdm.restore_folder(p_folder_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pdm', 'public'
AS $function$
declare
  v_caller  uuid := auth.uid();
  v_vault   uuid;
  v_deleter uuid;
  v_batch   uuid;
  v_parent  uuid;
begin
  if v_caller is null then raise exception 'authentication required'; end if;
  select vault_id, deleted_by, delete_batch, parent_id
    into v_vault, v_deleter, v_batch, v_parent
    from pdm.folders where id = p_folder_id;
  if v_vault is null then raise exception 'folder not found'; end if;

  -- M5: admins/owners can always restore; the original deleter can only
  --     restore if they CURRENTLY hold edit rights in this vault.
  if not (
    pdm.is_admin_in(v_vault)
    or ( (v_deleter is not distinct from v_caller) and pdm.can_edit_in(v_vault) )
  ) then
    raise exception 'only the person who deleted it (and still has edit access), or an admin, can restore it';
  end if;

  if v_batch is not null then
    update pdm.folders set deleted_at = null, deleted_by = null, delete_batch = null
      where delete_batch = v_batch;
    update pdm.files set deleted_at = null, deleted_by = null, delete_batch = null
      where delete_batch = v_batch;
  else
    update pdm.folders set deleted_at = null, deleted_by = null
      where id = p_folder_id;
  end if;

  -- Re-anchor: if any ancestor of the restored folder is itself deleted
  -- (a different batch), restore the ancestor FOLDER chain (not its files)
  -- so nothing comes back orphaned. (Existing logic from 20260606000000.)
  while v_parent is not null loop
    update pdm.folders set deleted_at = null, deleted_by = null, delete_batch = null
      where id = v_parent and deleted_at is not null;
    select parent_id into v_parent from pdm.folders where id = v_parent;
  end loop;

  begin
    insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
      values (v_caller, 'restore', 'folder', p_folder_id, jsonb_build_object('batch', v_batch));
  exception when others then null; end;
end; $function$;

-- 3. PostgREST wrappers (idempotent re-declaration; no behaviour change).
CREATE OR REPLACE FUNCTION pdm.pdm_restore_file(p_file_id uuid)
 RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'pdm', 'public'
AS $function$ select pdm.restore_file(p_file_id); $function$;

CREATE OR REPLACE FUNCTION pdm.pdm_restore_folder(p_folder_id uuid)
 RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'pdm', 'public'
AS $function$ select pdm.restore_folder(p_folder_id); $function$;

-- 4. Grants (re-state to be safe; matching the locked-down posture of prior
--    migrations — revoke PUBLIC execute, grant authenticated).
revoke all on function pdm.restore_file(uuid)       from public;
revoke all on function pdm.restore_folder(uuid)     from public;
revoke all on function pdm.pdm_restore_file(uuid)   from public;
revoke all on function pdm.pdm_restore_folder(uuid) from public;
grant execute on function pdm.restore_file(uuid)       to authenticated;
grant execute on function pdm.restore_folder(uuid)     to authenticated;
grant execute on function pdm.pdm_restore_file(uuid)   to authenticated;
grant execute on function pdm.pdm_restore_folder(uuid) to authenticated;
