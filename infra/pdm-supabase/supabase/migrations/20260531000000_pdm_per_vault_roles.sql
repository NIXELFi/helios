-- Per-vault roles (additive, NULL = global).
--
-- pdm.user_roles gains a nullable vault_id. A row with vault_id IS NULL is a
-- GLOBAL role (applies to every vault) — preserving prior behavior and the
-- bootstrap 'owner'. A row with vault_id set grants that role only in that
-- vault. Existing grants are global, so prior behavior is unchanged; the
-- data-table RLS switches to vault-aware helpers that treat a global row as
-- authoritative everywhere.

-- ---------------------------------------------------------------------------
-- 1. Schema: vault_id + (user_id, vault_id) uniqueness (NULL = one global slot).
-- ---------------------------------------------------------------------------
alter table pdm.user_roles add column if not exists vault_id uuid references pdm.vaults(id) on delete cascade;
alter table pdm.user_roles drop constraint if exists user_roles_pkey;
create unique index if not exists user_roles_user_vault_uniq
  on pdm.user_roles (user_id, coalesce(vault_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ---------------------------------------------------------------------------
-- 2. Vault-aware helpers. is_admin() (no-arg, global) is intentionally LEFT
--    INTACT — RLS policies + force_unlock/subteams/admin_list_users depend on
--    it. These are additive.
-- ---------------------------------------------------------------------------
create or replace function pdm.is_admin_in(p_vault_id uuid)
returns boolean language sql stable security definer set search_path = pdm, public as $$
  select exists (
    select 1 from pdm.user_roles
    where user_id = auth.uid()
      and role in ('owner', 'admin')
      and (vault_id is null or vault_id = p_vault_id)
  );
$$;
create or replace function pdm.can_edit_in(p_vault_id uuid)
returns boolean language sql stable security definer set search_path = pdm, public as $$
  select exists (
    select 1 from pdm.user_roles
    where user_id = auth.uid()
      and role in ('owner', 'admin', 'editor')
      and (vault_id is null or vault_id = p_vault_id)
  );
$$;
grant execute on function pdm.is_admin_in(uuid) to authenticated;
grant execute on function pdm.can_edit_in(uuid) to authenticated;
-- pdm-schema + public proxies so the client can check its own vault role.
create or replace function pdm.pdm_is_admin_in(p_vault_id uuid) returns boolean
language sql stable security definer set search_path = pdm, public
as $$ select pdm.is_admin_in(p_vault_id); $$;
create or replace function pdm.pdm_can_edit_in(p_vault_id uuid) returns boolean
language sql stable security definer set search_path = pdm, public
as $$ select pdm.can_edit_in(p_vault_id); $$;
grant execute on function pdm.pdm_is_admin_in(uuid), pdm.pdm_can_edit_in(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Repoint data-table RLS to the vault-aware helpers (reference the row's vault).
-- ---------------------------------------------------------------------------
-- Folders
drop policy if exists folders_insert_editor on pdm.folders;
drop policy if exists folders_update_admin on pdm.folders;
drop policy if exists folders_delete_admin on pdm.folders;
create policy folders_insert_editor on pdm.folders
  for insert to authenticated with check (pdm.can_edit_in(vault_id));
create policy folders_update_admin on pdm.folders
  for update to authenticated using (pdm.is_admin_in(vault_id)) with check (pdm.is_admin_in(vault_id));
create policy folders_delete_admin on pdm.folders
  for delete to authenticated using (pdm.is_admin_in(vault_id));

-- Files
drop policy if exists files_insert_editor on pdm.files;
drop policy if exists files_update_admin on pdm.files;
drop policy if exists files_delete_admin on pdm.files;
create policy files_insert_editor on pdm.files
  for insert to authenticated with check (pdm.can_edit_in(vault_id));
create policy files_update_admin on pdm.files
  for update to authenticated using (pdm.is_admin_in(vault_id)) with check (pdm.is_admin_in(vault_id));
create policy files_delete_admin on pdm.files
  for delete to authenticated using (pdm.is_admin_in(vault_id));

-- Locks (the row carries file_id, not vault_id → resolve via the file).
drop policy if exists locks_insert on pdm.locks;
drop policy if exists locks_update_self_or_admin on pdm.locks;
create policy locks_insert on pdm.locks
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and pdm.can_edit_in((select f.vault_id from pdm.files f where f.id = file_id))
  );
create policy locks_update_self_or_admin on pdm.locks
  for update to authenticated
  using (user_id = auth.uid() or pdm.is_admin_in((select f.vault_id from pdm.files f where f.id = file_id)))
  with check (user_id = auth.uid() or pdm.is_admin_in((select f.vault_id from pdm.files f where f.id = file_id)));

-- ---------------------------------------------------------------------------
-- 4. Vault-scope the RPC role checks (re-create with the same bodies, swapping
--    the global role test for the vault-aware helper).
-- ---------------------------------------------------------------------------
create or replace function pdm.add_and_lock(
  p_vault_id uuid, p_folder_id uuid, p_name text, p_sha256 text, p_size bigint, p_comment text
) returns jsonb language plpgsql security definer set search_path = pdm, public as $$
declare
  v_caller uuid := auth.uid();
  v_existing_file_id uuid; v_existing_sha text; v_existing_version_id uuid; v_existing_lock_id uuid;
  v_file_id uuid; v_version_id uuid; v_lock_id uuid;
begin
  if v_caller is null then raise exception 'authentication required'; end if;
  if not pdm.can_edit_in(p_vault_id) then
    raise exception 'editor or admin role required to add files';
  end if;

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

  insert into pdm.files (vault_id, folder_id, name) values (p_vault_id, p_folder_id, p_name) returning id into v_file_id;
  insert into pdm.versions (file_id, version_num, sha256, size_bytes, author_id, comment, parent_version_id)
    values (v_file_id, 1, p_sha256, p_size, v_caller, p_comment, null) returning id into v_version_id;
  update pdm.files set latest_version_id = v_version_id where id = v_file_id;
  insert into pdm.locks (file_id, user_id) values (v_file_id, v_caller) returning id into v_lock_id;
  insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
    values (v_caller, 'check_in', 'version', v_version_id,
      jsonb_build_object('file_id', v_file_id, 'version_num', 1, 'sha256', p_sha256, 'via', 'add_and_lock'));
  return jsonb_build_object('file_id', v_file_id, 'version_id', v_version_id, 'lock_id', v_lock_id, 'created', true);
end; $$;

-- force_unlock: admin OF THE LOCK'S VAULT (resolve via the lock's file).
create or replace function pdm.force_unlock(p_lock_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = pdm, public as $$
declare v_caller uuid := auth.uid(); v_vault uuid;
begin
  if v_caller is null then raise exception 'authentication required'; end if;
  select f.vault_id into v_vault from pdm.locks l join pdm.files f on f.id = l.file_id where l.id = p_lock_id;
  if not pdm.is_admin_in(v_vault) then raise exception 'admin role required to force-unlock'; end if;
  if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'reason is required for force-unlock'; end if;
  update pdm.locks set released_at = now(), force_released_by = v_caller where id = p_lock_id and released_at is null;
  if not found then raise exception 'lock % not active or not found', p_lock_id; end if;
  insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
    values (v_caller, 'force_unlock', 'lock', p_lock_id, jsonb_build_object('reason', p_reason));
end; $$;

-- set_revision: editor OF THE FILE'S VAULT.
create or replace function pdm.set_revision(p_file_id uuid, p_revision int default null)
returns pdm.versions language plpgsql security definer set search_path = pdm, public as $$
declare v_caller uuid := auth.uid(); v_vault uuid; v_latest uuid; v_next int; v_result pdm.versions;
begin
  if v_caller is null then raise exception 'authentication required'; end if;
  select vault_id, latest_version_id into v_vault, v_latest from pdm.files where id = p_file_id;
  if not pdm.can_edit_in(v_vault) then raise exception 'editor role required to set revision'; end if;
  if v_latest is null then raise exception 'file % has no version to stamp a revision on', p_file_id; end if;
  if p_revision is not null then
    if p_revision <= 0 then raise exception 'revision must be a positive integer'; end if;
    v_next := p_revision;
  else
    select coalesce(max(revision), 0) + 1 into v_next from pdm.versions where file_id = p_file_id;
  end if;
  update pdm.versions set revision = v_next where id = v_latest returning * into v_result;
  insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
    values (v_caller, 'set_revision', 'version', v_latest, jsonb_build_object('file_id', p_file_id, 'revision', v_next));
  return v_result;
end; $$;

-- ---------------------------------------------------------------------------
-- 5. Role-management RPCs gain a vault dimension (p_vault_id NULL = global).
-- ---------------------------------------------------------------------------
create or replace function pdm.set_user_role(p_target uuid, p_role text, p_vault_id uuid default null)
returns void language plpgsql security definer set search_path = pdm, public as $$
declare v_caller uuid := auth.uid(); v_current text; v_zero uuid := '00000000-0000-0000-0000-000000000000';
begin
  if v_caller is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  if p_role not in ('admin', 'editor', 'viewer') then
    raise exception 'invalid or disallowed role: %', p_role using errcode = '22023';
  end if;
  if p_target = v_caller then raise exception 'cannot change your own role' using errcode = '42501'; end if;

  select role into v_current from pdm.user_roles
    where user_id = p_target and coalesce(vault_id, v_zero) = coalesce(p_vault_id, v_zero);
  if v_current = 'owner' then raise exception 'the owner role cannot be modified here' using errcode = '42501'; end if;

  if p_role = 'admin' or v_current = 'admin' then
    if not pdm.is_owner() then
      raise exception 'only the owner can grant or change the admin role' using errcode = '42501';
    end if;
  else
    if not (case when p_vault_id is null then pdm.is_admin() else pdm.is_admin_in(p_vault_id) end) then
      raise exception 'not authorized' using errcode = '42501';
    end if;
  end if;

  update pdm.user_roles set role = p_role, granted_by = v_caller, granted_at = now()
    where user_id = p_target and coalesce(vault_id, v_zero) = coalesce(p_vault_id, v_zero);
  if not found then
    insert into pdm.user_roles (user_id, vault_id, role, granted_by, granted_at)
    values (p_target, p_vault_id, p_role, v_caller, now());
  end if;
end; $$;

create or replace function pdm.revoke_user_role(p_target uuid, p_vault_id uuid default null)
returns void language plpgsql security definer set search_path = pdm, public as $$
declare v_caller uuid := auth.uid(); v_current text; v_zero uuid := '00000000-0000-0000-0000-000000000000';
begin
  if v_caller is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  if p_target = v_caller then raise exception 'cannot revoke your own role' using errcode = '42501'; end if;
  select role into v_current from pdm.user_roles
    where user_id = p_target and coalesce(vault_id, v_zero) = coalesce(p_vault_id, v_zero);
  if v_current is null then return; end if;
  if v_current = 'owner' then raise exception 'the owner role cannot be revoked here' using errcode = '42501'; end if;
  if v_current = 'admin' then
    if not pdm.is_owner() then raise exception 'only the owner can revoke an admin' using errcode = '42501'; end if;
  else
    if not (case when p_vault_id is null then pdm.is_admin() else pdm.is_admin_in(p_vault_id) end) then
      raise exception 'not authorized' using errcode = '42501';
    end if;
  end if;
  delete from pdm.user_roles where user_id = p_target and coalesce(vault_id, v_zero) = coalesce(p_vault_id, v_zero);
end; $$;

-- 3-arg / 2-arg proxies (schema=pdm + public). The client always passes vault.
create or replace function pdm.pdm_set_user_role(p_target uuid, p_role text, p_vault_id uuid default null)
returns void language sql security definer set search_path = pdm, public
as $$ select pdm.set_user_role(p_target, p_role, p_vault_id); $$;
create or replace function public.pdm_set_user_role(p_target uuid, p_role text, p_vault_id uuid default null)
returns void language sql security definer set search_path = pdm, public
as $$ select pdm.set_user_role(p_target, p_role, p_vault_id); $$;
create or replace function pdm.pdm_revoke_user_role(p_target uuid, p_vault_id uuid default null)
returns void language sql security definer set search_path = pdm, public
as $$ select pdm.revoke_user_role(p_target, p_vault_id); $$;
create or replace function public.pdm_revoke_user_role(p_target uuid, p_vault_id uuid default null)
returns void language sql security definer set search_path = pdm, public
as $$ select pdm.revoke_user_role(p_target, p_vault_id); $$;
grant execute on function pdm.pdm_set_user_role(uuid, text, uuid), public.pdm_set_user_role(uuid, text, uuid) to authenticated;
grant execute on function pdm.pdm_revoke_user_role(uuid, uuid), public.pdm_revoke_user_role(uuid, uuid) to authenticated;
revoke execute on function public.pdm_set_user_role(uuid, text, uuid) from anon;
revoke execute on function public.pdm_revoke_user_role(uuid, uuid) from anon;

-- ---------------------------------------------------------------------------
-- 6. admin_list_users: join only the GLOBAL role row (vault_id IS NULL) so a
--    user with per-vault rows isn't duplicated (back-compat). Per-vault
--    listing is a separate RPC.
-- ---------------------------------------------------------------------------
-- Signature must match the existing 7-column version (20260529010000 added
-- display_name + subteam); we only add the `and r.vault_id is null` join so a
-- user with per-vault rows isn't duplicated.
create or replace function pdm.admin_list_users()
returns table (user_id uuid, email text, display_name text, subteam text, role text, granted_at timestamptz, created_at timestamptz)
language plpgsql stable security definer set search_path = pdm, public, auth as $$
begin
  if not pdm.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return query
    select u.id, u.email::text,
      (u.raw_user_meta_data->>'display_name')::text,
      (u.raw_user_meta_data->>'subteam')::text,
      r.role, r.granted_at, u.created_at
    from auth.users u
    left join pdm.user_roles r on r.user_id = u.id and r.vault_id is null
    order by u.created_at asc;
end; $$;

-- list_vault_roles(vault): each user + their EFFECTIVE role in that vault
-- (the per-vault row if present, else the global row).
create or replace function pdm.list_vault_roles(p_vault_id uuid)
returns table (user_id uuid, email text, role text, scope text, granted_at timestamptz, created_at timestamptz)
language plpgsql stable security definer set search_path = pdm, public, auth as $$
begin
  if not (pdm.is_admin() or pdm.is_admin_in(p_vault_id)) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return query
    select u.id, u.email::text,
           coalesce(rv.role, rg.role) as role,
           case when rv.role is not null then 'vault' when rg.role is not null then 'global' else null end as scope,
           coalesce(rv.granted_at, rg.granted_at) as granted_at,
           u.created_at
    from auth.users u
    left join pdm.user_roles rv on rv.user_id = u.id and rv.vault_id = p_vault_id
    left join pdm.user_roles rg on rg.user_id = u.id and rg.vault_id is null
    order by u.created_at asc;
end; $$;
create or replace function pdm.pdm_list_vault_roles(p_vault_id uuid)
returns table (user_id uuid, email text, role text, scope text, granted_at timestamptz, created_at timestamptz)
language sql stable security definer set search_path = pdm, public
as $$ select * from pdm.list_vault_roles(p_vault_id); $$;
create or replace function public.pdm_list_vault_roles(p_vault_id uuid)
returns table (user_id uuid, email text, role text, scope text, granted_at timestamptz, created_at timestamptz)
language sql stable security definer set search_path = pdm, public
as $$ select * from pdm.list_vault_roles(p_vault_id); $$;
grant execute on function pdm.pdm_list_vault_roles(uuid), public.pdm_list_vault_roles(uuid) to authenticated;
revoke execute on function public.pdm_list_vault_roles(uuid) from anon;
