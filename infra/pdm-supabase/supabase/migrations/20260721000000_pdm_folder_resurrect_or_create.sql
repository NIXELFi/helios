-- Folder resurrect-or-create + empty-folder cleanup (audit findings M2 + M5).
--
-- M2: the pdm.folders unique indexes (20260509000000) cover live AND
-- soft-deleted rows — so once a folder is deleted to the recycle bin, its
-- tombstone occupies the (vault_id, parent_id, name) slot forever and every
-- attempt to create a same-named folder in the same place fails with a raw
-- unique-violation. Files got a resurrect path in 20260618000300; folders
-- never did. Making the indexes partial on `deleted_at is null` instead was
-- rejected: it would let a live folder and a tombstone share a name, and a
-- later pdm_restore_folder of the tombstone would then collide.
--
-- Fix: pdm.create_folder — the one folder-create entrypoint. On a name match:
--   * live row       → return it (idempotent; also serves useAddLocalFile's
--                      bulk-add race, which previously re-queried after a 23505)
--   * tombstone      → resurrect THAT row (clear deleted_at/deleted_by/
--                      delete_batch on the folder only). Its old contents stay
--                      in the recycle bin under their delete_batch — the folder
--                      comes back EMPTY, exactly like a fresh create, and a
--                      later restore of the old batch re-fills it (children
--                      keep their batch; pdm_restore_folder's re-anchor walk
--                      handles a live ancestor fine).
--   * nothing        → plain insert.
-- Editor-gated via pdm.can_edit_in (same bar as the RLS folders_insert_editor
-- policy this replaces client-side). Resurrection is deliberately allowed at
-- editor level even though folder UPDATE is normally admin-only: the end state
-- is indistinguishable from a create, which editors may do.
--
-- M5: useAddLocalFile's ensureFolderHierarchy creates the folder chain BEFORE
-- reading/uploading the file — when a later step fails, the just-created
-- folders are stranded. pdm.cleanup_empty_folder gives the client a safe
-- best-effort undo: it acts only when the folder has no live content, checking
-- and deleting atomically server-side (a client-side check-then-delete could
-- race a concurrent add into the same folder).
--   * nothing references it at all (no files live or deleted, no child
--     folders live or deleted) → hard delete. This is the fresh-stranded-
--     folder case: the row provably holds nothing, so the "never hard-delete"
--     vault rule isn't at stake, and tombstoning it would just pollute the
--     recycle bin with phantom folders every time an import fails.
--   * only soft-deleted content references it (the resurrected-tombstone
--     case) → re-tombstone it with a fresh batch, restoring the pre-add state.
--   * any live file or live subfolder → refuse (returns false, no exception —
--     the caller's add already failed; cleanup must never mask that error).

-- 1. create_folder ------------------------------------------------------------
CREATE OR REPLACE FUNCTION pdm.create_folder(p_vault_id uuid, p_parent_id uuid, p_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pdm', 'public'
AS $function$
declare
  v_caller uuid := auth.uid();
  v_name text := btrim(p_name);
  v_row pdm.folders;
begin
  if v_caller is null then raise exception 'authentication required'; end if;
  if v_name is null or v_name = '' then raise exception 'folder name required'; end if;
  -- Mirror the client's name guard (BrowseScreen): "/" would inject phantom
  -- path segments in ensureFolderHierarchy, "."/".." are traversal on disk.
  if v_name in ('.', '..') or v_name ~ '[/\\]' or v_name ~ '[\x01-\x1f]' then
    raise exception 'invalid folder name';
  end if;
  if not pdm.can_edit_in(p_vault_id) then
    raise exception 'editor or admin role required to create folders';
  end if;
  if p_parent_id is not null then
    perform 1 from pdm.folders
      where id = p_parent_id and vault_id = p_vault_id and deleted_at is null;
    if not found then raise exception 'parent folder not found'; end if;
  end if;

  -- The unique indexes admit at most ONE row (live or tombstone) per
  -- (vault, parent, name), so a single lookup decides the branch. Two passes:
  -- losing a concurrent race in any branch falls through to a fresh lookup.
  for attempt in 1..2 loop
    select * into v_row from pdm.folders
      where vault_id = p_vault_id
        and parent_id is not distinct from p_parent_id
        and name = v_name;

    if found then
      if v_row.deleted_at is null then
        return jsonb_build_object('folder', to_jsonb(v_row), 'created', false, 'resurrected', false);
      end if;
      -- Tombstone → resurrect the row itself; its old contents stay deleted.
      update pdm.folders
         set deleted_at = null, deleted_by = null, delete_batch = null
       where id = v_row.id and deleted_at is not null
       returning * into v_row;
      if found then
        begin
          insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
            values (v_caller, 'create', 'folder', v_row.id,
              jsonb_build_object('name', v_name, 'resurrected', true));
        exception when others then null; end;
        return jsonb_build_object('folder', to_jsonb(v_row), 'created', false, 'resurrected', true);
      end if;
      -- Someone else resurrected (or hard-cleaned) it between our select and
      -- update — loop for a fresh look.
    else
      begin
        insert into pdm.folders (vault_id, parent_id, name)
          values (p_vault_id, p_parent_id, v_name)
          returning * into v_row;
        return jsonb_build_object('folder', to_jsonb(v_row), 'created', true, 'resurrected', false);
      exception when unique_violation then
        null; -- lost a concurrent create race — loop re-selects the winner
      end;
    end if;
  end loop;

  raise exception 'folder "%" is changing concurrently — try again', v_name;
end; $function$;

-- 2. cleanup_empty_folder -----------------------------------------------------
CREATE OR REPLACE FUNCTION pdm.cleanup_empty_folder(p_folder_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pdm', 'public'
AS $function$
declare
  v_caller uuid := auth.uid();
  v_row pdm.folders;
  v_has_dead boolean;
begin
  if v_caller is null then raise exception 'authentication required'; end if;

  -- Row lock serializes against a concurrent create_folder resurrect of this
  -- same row (its UPDATE blocks until we commit).
  select * into v_row from pdm.folders
    where id = p_folder_id and deleted_at is null
    for update;
  if not found then return false; end if;
  if not pdm.can_edit_in(v_row.vault_id) then
    raise exception 'editor or admin role required';
  end if;

  -- Any LIVE content → not ours to touch.
  if exists (select 1 from pdm.files where folder_id = p_folder_id and deleted_at is null)
     or exists (select 1 from pdm.folders where parent_id = p_folder_id and deleted_at is null)
  then
    return false;
  end if;

  v_has_dead :=
       exists (select 1 from pdm.files where folder_id = p_folder_id)
    or exists (select 1 from pdm.folders where parent_id = p_folder_id);

  if v_has_dead then
    -- Resurrected-tombstone case: recycle-bin content still points here, so
    -- put the tombstone back rather than orphaning that content.
    update pdm.folders
       set deleted_at = now(), deleted_by = v_caller, delete_batch = gen_random_uuid()
     where id = p_folder_id;
  else
    -- Provably-empty husk from a failed import: nothing (live or deleted) has
    -- ever referenced it, so a hard delete loses nothing and keeps the
    -- recycle bin free of phantom folders.
    delete from pdm.folders where id = p_folder_id;
  end if;

  begin
    insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
      values (v_caller, 'delete', 'folder', p_folder_id,
        jsonb_build_object('cleanup', true, 'soft', v_has_dead, 'name', v_row.name));
  exception when others then null; end;
  return true;
end; $function$;

-- 3. PostgREST wrappers + grants (matching pdm_delete_folder's posture) -------
CREATE OR REPLACE FUNCTION pdm.pdm_create_folder(p_vault_id uuid, p_parent_id uuid, p_name text)
 RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO 'pdm', 'public'
AS $function$ select pdm.create_folder(p_vault_id, p_parent_id, p_name); $function$;
CREATE OR REPLACE FUNCTION pdm.pdm_cleanup_empty_folder(p_folder_id uuid)
 RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path TO 'pdm', 'public'
AS $function$ select pdm.cleanup_empty_folder(p_folder_id); $function$;

revoke all on function pdm.create_folder(uuid, uuid, text)          from public;
revoke all on function pdm.cleanup_empty_folder(uuid)               from public;
revoke all on function pdm.pdm_create_folder(uuid, uuid, text)      from public;
revoke all on function pdm.pdm_cleanup_empty_folder(uuid)           from public;
grant execute on function pdm.create_folder(uuid, uuid, text)          to authenticated;
grant execute on function pdm.cleanup_empty_folder(uuid)               to authenticated;
grant execute on function pdm.pdm_create_folder(uuid, uuid, text)      to authenticated;
grant execute on function pdm.pdm_cleanup_empty_folder(uuid)           to authenticated;
