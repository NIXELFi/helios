-- Two server-side guards for check-in / check-out (Helios 6.4.1 follow-up).
--
-- 1. pdm.check_in gains an OPTIONAL p_base_sha256: the sha of the version the
--    caller's local copy was based on (the client's sync ledger entry). When
--    given, and the vault's latest version is neither that base nor the bytes
--    being checked in, someone checked in a newer version after this copy was
--    taken, so uploading it would silently replace their work. Refuse instead.
--    NULL (every pre-6.4.2 client) keeps today's behaviour exactly.
--
-- 2. Soft-deleted files (deleted_at set, i.e. in the recycle bin) can no longer
--    be checked out (locks INSERT policy) or checked in. A stale file list
--    could otherwise lock or version a file that is in the bin. Existing locks
--    are untouched; restore the file first to work on it again.
--
-- Signature change: the 4-arg functions are dropped and recreated with a 5th
-- defaulted arg. Keeping both overloads would make PostgREST's named-arg call
-- (p_file_id, p_sha256, p_size, p_comment) ambiguous. Drop + create run in one
-- transaction, so there is no window without a check_in.

-- ---------------------------------------------------------------------------
-- 1 + 2a. check_in
-- ---------------------------------------------------------------------------

drop function if exists public.pdm_check_in(uuid, text, bigint, text);
drop function if exists pdm.pdm_check_in(uuid, text, bigint, text);
drop function if exists pdm.check_in(uuid, text, bigint, text);

create function pdm.check_in(
  p_file_id uuid,
  p_sha256 text,
  p_size bigint,
  p_comment text,
  p_base_sha256 text default null
)
 returns pdm.versions
 language plpgsql
 security definer
 set search_path to 'pdm', 'public'
as $function$
declare
  v_lock_id uuid;
  v_caller uuid := auth.uid();
  v_vault uuid;
  v_deleted_at timestamptz;
  v_next_num int;
  v_latest_id uuid;
  v_latest_num int;
  v_latest_sha text;
  v_new_version pdm.versions;
begin
  if v_caller is null then raise exception 'authentication required'; end if;

  -- Re-validate the caller's editor role in the file's vault at call time
  -- (a held lock must not keep authorizing check-ins after a role was revoked).
  select vault_id, deleted_at into v_vault, v_deleted_at from pdm.files where id = p_file_id;
  if v_vault is null then raise exception 'file not found'; end if;
  if not pdm.can_edit_in(v_vault) then
    raise exception 'editor role required to check in';
  end if;
  if v_deleted_at is not null then
    raise exception 'This file is in the Deleted list. Restore it before checking it in.';
  end if;

  select id into v_lock_id from pdm.locks
    where file_id = p_file_id and user_id = v_caller and released_at is null for update;
  if v_lock_id is null then raise exception 'no active lock held by caller for file %', p_file_id; end if;

  -- Current latest version + its content hash.
  select id, version_num, sha256 into v_latest_id, v_latest_num, v_latest_sha
    from pdm.versions where file_id = p_file_id order by version_num desc limit 1;

  -- Base guard (opt-in): the caller's copy was made from p_base_sha256, but a
  -- different version is now latest and it isn't what's being uploaded either.
  -- Nothing is written and the lock is kept, so the caller can get the latest
  -- and redo the change.
  if p_base_sha256 is not null and v_latest_sha is not null
     and lower(v_latest_sha) <> lower(p_base_sha256)
     and lower(v_latest_sha) <> lower(p_sha256) then
    raise exception 'A newer version (v%) was checked in after your copy was made, so checking it in would replace that work. Get the latest, redo your change, then check in.', v_latest_num;
  end if;

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

-- Client-facing aliases (clients use db.schema='pdm', older ones public).
create function pdm.pdm_check_in(
  p_file_id uuid, p_sha256 text, p_size bigint, p_comment text, p_base_sha256 text default null
)
 returns pdm.versions
 language sql
 security definer
 set search_path to 'pdm', 'public'
as $function$ select pdm.check_in(p_file_id, p_sha256, p_size, p_comment, p_base_sha256); $function$;

create function public.pdm_check_in(
  p_file_id uuid, p_sha256 text, p_size bigint, p_comment text, p_base_sha256 text default null
)
 returns pdm.versions
 language sql
 security definer
 set search_path to 'pdm', 'public'
as $function$ select pdm.check_in(p_file_id, p_sha256, p_size, p_comment, p_base_sha256); $function$;

-- Same grants as the functions they replace: authenticated + service_role
-- only (anon and PUBLIC were revoked vault-wide in 20260610000000).
revoke all on function pdm.check_in(uuid, text, bigint, text, text) from public, anon;
revoke all on function pdm.pdm_check_in(uuid, text, bigint, text, text) from public, anon;
revoke all on function public.pdm_check_in(uuid, text, bigint, text, text) from public, anon;
grant execute on function pdm.check_in(uuid, text, bigint, text, text) to authenticated, service_role;
grant execute on function pdm.pdm_check_in(uuid, text, bigint, text, text) to authenticated, service_role;
grant execute on function public.pdm_check_in(uuid, text, bigint, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2b. No new checkouts on soft-deleted files
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER for the same reason as pdm.file_vault_id: the policy runs as
-- the caller, and files RLS would otherwise decide what the check can see.
create or replace function pdm.file_is_live(p_file_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'pdm', 'public'
as $function$
  select exists (select 1 from pdm.files where id = p_file_id and deleted_at is null);
$function$;
revoke all on function pdm.file_is_live(uuid) from public, anon;
grant execute on function pdm.file_is_live(uuid) to authenticated, service_role;

drop policy if exists locks_insert on pdm.locks;
create policy locks_insert on pdm.locks
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and pdm.can_edit_in(pdm.file_vault_id(file_id))
    and pdm.file_is_live(file_id)
  );

notify pgrst, 'reload schema';
