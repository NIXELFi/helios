-- Bug fix: pdm.check_in() (defined in 20260507000500 + redefined in
-- 20260507000900) used `max(id)` where versions.id is a uuid. Postgres has no
-- max() aggregate for uuid, so any check-in attempt fails with:
--   function max(uuid) does not exist (SQLSTATE 42883)
--
-- Fix: split the parent_version_id lookup into a separate ORDER BY ... LIMIT 1.

create or replace function pdm.check_in(
  p_file_id uuid, p_sha256 text, p_size bigint, p_comment text
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

  select id into v_lock_id
  from pdm.locks
  where file_id = p_file_id and user_id = v_caller and released_at is null
  for update;

  if v_lock_id is null then
    raise exception 'no active lock held by caller for file %', p_file_id;
  end if;

  -- Next version number.
  select coalesce(max(version_num), 0) + 1
  into v_next_num
  from pdm.versions where file_id = p_file_id;

  -- Parent version: the current latest. Lookup by ORDER BY because
  -- max(id) is invalid for uuid.
  select id into v_parent_version
  from pdm.versions where file_id = p_file_id
  order by version_num desc
  limit 1;

  insert into pdm.versions (
    file_id, version_num, sha256, size_bytes, author_id, comment, parent_version_id
  )
  values (p_file_id, v_next_num, p_sha256, p_size, v_caller, p_comment, v_parent_version)
  returning * into v_new_version;

  update pdm.files set latest_version_id = v_new_version.id where id = p_file_id;
  update pdm.locks set released_at = now() where id = v_lock_id;

  insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
  values (
    v_caller,
    'check_in',
    'version',
    v_new_version.id,
    jsonb_build_object('file_id', p_file_id, 'version_num', v_next_num, 'sha256', p_sha256)
  );

  return v_new_version;
end;
$$;
