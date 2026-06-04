-- check_in: don't bump version history when nothing changed.
--
-- Applied to dlmyixonuyckxkknolku via the Management API; this file keeps the
-- repo / a from-scratch rebuild in sync.
--
-- Background: a check-in always created a new pdm.versions row, so a user who
-- checked a file out and checked it back in without editing left a duplicate
-- version behind. Now check_in compares the incoming sha256 to the current
-- latest version: if they're identical it just releases the lock (and publishes
-- a draft on its first check-in) WITHOUT creating a version. A real content
-- change still creates the next version exactly as before. Pairs with the
-- add-in's "Cancel Check-Out" button for the no-edits-made path.
create or replace function pdm.check_in(p_file_id uuid, p_sha256 text, p_size bigint, p_comment text)
 returns pdm.versions
 language plpgsql
 security definer
 set search_path to 'pdm', 'public'
as $function$
declare
  v_lock_id uuid;
  v_caller uuid := auth.uid();
  v_next_num int;
  v_latest_id uuid;
  v_latest_sha text;
  v_new_version pdm.versions;
begin
  if v_caller is null then raise exception 'authentication required'; end if;

  select id into v_lock_id from pdm.locks
    where file_id = p_file_id and user_id = v_caller and released_at is null for update;
  if v_lock_id is null then raise exception 'no active lock held by caller for file %', p_file_id; end if;

  -- Current latest version + its content hash.
  select id, sha256 into v_latest_id, v_latest_sha
    from pdm.versions where file_id = p_file_id order by version_num desc limit 1;

  -- No content change -> release the lock, DON'T bump version history. Still
  -- publish a draft on its first check-in. Return the existing latest version.
  if v_latest_sha is not null and lower(v_latest_sha) = lower(p_sha256) then
    update pdm.files set published_at = coalesce(published_at, now()) where id = p_file_id;
    update pdm.locks set released_at = now() where id = v_lock_id;
    insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
      values (v_caller, 'check_in', 'version', v_latest_id,
        jsonb_build_object('file_id', p_file_id, 'unchanged', true));
    select * into v_new_version from pdm.versions where id = v_latest_id;
    return v_new_version;
  end if;

  -- Content changed -> new version (parent = the previous latest).
  select coalesce(max(version_num), 0) + 1 into v_next_num from pdm.versions where file_id = p_file_id;
  insert into pdm.versions (file_id, version_num, sha256, size_bytes, author_id, comment, parent_version_id)
    values (p_file_id, v_next_num, p_sha256, p_size, v_caller, p_comment, v_latest_id)
    returning * into v_new_version;
  update pdm.files
     set latest_version_id = v_new_version.id, published_at = coalesce(published_at, now())
   where id = p_file_id;
  update pdm.locks set released_at = now() where id = v_lock_id;
  insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
    values (v_caller, 'check_in', 'version', v_new_version.id,
      jsonb_build_object('file_id', p_file_id, 'version_num', v_next_num, 'sha256', p_sha256));
  return v_new_version;
end; $function$;
