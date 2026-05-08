create or replace function pdm.check_in(
  p_file_id uuid,
  p_sha256 text,
  p_size bigint,
  p_comment text
) returns pdm.versions
language plpgsql
security definer
set search_path = pdm, public
as $$
declare
  v_lock_id uuid;
  v_caller uuid := auth.uid();
  v_next_num int;
  v_parent_version uuid;
  v_new_version pdm.versions;
begin
  if v_caller is null then
    raise exception 'authentication required';
  end if;

  -- Verify caller holds the active lock and capture lock id.
  select id into v_lock_id
  from pdm.locks
  where file_id = p_file_id
    and user_id = v_caller
    and released_at is null
  for update;

  if v_lock_id is null then
    raise exception 'no active lock held by caller for file %', p_file_id;
  end if;

  -- Determine next version number and parent version.
  select coalesce(max(version_num), 0) + 1, max(id)
  into v_next_num, v_parent_version
  from pdm.versions
  where file_id = p_file_id;

  -- Insert the new version.
  insert into pdm.versions (
    file_id, version_num, sha256, size_bytes, author_id, comment, parent_version_id
  )
  values (
    p_file_id, v_next_num, p_sha256, p_size, v_caller, p_comment, v_parent_version
  )
  returning * into v_new_version;

  -- Update files.latest_version_id.
  update pdm.files set latest_version_id = v_new_version.id where id = p_file_id;

  -- Release the lock.
  update pdm.locks set released_at = now() where id = v_lock_id;

  return v_new_version;
end;
$$;

-- Public proxy so PostgREST exposes it as pdm_check_in.
create or replace function public.pdm_check_in(
  p_file_id uuid, p_sha256 text, p_size bigint, p_comment text
) returns pdm.versions
language sql security definer set search_path = pdm, public
as $$ select pdm.check_in(p_file_id, p_sha256, p_size, p_comment); $$;

grant execute on function public.pdm_check_in(uuid, text, bigint, text) to authenticated;
