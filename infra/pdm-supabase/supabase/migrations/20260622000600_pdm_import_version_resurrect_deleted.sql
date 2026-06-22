-- Soft-delete fix: import_version's idempotency probe ignores soft-deleted files.
--
-- pdm.import_version (20260524000000) probes for an existing file by
-- (vault_id, folder_id, name) WITHOUT filtering deleted_at. If a file by that
-- name was soft-deleted (recycle bin), the import finds the tombstoned row and
-- chains a brand-new version onto it. The file stays deleted_at IS NOT NULL, so
-- the imported content is invisible in the browse tree (useFolders/useFiles
-- exclude tombstones) — the import silently lands on an invisible file and the
-- caller believes it succeeded.
--
-- Fix: mirror the resurrect pattern used by add_and_lock (20260618000300). Probe
-- LIVE rows first; if none, look for a SOFT-DELETED row occupying this
-- (vault_id, folder_id, name) and RESURRECT it in place (clear deleted_at /
-- deleted_by) before chaining the imported version, so the content comes back
-- live and browsable. The unique(folder_id, name) constraint covers tombstones,
-- so resurrecting the existing row is the only correct path (a fresh insert
-- would collide). Re-anchor any soft-deleted ANCESTOR folders too, bounded
-- against a corrupt parent_id cycle (parity with restore_file's H4 fix).
--
-- Everything else (service_role gate, version chaining, idempotent no-op on a
-- matching sha) is verbatim from 20260524000000. CREATE OR REPLACE only;
-- idempotent.

create or replace function pdm.import_version(
  p_vault_id uuid,
  p_folder_id uuid,
  p_name text,
  p_sha256 text,
  p_size bigint,
  p_comment text,
  p_created_at timestamptz,
  p_import_metadata jsonb
) returns jsonb
language plpgsql
security definer
set search_path = pdm, public
as $func$
declare
  v_role text := current_setting('request.jwt.claims', true)::jsonb->>'role';
  v_file_id uuid;
  v_existing_version_id uuid;
  v_existing_version_num int;
  v_new_version_id uuid;
  v_next_num int;
  v_parent_id uuid;
  v_was_deleted boolean := false;
  v_parent uuid;
  v_guard int := 0;
begin
  if v_role is null or v_role <> 'service_role' then
    raise exception 'service_role required to call pdm.import_version (got role=%)', coalesce(v_role, '<none>');
  end if;

  -- Idempotency probe: same (vault_id, folder_id, name)? LIVE row first.
  select id into v_file_id
  from pdm.files
  where vault_id = p_vault_id
    and folder_id is not distinct from p_folder_id
    and name = p_name
    and deleted_at is null;

  -- No live row: a SOFT-DELETED row may occupy this (folder, name) — the
  -- unique(folder_id, name) constraint covers tombstones, so a fresh insert
  -- would collide. Resurrect it in place and chain the imported version onto it.
  if v_file_id is null then
    select id into v_file_id
    from pdm.files
    where vault_id = p_vault_id
      and folder_id is not distinct from p_folder_id
      and name = p_name
      and deleted_at is not null;
    if v_file_id is not null then
      v_was_deleted := true;
      update pdm.files set deleted_at = null, deleted_by = null where id = v_file_id;

      -- Re-anchor soft-deleted ANCESTOR folders so the resurrected file is
      -- browsable (parity with restore_file / add_and_lock). Folder rows only.
      v_parent := p_folder_id;
      while v_parent is not null loop
        v_guard := v_guard + 1;
        if v_guard > 10000 then exit; end if;  -- defensive: cycle.
        update pdm.folders
           set deleted_at = null, deleted_by = null, delete_batch = null
         where id = v_parent and deleted_at is not null;
        select parent_id into v_parent from pdm.folders where id = v_parent;
      end loop;
    end if;
  end if;

  if v_file_id is not null then
    -- File exists (live, or just-resurrected). If a version with this sha
    -- already exists, no-op.
    select id, version_num
    into v_existing_version_id, v_existing_version_num
    from pdm.versions
    where file_id = v_file_id and sha256 = p_sha256
    limit 1;

    if v_existing_version_id is not null then
      return jsonb_build_object(
        'file_id', v_file_id,
        'version_id', v_existing_version_id,
        'version_num', v_existing_version_num,
        'created', false,
        'resurrected', v_was_deleted
      );
    end if;

    -- Different sha -> new version chained to current latest.
    select coalesce(max(version_num), 0) + 1 into v_next_num
    from pdm.versions where file_id = v_file_id;

    select id into v_parent_id
    from pdm.versions where file_id = v_file_id
    order by version_num desc limit 1;
  else
    insert into pdm.files (vault_id, folder_id, name)
    values (p_vault_id, p_folder_id, p_name)
    returning id into v_file_id;
    v_next_num := 1;
    v_parent_id := null;
  end if;

  insert into pdm.versions (
    file_id, version_num, sha256, size_bytes, author_id, comment,
    parent_version_id, created_at, import_metadata
  ) values (
    v_file_id, v_next_num, p_sha256, p_size, null, p_comment,
    v_parent_id, p_created_at, p_import_metadata
  ) returning id into v_new_version_id;

  update pdm.files set latest_version_id = v_new_version_id where id = v_file_id;

  return jsonb_build_object(
    'file_id', v_file_id,
    'version_id', v_new_version_id,
    'version_num', v_next_num,
    'created', true,
    'resurrected', v_was_deleted
  );
end;
$func$;
