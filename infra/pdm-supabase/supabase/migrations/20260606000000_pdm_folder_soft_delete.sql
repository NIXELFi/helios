-- Folder soft-delete (recycle bin) for pdm.folders + delete-batch restore.
--
-- Governing rule: NOTHING in the vault is ever hard-deleted. Deleting a
-- folder soft-deletes its whole subtree (folders + live files), stamping one
-- delete_batch uuid on everything so restore brings back exactly what that
-- deletion took — files deleted individually beforehand stay deleted.
--
-- Role rules: a subtree with zero live files can be deleted by any editor;
-- a subtree containing live files requires a vault admin/owner. Normal users
-- self-serve by checking out + deleting their files first (emptying it).

-- 1. Columns ----------------------------------------------------------------
alter table pdm.folders
  add column if not exists deleted_at   timestamptz,
  add column if not exists deleted_by   uuid,
  add column if not exists delete_batch uuid;
alter table pdm.files
  add column if not exists delete_batch uuid;

-- 2. delete_folder ------------------------------------------------------------
CREATE OR REPLACE FUNCTION pdm.delete_folder(p_folder_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pdm', 'public'
AS $function$
declare
  v_caller uuid := auth.uid();
  v_vault uuid;
  v_live_files int;
  v_batch uuid := gen_random_uuid();
begin
  if v_caller is null then raise exception 'authentication required'; end if;
  select vault_id into v_vault from pdm.folders
    where id = p_folder_id and deleted_at is null;
  if v_vault is null then raise exception 'folder not found'; end if;

  -- Subtree = the folder + every live descendant folder.
  -- Using a temp table (ON COMMIT DROP) rather than repeating the recursive
  -- CTE in each statement. Safe here because PostgREST RPCs run one call per
  -- transaction, so the temp table name can never collide within a session.
  create temp table _subtree on commit drop as
    with recursive sub as (
      select id from pdm.folders where id = p_folder_id and deleted_at is null
      union all
      select f.id from pdm.folders f join sub on f.parent_id = sub.id
        where f.deleted_at is null
    )
    select id from sub;

  select count(*) into v_live_files from pdm.files
    where folder_id in (select id from _subtree) and deleted_at is null;

  if v_live_files = 0 then
    if not pdm.can_edit_in(v_vault) then
      raise exception 'editor or admin role required to delete folders';
    end if;
  else
    if not pdm.is_admin_in(v_vault) then
      raise exception 'folder contains % file(s) — only a vault admin can delete it (or empty it first)', v_live_files;
    end if;
  end if;

  -- Soft-delete files first (releasing any active locks), then folders.
  update pdm.locks set released_at = now()
    where released_at is null
      and file_id in (select id from pdm.files
                       where folder_id in (select id from _subtree)
                         and deleted_at is null);
  update pdm.files
     set deleted_at = now(), deleted_by = v_caller, delete_batch = v_batch
   where folder_id in (select id from _subtree) and deleted_at is null;
  update pdm.folders
     set deleted_at = now(), deleted_by = v_caller, delete_batch = v_batch
   where id in (select id from _subtree);

  begin
    insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
      values (v_caller, 'delete', 'folder', p_folder_id,
        jsonb_build_object('soft', true, 'batch', v_batch, 'files', v_live_files));
  exception when others then null; end;
end; $function$;

-- 3. restore_folder -----------------------------------------------------------
CREATE OR REPLACE FUNCTION pdm.restore_folder(p_folder_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pdm', 'public'
AS $function$
declare
  v_caller uuid := auth.uid();
  v_vault uuid; v_deleter uuid; v_batch uuid;
  v_parent uuid;
begin
  if v_caller is null then raise exception 'authentication required'; end if;
  select vault_id, deleted_by, delete_batch, parent_id
    into v_vault, v_deleter, v_batch, v_parent
    from pdm.folders where id = p_folder_id;
  if v_vault is null then raise exception 'folder not found'; end if;
  if not (v_deleter is not distinct from v_caller or pdm.is_admin_in(v_vault)) then
    raise exception 'only the person who deleted it (or an admin) can restore it';
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
  -- so nothing comes back orphaned.
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

-- 4. PostgREST wrappers + grants (matching pdm_delete_file's posture).
CREATE OR REPLACE FUNCTION pdm.pdm_delete_folder(p_folder_id uuid)
 RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'pdm', 'public'
AS $function$ select pdm.delete_folder(p_folder_id); $function$;
CREATE OR REPLACE FUNCTION pdm.pdm_restore_folder(p_folder_id uuid)
 RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'pdm', 'public'
AS $function$ select pdm.restore_folder(p_folder_id); $function$;

revoke all on function pdm.delete_folder(uuid)      from public;
revoke all on function pdm.restore_folder(uuid)     from public;
revoke all on function pdm.pdm_delete_folder(uuid)  from public;
revoke all on function pdm.pdm_restore_folder(uuid) from public;
grant execute on function pdm.delete_folder(uuid)      to authenticated;
grant execute on function pdm.restore_folder(uuid)     to authenticated;
grant execute on function pdm.pdm_delete_folder(uuid)  to authenticated;
grant execute on function pdm.pdm_restore_folder(uuid) to authenticated;

-- FIXTURE SPOT-CHECKS (manual, post-apply):
--   editor deletes empty folder        → ok, folder gains deleted_at+batch
--   editor deletes folder w/ live file → exception 'contains N file(s)'
--   admin deletes folder w/ live file  → subtree + files share one batch
--   restore_folder                     → exactly that batch returns
--   file deleted BEFORE folder delete  → stays deleted after restore
