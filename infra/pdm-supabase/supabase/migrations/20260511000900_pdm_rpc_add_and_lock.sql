-- Ultrareview 2026-05-11, finding H13: useAddLocalFile.ts had a non-atomic
-- 3-step lock/check_in/re-lock dance. If the re-acquire after check_in lost a
-- race the file ended up added-but-unlocked while the UI surfaced a misleading
-- "re-acquire lock: …" failure.
--
-- Replace the dance with a single SECURITY DEFINER RPC that, in one
-- transaction, (1) creates the pdm.files row, (2) inserts version 1, (3) sets
-- files.latest_version_id, and (4) acquires a lock for the caller. Any error
-- rolls back the whole thing.

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
  v_file_id uuid;
  v_version_id uuid;
  v_lock_id uuid;
begin
  if v_caller is null then
    raise exception 'authentication required';
  end if;

  -- Editor or admin required (mirrors files_insert_editor RLS policy from
  -- 20260508000400). We must check explicitly because SECURITY DEFINER bypasses
  -- RLS — without this an authenticated viewer could create files.
  if not (
    pdm.is_admin() or exists (
      select 1 from pdm.user_roles
      where user_id = v_caller and role in ('admin', 'editor')
    )
  ) then
    raise exception 'editor or admin role required to add files';
  end if;

  -- 1. Create the file row.
  insert into pdm.files (vault_id, folder_id, name)
  values (p_vault_id, p_folder_id, p_name)
  returning id into v_file_id;

  -- 2. Insert version 1 (no parent — this is the first version).
  insert into pdm.versions (
    file_id, version_num, sha256, size_bytes, author_id, comment, parent_version_id
  )
  values (
    v_file_id, 1, p_sha256, p_size, v_caller, p_comment, null
  )
  returning id into v_version_id;

  -- 3. Point files.latest_version_id at the new version.
  update pdm.files set latest_version_id = v_version_id where id = v_file_id;

  -- 4. Acquire a lock for the caller — file lands in "checked out by me"
  -- state, matching the previous dance's intent.
  insert into pdm.locks (file_id, user_id)
  values (v_file_id, v_caller)
  returning id into v_lock_id;

  -- Audit: mirror the pattern in 20260507000900 / pdm.check_in. The locks
  -- INSERT trigger (trg_locks_audit) already emits a 'check_out' row, so we
  -- only need to log the 'check_in' for the new version here.
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
    'lock_id', v_lock_id
  );
end;
$$;

-- Public proxy so PostgREST exposes it as pdm_add_and_lock at /rest/v1/rpc.
create or replace function public.pdm_add_and_lock(
  p_vault_id uuid,
  p_folder_id uuid,
  p_name text,
  p_sha256 text,
  p_size bigint,
  p_comment text
) returns jsonb
language sql
security definer
set search_path = pdm, public
as $$
  select pdm.add_and_lock(p_vault_id, p_folder_id, p_name, p_sha256, p_size, p_comment);
$$;

-- pdm-schema alias, matching 20260508000000 — clients with db.schema='pdm'
-- (our integration tests) look up RPCs in the pdm schema first.
create or replace function pdm.pdm_add_and_lock(
  p_vault_id uuid,
  p_folder_id uuid,
  p_name text,
  p_sha256 text,
  p_size bigint,
  p_comment text
) returns jsonb
language sql
security definer
set search_path = pdm, public
as $$
  select pdm.add_and_lock(p_vault_id, p_folder_id, p_name, p_sha256, p_size, p_comment);
$$;

-- Lock down EXECUTE — matches the 20260511000600 pattern: revoke from PUBLIC
-- (closes anon), grant to authenticated.
revoke execute on function pdm.add_and_lock(uuid, uuid, text, text, bigint, text) from public;
grant   execute on function pdm.add_and_lock(uuid, uuid, text, text, bigint, text) to authenticated;

revoke execute on function pdm.pdm_add_and_lock(uuid, uuid, text, text, bigint, text) from public;
grant   execute on function pdm.pdm_add_and_lock(uuid, uuid, text, text, bigint, text) to authenticated;

revoke execute on function public.pdm_add_and_lock(uuid, uuid, text, text, bigint, text) from public;
grant   execute on function public.pdm_add_and_lock(uuid, uuid, text, text, bigint, text) to authenticated;
