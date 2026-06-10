-- Restore per-vault WRITE scoping + vault-scope storage reads
-- (2026-06-09 vault audit: write-isolation regression + cross-vault content download).
--
-- 20260602010000 fixed an owner-can't-upload bug by recreating three insert
-- policies with a GLOBAL role test, silently reverting the per-vault scoping
-- 20260531000000 had introduced the day before. pdm.can_edit_in() already
-- counts 'owner', so the vault-aware helper was the right fix all along —
-- only the storage INSERT policy (which predates the owner role) ever needed
-- the role-list change.

-- 1. files / folders / locks INSERT: vault-scoped again.
drop policy if exists files_insert_editor on pdm.files;
create policy files_insert_editor on pdm.files
  for insert to authenticated
  with check (pdm.can_edit_in(vault_id));

drop policy if exists folders_insert_editor on pdm.folders;
create policy folders_insert_editor on pdm.folders
  for insert to authenticated
  with check (pdm.can_edit_in(vault_id));

-- Lock policies resolve the vault via pdm.file_vault_id() (definer, from
-- 20260610100000) — an inline subquery on pdm.files would run under the
-- caller's files RLS, where another user's draft is invisible, and wrongly
-- deny the lock.
drop policy if exists locks_insert on pdm.locks;
create policy locks_insert on pdm.locks
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and pdm.can_edit_in(pdm.file_vault_id(file_id))
  );

drop policy if exists locks_update_self_or_admin on pdm.locks;
create policy locks_update_self_or_admin on pdm.locks
  for update to authenticated
  using (user_id = (select auth.uid()) or pdm.is_admin_in(pdm.file_vault_id(file_id)))
  with check (user_id = (select auth.uid()) or pdm.is_admin_in(pdm.file_vault_id(file_id)));

-- Stamp the creator on ANY insert path (the RPCs already set it explicitly;
-- direct inserts previously left it NULL, producing a draft row invisible
-- even to its own author under the draft-aware files_read).
alter table pdm.files alter column created_by set default auth.uid();

-- 2. storage.objects SELECT: a role row somewhere no longer grants the whole
-- bucket. Content is addressed as '<sha[0:2]>/<sha>'; an object is readable
-- only if some version of a file in one of YOUR vaults references that sha.
-- The check-in existence probe moves to pdm.object_exists() below, so the
-- cross-vault duplicate-content path keeps working (a storage list() probe
-- would see nothing it can't read and the client would mis-handle the
-- resulting "Duplicate" upload race — see useCheckIn.ts / useAddLocalFile.ts).
drop policy if exists "vault-objects read for role-holders" on storage.objects;
drop policy if exists "vault-objects read for vault members" on storage.objects;
create policy "vault-objects read for vault members" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'vault-objects'
    and exists (
      select 1
      from pdm.versions v
      join pdm.files f on f.id = v.file_id
      where v.sha256 = split_part(storage.objects.name, '/', 2)
        and pdm.is_member_in(f.vault_id)
    )
  );

-- 3. storage.objects INSERT: still editor-anywhere (content-addressed uploads
-- happen BEFORE the file/version row exists, so there is no vault to scope
-- by), but now only keys of the canonical content-addressed shape — clients
-- can no longer park arbitrary paths in the bucket.
drop policy if exists "vault-objects insert for editors" on storage.objects;
create policy "vault-objects insert for editors" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'vault-objects'
    and exists (
      select 1 from pdm.user_roles
      where user_id = (select auth.uid()) and role in ('owner', 'admin', 'editor')
    )
    and name ~ '^[0-9a-f]{2}/[0-9a-f]{64}$'
    and split_part(name, '/', 1) = left(split_part(name, '/', 2), 2)
  );

-- 4. Existence probe for content-addressed dedup (replaces the client-side
-- storage list() probe). Knowing a content sha256 implies possessing the
-- content, so existence-by-sha discloses nothing new to the caller.
create or replace function pdm.object_exists(p_sha text)
returns boolean language sql stable security definer set search_path = pdm, storage, public as $$
  select exists (
    select 1 from storage.objects
    where bucket_id = 'vault-objects'
      and name = left(p_sha, 2) || '/' || p_sha
  );
$$;
revoke all on function pdm.object_exists(text) from public, anon;
grant execute on function pdm.object_exists(text) to authenticated;

create or replace function pdm.pdm_object_exists(p_sha text)
returns boolean language sql stable security definer set search_path = pdm, storage, public
as $$ select pdm.object_exists(p_sha); $$;
revoke all on function pdm.pdm_object_exists(text) from public, anon;
grant execute on function pdm.pdm_object_exists(text) to authenticated;

-- 5. delete_file: revalidate the role at call time. A lock acquired while the
-- caller was an editor must not keep authorizing deletes after the role was
-- revoked (locks survive revocation; only admins release others' locks).
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
  if not ((exists (select 1 from pdm.locks where file_id = p_file_id and user_id = v_caller and released_at is null)
           and pdm.can_edit_in(v_vault))
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
