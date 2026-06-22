-- Audit-trail gap fix: pdm.delete_folder force-unlock attribution.
--
-- When an admin deletes a folder whose subtree contains files checked out
-- (locked) by OTHER users, the previous implementation (20260606000000)
-- released those locks with a bare `update pdm.locks set released_at = now()` —
-- no force_released_by attribution and no audit entry naming the displaced
-- holders. This is the same gap closed for pdm.delete_file in 20260619000600;
-- this migration back-ports that pattern to pdm.delete_folder:
--   • Capture every active lock held by a user OTHER than the caller across the
--     soft-deleted subtree before releasing.
--   • Stamp force_released_by = caller on each displaced lock (mirrors
--     pdm.force_unlock).
--   • Write one audit_log row per displaced holder
--     (action='force_unlock', target_type='lock', payload carries
--      via='delete_folder', folder_id, file_id, displaced_holder), swallowed so
--     a logging failure can never abort the delete.
-- The caller's own locks are released exactly as before (no force attribution,
-- no force_unlock audit row). Everything else (subtree CTE, role gates, soft-
-- delete of files/folders, the existing 'delete'/'folder' audit row) is
-- preserved verbatim. CREATE OR REPLACE only; idempotent.

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
  v_lock record;
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

  -- Capture any active locks held by OTHER users across the subtree's live files
  -- BEFORE releasing them, so we can write force-unlock attribution + audit rows
  -- (mirrors pdm.delete_file in 20260619000600).
  for v_lock in
    select l.id, l.user_id, l.file_id
    from pdm.locks l
    where l.released_at is null
      and l.user_id <> v_caller
      and l.file_id in (select id from pdm.files
                         where folder_id in (select id from _subtree)
                           and deleted_at is null)
  loop
    update pdm.locks
       set released_at       = now(),
           force_released_by = v_caller
     where id = v_lock.id;

    begin
      insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
        values (
          v_caller,
          'force_unlock',
          'lock',
          v_lock.id,
          jsonb_build_object(
            'via',              'delete_folder',
            'folder_id',        p_folder_id,
            'file_id',          v_lock.file_id,
            'displaced_holder', v_lock.user_id
          )
        );
    exception when others then null; end;
  end loop;

  -- Release any remaining active locks across the subtree (i.e. the caller's own
  -- locks) — no force attribution, exactly as before.
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
