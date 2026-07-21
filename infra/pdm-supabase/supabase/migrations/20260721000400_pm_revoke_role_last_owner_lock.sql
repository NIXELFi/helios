-- 5.2.1 hardening: serialize concurrent owner-revokes (last-owner guard race).
--
-- pm.revoke_role (latest source 20260617002000) protects "never strand the org
-- without an owner" with a plain `count(*) <= 1` check followed by the DELETE —
-- no lock. Two concurrent revoke_role(x, 'owner') calls targeting DIFFERENT
-- owners can both read count = 2, both pass the guard, and both delete →
-- zero owners left.
--
-- Fix: take a transaction-scoped advisory lock immediately before the guard,
-- only for owner revokes, so the second transaction waits until the first
-- commits and then sees the committed decrement. Everything else is verbatim
-- from 20260617002000. CREATE OR REPLACE only; idempotent.

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

  -- Serialize owner-revokes so two concurrent calls can't both pass the
  -- last-owner count below (the second waits here until the first commits,
  -- then sees the committed decrement).
  if v_role.key = 'owner' then
    perform pg_advisory_xact_lock(hashtext('pm.last_owner_guard'));
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

-- CREATE OR REPLACE preserves existing grants; re-stated to be explicit
-- (matches 20260617002000).
grant execute on function pm.revoke_role(uuid, text, uuid) to authenticated;
