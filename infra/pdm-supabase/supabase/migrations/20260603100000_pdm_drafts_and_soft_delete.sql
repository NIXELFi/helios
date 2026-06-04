-- Vault private-draft visibility + soft-delete (recycle bin) for pdm.files.
--
-- Two linked changes that shipped together with the desktop recycle bin:
--
--   1. Private drafts. A newly added/created file is owned by its creator
--      (created_by) and stays invisible to everyone else until its FIRST
--      check-in, which stamps published_at. files_read RLS therefore widens
--      from "any authenticated member" to "published OR mine". add_and_lock
--      leaves published_at null (draft); check_in sets it once (coalesce keeps
--      the original publish time on later versions).
--
--   2. Soft delete. delete_file / restore_file stamp deleted_at + deleted_by
--      instead of hard-DELETEing (the row + every version survive). Deleted
--      files drop out of the normal browse list and surface in the "Deleted"
--      recycle tab. Delete = the current lock holder or a vault admin; restore
--      = the deleter or an admin. The pdm_delete_file / pdm_restore_file
--      wrappers are the PostgREST-callable RPC names the desktop client invokes
--      (client.rpc("pdm_delete_file" / "pdm_restore_file")).
--
-- Applied to dlmyixonuyckxkknolku via the Management API; this file keeps the
-- repo / a from-scratch rebuild in sync. NOTE: the published_at backfill below
-- is a ONE-TIME op — do not re-run it against a live DB, where it would publish
-- in-progress drafts. On a fresh rebuild there are no files yet, so it no-ops.

-- 1. Columns ----------------------------------------------------------------
alter table pdm.files
  add column if not exists created_by   uuid,
  add column if not exists published_at timestamptz,
  add column if not exists deleted_at   timestamptz,
  add column if not exists deleted_by   uuid;

-- One-time: every file that predates the draft concept is already public.
update pdm.files set published_at = created_at where published_at is null;

-- 2. files_read RLS ---------------------------------------------------------
-- Published files are readable by any member; an unpublished draft is visible
-- only to its creator.
drop policy if exists files_read on pdm.files;
create policy files_read on pdm.files
  for select to authenticated
  using (published_at is not null or created_by = auth.uid());

-- 3. add_and_lock: stamp created_by, leave published_at null (private draft).
CREATE OR REPLACE FUNCTION pdm.add_and_lock(p_vault_id uuid, p_folder_id uuid, p_name text, p_sha256 text, p_size bigint, p_comment text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pdm', 'public'
AS $function$
declare
  v_caller uuid := auth.uid();
  v_existing_file_id uuid; v_existing_sha text; v_existing_version_id uuid; v_existing_lock_id uuid;
  v_file_id uuid; v_version_id uuid; v_lock_id uuid;
begin
  if v_caller is null then raise exception 'authentication required'; end if;
  if not pdm.can_edit_in(p_vault_id) then raise exception 'editor or admin role required to add files'; end if;
  select f.id, v.sha256, f.latest_version_id
    into v_existing_file_id, v_existing_sha, v_existing_version_id
    from pdm.files f left join pdm.versions v on v.id = f.latest_version_id
    where f.vault_id = p_vault_id and f.folder_id is not distinct from p_folder_id and f.name = p_name;
  if v_existing_file_id is not null then
    if v_existing_sha = p_sha256 then
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

-- 4. check_in: publish on first check-in (coalesce keeps the original time).
CREATE OR REPLACE FUNCTION pdm.check_in(p_file_id uuid, p_sha256 text, p_size bigint, p_comment text)
 RETURNS pdm.versions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pdm', 'public'
AS $function$
declare
  v_lock_id uuid;
  v_caller uuid := auth.uid();
  v_next_num int;
  v_parent_version uuid;
  v_new_version pdm.versions;
begin
  if v_caller is null then raise exception 'authentication required'; end if;
  select id into v_lock_id from pdm.locks
    where file_id = p_file_id and user_id = v_caller and released_at is null for update;
  if v_lock_id is null then raise exception 'no active lock held by caller for file %', p_file_id; end if;
  select coalesce(max(version_num), 0) + 1 into v_next_num from pdm.versions where file_id = p_file_id;
  select id into v_parent_version from pdm.versions where file_id = p_file_id order by version_num desc limit 1;
  insert into pdm.versions (file_id, version_num, sha256, size_bytes, author_id, comment, parent_version_id)
    values (p_file_id, v_next_num, p_sha256, p_size, v_caller, p_comment, v_parent_version)
    returning * into v_new_version;
  -- NEW: publish on first check-in (coalesce keeps the original publish time).
  update pdm.files
     set latest_version_id = v_new_version.id, published_at = coalesce(published_at, now())
   where id = p_file_id;
  update pdm.locks set released_at = now() where id = v_lock_id;
  insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
    values (v_caller, 'check_in', 'version', v_new_version.id,
      jsonb_build_object('file_id', p_file_id, 'version_num', v_next_num, 'sha256', p_sha256));
  return v_new_version;
end; $function$;

-- 5. Soft delete / restore (logic) + PostgREST-callable wrapper RPCs.
CREATE OR REPLACE FUNCTION pdm.delete_file(p_file_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pdm', 'public'
AS $function$
declare v_caller uuid := auth.uid(); v_vault uuid;
begin
  if v_caller is null then raise exception 'authentication required'; end if;
  select vault_id into v_vault from pdm.files where id = p_file_id;
  if v_vault is null then raise exception 'file not found'; end if;
  if not (exists (select 1 from pdm.locks where file_id = p_file_id and user_id = v_caller and released_at is null)
          or pdm.is_admin_in(v_vault)) then
    raise exception 'check the file out (or be an admin) to delete it';
  end if;
  update pdm.files set deleted_at = now(), deleted_by = v_caller where id = p_file_id and deleted_at is null;
  update pdm.locks set released_at = now() where file_id = p_file_id and released_at is null;
  begin
    insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
      values (v_caller, 'delete', 'file', p_file_id, jsonb_build_object('soft', true));
  exception when others then null; end;
end; $function$;

CREATE OR REPLACE FUNCTION pdm.restore_file(p_file_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pdm', 'public'
AS $function$
declare v_caller uuid := auth.uid(); v_vault uuid; v_deleter uuid;
begin
  if v_caller is null then raise exception 'authentication required'; end if;
  select vault_id, deleted_by into v_vault, v_deleter from pdm.files where id = p_file_id;
  if v_vault is null then raise exception 'file not found'; end if;
  if not (v_deleter is not distinct from v_caller or pdm.is_admin_in(v_vault)) then
    raise exception 'only the person who deleted it (or an admin) can restore it';
  end if;
  update pdm.files set deleted_at = null, deleted_by = null where id = p_file_id;
  begin
    insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
      values (v_caller, 'restore', 'file', p_file_id, jsonb_build_object('restored', true));
  exception when others then null; end;
end; $function$;

CREATE OR REPLACE FUNCTION pdm.pdm_delete_file(p_file_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pdm', 'public'
AS $function$ select pdm.delete_file(p_file_id); $function$;

CREATE OR REPLACE FUNCTION pdm.pdm_restore_file(p_file_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pdm', 'public'
AS $function$ select pdm.restore_file(p_file_id); $function$;

-- 6. Grants: revoke the implicit PUBLIC execute, grant authenticated, matching
--    the repo's existing locked-down RPC posture.
revoke all on function pdm.delete_file(uuid)       from public;
revoke all on function pdm.restore_file(uuid)      from public;
revoke all on function pdm.pdm_delete_file(uuid)   from public;
revoke all on function pdm.pdm_restore_file(uuid)  from public;
grant execute on function pdm.delete_file(uuid)      to authenticated;
grant execute on function pdm.restore_file(uuid)     to authenticated;
grant execute on function pdm.pdm_delete_file(uuid)  to authenticated;
grant execute on function pdm.pdm_restore_file(uuid) to authenticated;
