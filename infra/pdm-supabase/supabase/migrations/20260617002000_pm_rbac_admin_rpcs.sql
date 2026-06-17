-- Phase 1c: guarded write RPCs for the "Org & Access" admin UI.
-- Spec: docs/superpowers/specs/2026-06-17-org-access-and-dashboard-design.md (Rev 3)
--
-- All SECURITY DEFINER; authorization is enforced HERE (the tables stay
-- RLS-locked for direct writes). Guardrails are escalation-proof:
--   * grant-subset  -- you can only grant a role whose capabilities are a subset
--                      of your own effective capabilities at that scope.
--   * edit-subset   -- you can only define a role's capabilities to a subset of
--                      your own.
--   * owner-protection -- only an owner (org.manage_admins) grants/revokes
--                      Owner/Executive; the Owner role definition is immutable;
--                      the last Owner can't be removed.
-- Additive: these don't change any existing policy. Idempotent (create or replace).

-- Effective capability keys for a user at a scope (org-scoped caps apply
-- everywhere; subteam caps apply when stid matches).
create or replace function pm._user_caps(uid uuid, stid uuid)
returns setof text language sql stable security definer set search_path = pm, public as $$
  select distinct rc.capability_key
  from pm.role_memberships m
  join pm.role_capabilities rc on rc.role_id = m.role_id
  where m.user_id = uid
    and (m.subteam_id is null or (stid is not null and m.subteam_id = stid));
$$;

-- ---------------------------------------------------------------------------
-- Grant a role to a user at a scope.
-- ---------------------------------------------------------------------------
create or replace function pm.grant_role(p_target uuid, p_role_key text, p_subteam_id uuid default null)
returns void language plpgsql security definer set search_path = pm, public as $$
declare v_caller uuid := auth.uid(); v_role pm.roles%rowtype;
begin
  if v_caller is null then raise exception 'authentication required' using errcode = '42501'; end if;
  select * into v_role from pm.roles where key = p_role_key;
  if not found then raise exception 'unknown role %', p_role_key using errcode = '22023'; end if;

  -- scope sanity
  if v_role.scope = 'org' and p_subteam_id is not null then
    raise exception 'org role % cannot be granted within a subteam', p_role_key using errcode = '22023';
  end if;
  if v_role.scope = 'subteam' and p_subteam_id is null then
    raise exception 'role % must be granted within a subteam', p_role_key using errcode = '22023';
  end if;

  -- authorization gate
  if p_subteam_id is null then
    if v_role.key in ('owner', 'executive') then
      if not pm.has_capability(v_caller, 'org.manage_admins', null) then
        raise exception 'only an owner may grant %', p_role_key using errcode = '42501';
      end if;
    elsif not pm.has_capability(v_caller, 'org.grant_roles', null) then
      raise exception 'not authorized to grant org roles' using errcode = '42501';
    end if;
  elsif not (pm.has_capability(v_caller, 'pm.grant_subteam_roles', p_subteam_id)
             or pm.has_capability(v_caller, 'org.grant_roles', null)) then
    raise exception 'not authorized to grant roles in this subteam' using errcode = '42501';
  end if;

  -- grant-subset: the role's caps must be a subset of the caller's at this scope
  if exists (
    select rc.capability_key from pm.role_capabilities rc where rc.role_id = v_role.id
    except select pm._user_caps(v_caller, p_subteam_id)
  ) then
    raise exception 'cannot grant a role with capabilities you do not hold' using errcode = '42501';
  end if;

  insert into pm.role_memberships (user_id, role_id, subteam_id, granted_by)
  values (p_target, v_role.id, p_subteam_id, v_caller)
  on conflict do nothing;
end; $$;

-- ---------------------------------------------------------------------------
-- Revoke a role from a user at a scope.
-- ---------------------------------------------------------------------------
create or replace function pm.revoke_role(p_target uuid, p_role_key text, p_subteam_id uuid default null)
returns void language plpgsql security definer set search_path = pm, public as $$
declare v_caller uuid := auth.uid(); v_role pm.roles%rowtype;
begin
  if v_caller is null then raise exception 'authentication required' using errcode = '42501'; end if;
  select * into v_role from pm.roles where key = p_role_key;
  if not found then raise exception 'unknown role %', p_role_key using errcode = '22023'; end if;

  -- authorization gate (mirror grant)
  if v_role.key in ('owner', 'executive') then
    if not pm.has_capability(v_caller, 'org.manage_admins', null) then
      raise exception 'only an owner may revoke %', p_role_key using errcode = '42501';
    end if;
  elsif p_subteam_id is null then
    if not pm.has_capability(v_caller, 'org.grant_roles', null) then
      raise exception 'not authorized to revoke org roles' using errcode = '42501';
    end if;
  elsif not (pm.has_capability(v_caller, 'pm.grant_subteam_roles', p_subteam_id)
             or pm.has_capability(v_caller, 'org.grant_roles', null)) then
    raise exception 'not authorized to revoke roles in this subteam' using errcode = '42501';
  end if;

  -- never strand the org without an owner
  if v_role.key = 'owner'
     and (select count(*) from pm.role_memberships m join pm.roles r on r.id = m.role_id where r.key = 'owner') <= 1 then
    raise exception 'cannot remove the last owner' using errcode = '42501';
  end if;

  delete from pm.role_memberships m
   using pm.roles r
   where m.role_id = r.id and r.key = p_role_key
     and m.user_id = p_target
     and m.subteam_id is not distinct from p_subteam_id;
end; $$;

-- ---------------------------------------------------------------------------
-- Role editor: create/update a role + its capability set (org.manage_roles).
-- ---------------------------------------------------------------------------
create or replace function pm.upsert_role(
  p_key text, p_label text, p_tag text, p_scope text, p_capabilities text[]
) returns uuid language plpgsql security definer set search_path = pm, public as $$
declare v_caller uuid := auth.uid(); v_id uuid; v_is_system boolean; v_cap text;
begin
  if v_caller is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if not pm.has_capability(v_caller, 'org.manage_roles', null) then
    raise exception 'not authorized to manage roles' using errcode = '42501';
  end if;
  if p_scope not in ('org', 'subteam') then raise exception 'invalid scope %', p_scope using errcode = '22023'; end if;

  -- caps must exist in the catalog and be a SUBSET of the caller's own caps
  foreach v_cap in array coalesce(p_capabilities, '{}') loop
    if not exists (select 1 from pm.capabilities where key = v_cap) then
      raise exception 'unknown capability %', v_cap using errcode = '22023';
    end if;
  end loop;
  if exists (
    select unnest(coalesce(p_capabilities, '{}'::text[]))
    except select pm._user_caps(v_caller, null)
  ) then
    raise exception 'cannot define a role with capabilities you do not hold' using errcode = '42501';
  end if;

  select id, is_system into v_id, v_is_system from pm.roles where key = p_key;
  if found and v_is_system then
    raise exception 'the % role is protected and cannot be edited', p_key using errcode = '42501';
  end if;

  if v_id is null then
    insert into pm.roles (key, label, tag, scope, created_by)
    values (p_key, p_label, p_tag, p_scope, v_caller) returning id into v_id;
  else
    update pm.roles set label = p_label, tag = p_tag, scope = p_scope, updated_at = now() where id = v_id;
  end if;

  delete from pm.role_capabilities where role_id = v_id;
  insert into pm.role_capabilities (role_id, capability_key)
  select v_id, unnest(coalesce(p_capabilities, '{}'::text[]));
  return v_id;
end; $$;

create or replace function pm.delete_role(p_key text)
returns void language plpgsql security definer set search_path = pm, public as $$
declare v_caller uuid := auth.uid(); v_id uuid; v_is_system boolean;
begin
  if v_caller is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if not pm.has_capability(v_caller, 'org.manage_roles', null) then
    raise exception 'not authorized to manage roles' using errcode = '42501';
  end if;
  select id, is_system into v_id, v_is_system from pm.roles where key = p_key;
  if v_id is null then return; end if;
  if v_is_system then raise exception 'the % role is protected', p_key using errcode = '42501'; end if;
  if exists (select 1 from pm.role_memberships where role_id = v_id) then
    raise exception 'role % is in use; reassign its members first', p_key using errcode = '42501';
  end if;
  delete from pm.roles where id = v_id;  -- role_capabilities cascade
end; $$;

-- ---------------------------------------------------------------------------
-- Org structure: add/remove a subteam<->project link (org.manage_structure).
-- ---------------------------------------------------------------------------
create or replace function pm.set_project_subteam(p_project_id uuid, p_subteam_id uuid, p_present boolean)
returns void language plpgsql security definer set search_path = pm, public as $$
declare v_caller uuid := auth.uid();
begin
  if v_caller is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if not pm.has_capability(v_caller, 'org.manage_structure', null) then
    raise exception 'not authorized to edit org structure' using errcode = '42501';
  end if;
  if p_present then
    insert into pm.project_subteams (project_id, subteam_id) values (p_project_id, p_subteam_id)
    on conflict do nothing;
  else
    delete from pm.project_subteams where project_id = p_project_id and subteam_id = p_subteam_id;
  end if;
end; $$;

grant execute on function
  pm.grant_role(uuid, text, uuid),
  pm.revoke_role(uuid, text, uuid),
  pm.upsert_role(text, text, text, text, text[]),
  pm.delete_role(text),
  pm.set_project_subteam(uuid, uuid, boolean)
  to authenticated;
