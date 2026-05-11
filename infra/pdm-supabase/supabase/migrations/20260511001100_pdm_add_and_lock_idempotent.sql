-- Make pdm.add_and_lock idempotent on (folder_id, name, sha256) collisions.
--
-- After deploying the original RPC (20260511000900) live, the Postgres logs
-- showed ~14 `duplicate key value violates unique constraint
-- "files_folder_id_name_key"` errors over a short window — the user's
-- auto-sync sweep re-included files that were already in the vault, and each
-- attempted re-add tripped the unique constraint and rolled back the whole
-- RPC. Semantically the constraint was doing its job (it kept the DB clean),
-- but the UX was noisy and uninformative.
--
-- New behavior:
--   * Same (folder_id, name) AND same sha256 → idempotent no-op. We return
--     the existing file/version/lock info and try to acquire a lock for the
--     caller if they don't already hold one. A unique_violation on the lock
--     insert means someone else holds it; we return lock_id = null.
--   * Same (folder_id, name) AND different sha256 → clear error pointing the
--     caller at the check-in flow (which is the correct path for "I have new
--     bytes for an existing file").
--   * No collision → original create path: insert files + versions + locks
--     + audit row.
--
-- Return shape gains a `created` boolean so clients can distinguish first-add
-- from idempotent-replay.

create or replace function pdm.add_and_lock(
  p_vault_id uuid,
  p_folder_id uuid,
  p_name text,
  p_sha256 text,
  p_size bigint,
  p_comment text
) returns jsonb
language plpgsql
security definer
set search_path = pdm, public
as $$
declare
  v_caller uuid := auth.uid();
  v_existing_file_id uuid;
  v_existing_sha text;
  v_existing_version_id uuid;
  v_existing_lock_id uuid;
  v_file_id uuid;
  v_version_id uuid;
  v_lock_id uuid;
begin
  if v_caller is null then
    raise exception 'authentication required';
  end if;

  if not (
    pdm.is_admin() or exists (
      select 1 from pdm.user_roles
      where user_id = v_caller and role in ('admin', 'editor')
    )
  ) then
    raise exception 'editor or admin role required to add files';
  end if;

  -- Idempotency probe. `is not distinct from` handles NULL folder_id
  -- (top-level files) correctly — the unique index uses the same semantics.
  select f.id, v.sha256, f.latest_version_id
    into v_existing_file_id, v_existing_sha, v_existing_version_id
    from pdm.files f
    left join pdm.versions v on v.id = f.latest_version_id
    where f.vault_id = p_vault_id
      and f.folder_id is not distinct from p_folder_id
      and f.name = p_name;

  if v_existing_file_id is not null then
    if v_existing_sha = p_sha256 then
      -- Same content already exists. Try to make sure the caller holds the
      -- lock; if it's held by someone else, return lock_id=null without
      -- failing. This makes auto-sync re-sweeps a no-op.
      select id into v_existing_lock_id
        from pdm.locks
        where file_id = v_existing_file_id
          and user_id = v_caller
          and released_at is null;
      if v_existing_lock_id is null then
        begin
          insert into pdm.locks (file_id, user_id)
            values (v_existing_file_id, v_caller)
            returning id into v_existing_lock_id;
        exception
          when unique_violation then
            v_existing_lock_id := null; -- another user holds it
        end;
      end if;
      return jsonb_build_object(
        'file_id', v_existing_file_id,
        'version_id', v_existing_version_id,
        'lock_id', v_existing_lock_id,
        'created', false
      );
    else
      raise exception
        'file "%" already exists in this folder with different content. Use the check-in flow to add a new version.',
        p_name;
    end if;
  end if;

  -- No collision: original create path.
  insert into pdm.files (vault_id, folder_id, name)
  values (p_vault_id, p_folder_id, p_name)
  returning id into v_file_id;

  insert into pdm.versions (
    file_id, version_num, sha256, size_bytes, author_id, comment, parent_version_id
  )
  values (
    v_file_id, 1, p_sha256, p_size, v_caller, p_comment, null
  )
  returning id into v_version_id;

  update pdm.files set latest_version_id = v_version_id where id = v_file_id;

  insert into pdm.locks (file_id, user_id)
  values (v_file_id, v_caller)
  returning id into v_lock_id;

  insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
  values (
    v_caller,
    'check_in',
    'version',
    v_version_id,
    jsonb_build_object(
      'file_id', v_file_id,
      'version_num', 1,
      'sha256', p_sha256,
      'via', 'add_and_lock'
    )
  );

  return jsonb_build_object(
    'file_id', v_file_id,
    'version_id', v_version_id,
    'lock_id', v_lock_id,
    'created', true
  );
end;
$$;
