-- v4.4.6 fix: add_and_lock's idempotency probe ignores soft-delete.
--
-- The "already exists in this folder" probe in add_and_lock (20260603100000)
-- matches on (vault_id, folder_id, name) WITHOUT filtering deleted_at, so
-- re-adding a file that was soft-deleted (recycle bin) finds the tombstoned row
-- and either no-ops ('created:false', file stays deleted/invisible) or raises a
-- spurious "different content" error -- the user can never re-add a name they
-- previously deleted.
--
-- Fix: the probe now matches only LIVE rows (deleted_at is null). A re-add that
-- targets a name occupied by a soft-deleted row RESURRECTS that row in place
-- (clear deleted_at/deleted_by, re-lock) instead of failing -- the unique
-- (folder_id, name) constraint covers tombstones too, so re-creating a fresh row
-- would collide; resurrecting the existing one is the clean path and preserves
-- its version history. Recreates the current body (from 20260603100000) plus
-- this handling. Idempotent.

CREATE OR REPLACE FUNCTION pdm.add_and_lock(p_vault_id uuid, p_folder_id uuid, p_name text, p_sha256 text, p_size bigint, p_comment text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pdm', 'public'
AS $function$
declare
  v_caller uuid := auth.uid();
  v_existing_file_id uuid; v_existing_sha text; v_existing_version_id uuid; v_existing_lock_id uuid;
  v_deleted_file_id uuid; v_deleted_version_id uuid; v_resurrect_lock_id uuid;
  v_file_id uuid; v_version_id uuid; v_lock_id uuid;
begin
  if v_caller is null then raise exception 'authentication required'; end if;
  if not pdm.can_edit_in(p_vault_id) then raise exception 'editor or admin role required to add files'; end if;

  -- LIVE row probe (deleted_at is null): a soft-deleted tombstone must not be
  -- treated as an existing live file.
  select f.id, v.sha256, f.latest_version_id
    into v_existing_file_id, v_existing_sha, v_existing_version_id
    from pdm.files f left join pdm.versions v on v.id = f.latest_version_id
    where f.vault_id = p_vault_id and f.folder_id is not distinct from p_folder_id
      and f.name = p_name and f.deleted_at is null;
  if v_existing_file_id is not null then
    if v_existing_sha = p_sha256 then
      select id into v_existing_lock_id from pdm.locks
        where file_id = v_existing_file_id and user_id = v_caller and released_at is null;
      if v_existing_lock_id is null then
        begin
          insert into pdm.locks (file_id, user_id) values (v_existing_file_id, v_caller)
            returning id into v_existing_lock_id;
        exception when unique_violation then v_existing_lock_id := null;
        end;
      end if;
      return jsonb_build_object('file_id', v_existing_file_id, 'version_id', v_existing_version_id,
        'lock_id', v_existing_lock_id, 'created', false);
    else
      raise exception 'file "%" already exists in this folder with different content. Use the check-in flow to add a new version.', p_name;
    end if;
  end if;

  -- A SOFT-DELETED row occupies this (folder, name)? Resurrect it in place
  -- (the unique(folder_id, name) constraint covers tombstones, so a fresh insert
  -- would collide). Clear the tombstone, re-acquire the lock, return created:false.
  select f.id, f.latest_version_id into v_deleted_file_id, v_deleted_version_id
    from pdm.files f
    where f.vault_id = p_vault_id and f.folder_id is not distinct from p_folder_id
      and f.name = p_name and f.deleted_at is not null;
  if v_deleted_file_id is not null then
    update pdm.files set deleted_at = null, deleted_by = null where id = v_deleted_file_id;
    select id into v_resurrect_lock_id from pdm.locks
      where file_id = v_deleted_file_id and user_id = v_caller and released_at is null;
    if v_resurrect_lock_id is null then
      begin
        insert into pdm.locks (file_id, user_id) values (v_deleted_file_id, v_caller)
          returning id into v_resurrect_lock_id;
      exception when unique_violation then v_resurrect_lock_id := null;
      end;
    end if;
    insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
      values (v_caller, 'restore', 'file', v_deleted_file_id,
        jsonb_build_object('via', 'add_and_lock', 'resurrected', true));
    return jsonb_build_object('file_id', v_deleted_file_id, 'version_id', v_deleted_version_id,
      'lock_id', v_resurrect_lock_id, 'created', false);
  end if;

  -- NEW: created_by set, published_at left null => private draft.
  insert into pdm.files (vault_id, folder_id, name, created_by)
    values (p_vault_id, p_folder_id, p_name, v_caller) returning id into v_file_id;
  insert into pdm.versions (file_id, version_num, sha256, size_bytes, author_id, comment, parent_version_id)
    values (v_file_id, 1, p_sha256, p_size, v_caller, p_comment, null) returning id into v_version_id;
  update pdm.files set latest_version_id = v_version_id where id = v_file_id;
  insert into pdm.locks (file_id, user_id) values (v_file_id, v_caller) returning id into v_lock_id;
  insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
    values (v_caller, 'check_in', 'version', v_version_id,
      jsonb_build_object('file_id', v_file_id, 'version_num', 1, 'sha256', p_sha256, 'via', 'add_and_lock', 'draft', true));
  return jsonb_build_object('file_id', v_file_id, 'version_id', v_version_id, 'lock_id', v_lock_id, 'created', true);
end; $function$;
