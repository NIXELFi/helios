-- 5.2.1 hardening: normalize the SHA comparison in pdm.add_and_lock.
--
-- The idempotency probe compared `v_existing_sha = p_sha256` case-sensitively,
-- while check_in / restore_version compare with lower(). A client that hex-
-- encodes uppercase would be told "already exists with different content" for
-- a byte-identical file. Latent (the desktop client emits lowercase hex), but
-- inconsistent with the rest of the RPC surface.
--
-- Fix: `lower(v_existing_sha) = lower(p_sha256)`. Everything else is verbatim
-- from 20260622000500 (the current source). CREATE OR REPLACE only; idempotent.

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
  -- treated as an existing live file.
  select f.id, v.sha256, f.latest_version_id
    into v_existing_file_id, v_existing_sha, v_existing_version_id
    from pdm.files f left join pdm.versions v on v.id = f.latest_version_id
    where f.vault_id = p_vault_id and f.folder_id is not distinct from p_folder_id
      and f.name = p_name and f.deleted_at is null;
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
      and f.name = p_name and f.deleted_at is not null;
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

-- CREATE OR REPLACE preserves existing grants; re-stated to be explicit
-- (matches the original definition, 20260511000900).
revoke execute on function pdm.add_and_lock(uuid, uuid, text, text, bigint, text) from public;
grant   execute on function pdm.add_and_lock(uuid, uuid, text, text, bigint, text) to authenticated;
