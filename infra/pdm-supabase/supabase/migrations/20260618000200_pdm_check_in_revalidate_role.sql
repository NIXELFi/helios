-- v4.4.6 fix: check_in / cancel_checkout authorize only on lock ownership, not
-- the caller's CURRENT vault editor role.
--
-- delete_file (20260610110000) and set_revision (20260531000000) already
-- re-check pdm.can_edit_in() at call time, so a lock acquired while the caller
-- was an editor can't keep authorizing writes after the role was revoked. Locks
-- survive role revocation, so check_in/cancel_checkout had a privilege-retention
-- gap. Add the same can_edit_in re-check (resolving the file's vault) while
-- keeping the lock-ownership check intact.
--
-- This recreates the current check_in body (the skip-unchanged version from
-- 20260603140000) verbatim plus the role re-check. Idempotent.

create or replace function pdm.check_in(p_file_id uuid, p_sha256 text, p_size bigint, p_comment text)
 returns pdm.versions
 language plpgsql
 security definer
 set search_path to 'pdm', 'public'
as $function$
declare
  v_lock_id uuid;
  v_caller uuid := auth.uid();
  v_vault uuid;
  v_next_num int;
  v_latest_id uuid;
  v_latest_sha text;
  v_new_version pdm.versions;
begin
  if v_caller is null then raise exception 'authentication required'; end if;

  -- Re-validate the caller's editor role in the file's vault at call time
  -- (a held lock must not keep authorizing check-ins after a role was revoked).
  select vault_id into v_vault from pdm.files where id = p_file_id;
  if v_vault is null then raise exception 'file not found'; end if;
  if not pdm.can_edit_in(v_vault) then
    raise exception 'editor role required to check in';
  end if;

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

-- cancel_checkout: same re-check. Releasing your own lock is harmless on its
-- own, but a revoked editor cancelling a checkout they no longer should manage
-- is consistent with the check_in/delete_file posture. The lock-ownership check
-- stays as the primary gate.
create or replace function pdm.cancel_checkout(p_file_id uuid)
returns void
language plpgsql
security definer
set search_path = pdm, public
as $$
declare
  v_caller uuid := auth.uid();
  v_vault uuid;
begin
  if v_caller is null then
    raise exception 'authentication required';
  end if;

  select vault_id into v_vault from pdm.files where id = p_file_id;
  if v_vault is null then raise exception 'file not found'; end if;
  if not pdm.can_edit_in(v_vault) then
    raise exception 'editor role required to cancel a checkout';
  end if;

  update pdm.locks
  set released_at = now()
  where file_id = p_file_id
    and user_id = v_caller
    and released_at is null;

  if not found then
    raise exception 'no active lock held by caller for file %', p_file_id;
  end if;
end;
$$;
