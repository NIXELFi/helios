-- Adds the data-import path used by external tooling (glassyPDM -> Helios
-- and future migrations). Three additions:
--
-- 1. pdm.versions.import_metadata jsonb column for full source provenance
--    (origin server / project / path / commit / author / timestamp). Indexed
--    via jsonb_path_ops for "find all versions from source X" queries.
--
-- 2. pdm.import_version() — a SECURITY DEFINER RPC that is the sibling of
--    pdm.add_and_lock(): same file+version creation, but
--      - no lock acquired (importer is a system actor, not a user)
--      - author_id is always NULL (no Supabase user maps to a Clerk user)
--      - accepts an explicit p_created_at to preserve original commit time
--      - writes p_import_metadata into the new column
--      - idempotent on (vault_id, folder_id, name, sha256) — safe to re-run
--    The public proxy is restricted to the service_role JWT only. Authenticated
--    users (even global admins) cannot call this RPC — it's a one-way door
--    intended specifically for bulk data migrations.
--
-- 3. pg_proc execute grant cleanup so the RPC is invokable only by service_role.

alter table pdm.versions add column if not exists import_metadata jsonb;
create index if not exists versions_import_metadata_idx
  on pdm.versions using gin (import_metadata jsonb_path_ops);

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
begin
  if v_role is null or v_role <> 'service_role' then
    raise exception 'service_role required to call pdm.import_version (got role=%)', coalesce(v_role, '<none>');
  end if;

  -- Idempotency probe: same (vault_id, folder_id, name)?
  select id into v_file_id
  from pdm.files
  where vault_id = p_vault_id
    and folder_id is not distinct from p_folder_id
    and name = p_name;

  if v_file_id is not null then
    -- File exists. If a version with this sha already exists, no-op.
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
        'created', false
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
    'created', true
  );
end;
$func$;

create or replace function public.pdm_import_version(
  p_vault_id uuid,
  p_folder_id uuid,
  p_name text,
  p_sha256 text,
  p_size bigint,
  p_comment text,
  p_created_at timestamptz,
  p_import_metadata jsonb
) returns jsonb
language sql
security definer
set search_path = pdm, public
as $func$
  select pdm.import_version(
    p_vault_id, p_folder_id, p_name, p_sha256, p_size,
    p_comment, p_created_at, p_import_metadata
  );
$func$;

revoke execute on function public.pdm_import_version(uuid, uuid, text, text, bigint, text, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function public.pdm_import_version(uuid, uuid, text, text, bigint, text, timestamptz, jsonb)
  to service_role;
