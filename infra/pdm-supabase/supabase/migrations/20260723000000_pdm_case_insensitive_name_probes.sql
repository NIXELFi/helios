-- Case-insensitive name probes in pdm.add_and_lock + pdm.create_folder
-- (vault phantom add/delete triage 2026-07-23, finding N4).
--
-- The DB's folder/file identity is case-sensitive (the unique indexes compare
-- verbatim), but the client matches paths case-insensitively and Windows/macOS
-- collapse `Chassis` and `chassis` to ONE directory on disk. An add whose
-- on-disk case differed from the stored row therefore created a SIBLING
-- duplicate folder or file row; two rows then mapped to one local file and
-- fought over it — alternating synced/modified verdicts and re-download thrash
-- on every sync pass, surfacing as phantom "changed/added" churn.
--
-- Fix: probe for existing rows case-insensitively (lower() = lower()) in the
-- two RPCs that create files/folders, so a case-variant reuses the existing
-- row instead of creating a twin. Inserts still store the caller's exact case.
-- When legacy case-variant duplicates already exist, the probes prefer the
-- exact-case row deterministically.
--
-- NOT changed: the unique indexes stay case-sensitive (flipping them to
-- lower() expressions would fail outright if any vault already holds
-- case-variant duplicates). That leaves a narrow concurrent-create race where
-- two different-cased inserts both succeed; the probes make the steady state
-- converge on one row, which is the part that caused user-visible churn.
--
-- Everything below is verbatim from the current sources (add_and_lock:
-- 20260721000700; create_folder: 20260721000000) except the name probes.
-- CREATE OR REPLACE only; idempotent.

-- 1. add_and_lock -------------------------------------------------------------
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
  v_parent uuid; v_guard int := 0;
begin
  if v_caller is null then raise exception 'authentication required'; end if;
  if not pdm.can_edit_in(p_vault_id) then raise exception 'editor or admin role required to add files'; end if;

  -- LIVE row probe (deleted_at is null): a soft-deleted tombstone must not be
  -- treated as an existing live file. Case-insensitive on the name (N4); when
  -- legacy case-variant duplicates exist, prefer the exact-case row.
  select f.id, v.sha256, f.latest_version_id
    into v_existing_file_id, v_existing_sha, v_existing_version_id
    from pdm.files f left join pdm.versions v on v.id = f.latest_version_id
    where f.vault_id = p_vault_id and f.folder_id is not distinct from p_folder_id
      and lower(f.name) = lower(p_name) and f.deleted_at is null
    order by (f.name = p_name) desc, f.id
    limit 1;
  if v_existing_file_id is not null then
    if lower(v_existing_sha) = lower(p_sha256) then
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
      and lower(f.name) = lower(p_name) and f.deleted_at is not null
    order by (f.name = p_name) desc, f.id
    limit 1;
  if v_deleted_file_id is not null then
    update pdm.files set deleted_at = null, deleted_by = null where id = v_deleted_file_id;

    -- Re-anchor (parity with restore_file's H4 fix, 20260619000200): walk the
    -- folder ancestor chain and clear deleted_at on any soft-deleted ANCESTOR
    -- folder so the resurrected file is browsable. Folder rows only — not the
    -- files inside them. Bounded against a corrupt parent_id cycle.
    v_parent := p_folder_id;
    while v_parent is not null loop
      v_guard := v_guard + 1;
      if v_guard > 10000 then
        exit;  -- defensive: deeper than any real hierarchy => cycle.
      end if;
      update pdm.folders
         set deleted_at = null, deleted_by = null, delete_batch = null
       where id = v_parent and deleted_at is not null;
      select parent_id into v_parent from pdm.folders where id = v_parent;
    end loop;

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

revoke execute on function pdm.add_and_lock(uuid, uuid, text, text, bigint, text) from public;
grant   execute on function pdm.add_and_lock(uuid, uuid, text, text, bigint, text) to authenticated;

-- 2. create_folder ------------------------------------------------------------
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

  -- The unique indexes admit at most ONE row (live or tombstone) per exact
  -- (vault, parent, name); the probe is case-insensitive (N4) so a
  -- case-variant reuses the existing row instead of creating a filesystem
  -- twin. Prefer the exact-case row if legacy variants coexist. Two passes:
  -- losing a concurrent race in any branch falls through to a fresh lookup.
  for attempt in 1..2 loop
    select * into v_row from pdm.folders
      where vault_id = p_vault_id
        and parent_id is not distinct from p_parent_id
        and lower(name) = lower(v_name)
      order by (name = v_name) desc, id
      limit 1;

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

revoke all on function pdm.create_folder(uuid, uuid, text) from public;
grant execute on function pdm.create_folder(uuid, uuid, text) to authenticated;
