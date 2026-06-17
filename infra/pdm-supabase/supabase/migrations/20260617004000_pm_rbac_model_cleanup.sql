-- Phase 1e: role-model cleanup per owner feedback (2026-06-17).
--  * Executive is treated as Owner (gains org.manage_admins) -- officers
--    (COO/President/CFO/Chief Engineers) get full power.
--  * One rank per subteam: granting a subteam role REPLACES any existing rank in
--    that subteam, so nobody is "Engineer AND Lead" in the same team.
--  * Re-seed everyone into the clean subteam+rank model from their signup subteam:
--    vault owner -> Owner; officer-titled signups -> Executive; vault admin -> Lead
--    of their subteam; everyone else -> Engineer of their subteam; unmatched
--    subteam names -> the 'Unknown' subteam. Still NON-ENFORCING (the RLS flip is
--    the last step). Reversible: re-run 20260617001000 to restore the flat seed.
-- Idempotent.

-- 1. Executive = Owner-level.
insert into pm.role_capabilities (role_id, capability_key)
select r.id, 'org.manage_admins' from pm.roles r where r.key = 'executive'
on conflict (role_id, capability_key) do nothing;

-- 2. grant_role: enforce one rank per subteam (replace any existing rank there).
create or replace function pm.grant_role(p_target uuid, p_role_key text, p_subteam_id uuid default null)
returns void language plpgsql security definer set search_path = pm, public as $$
declare v_caller uuid := auth.uid(); v_role pm.roles%rowtype;
begin
  if v_caller is null then raise exception 'authentication required' using errcode = '42501'; end if;
  select * into v_role from pm.roles where key = p_role_key;
  if not found then raise exception 'unknown role %', p_role_key using errcode = '22023'; end if;

  if v_role.scope = 'org' and p_subteam_id is not null then
    raise exception 'org role % cannot be granted within a subteam', p_role_key using errcode = '22023';
  end if;
  if v_role.scope = 'subteam' and p_subteam_id is null then
    raise exception 'role % must be granted within a subteam', p_role_key using errcode = '22023';
  end if;

  if p_subteam_id is null then
    if v_role.key in ('owner', 'executive') then
      if not pm.has_capability(v_caller, 'org.manage_admins', null) then
        raise exception 'only an owner or executive may grant %', p_role_key using errcode = '42501';
      end if;
    elsif not pm.has_capability(v_caller, 'org.grant_roles', null) then
      raise exception 'not authorized to grant org roles' using errcode = '42501';
    end if;
  elsif not (pm.has_capability(v_caller, 'pm.grant_subteam_roles', p_subteam_id)
             or pm.has_capability(v_caller, 'org.grant_roles', null)) then
    raise exception 'not authorized to grant roles in this subteam' using errcode = '42501';
  end if;

  if exists (
    select rc.capability_key from pm.role_capabilities rc where rc.role_id = v_role.id
    except select pm._user_caps(v_caller, p_subteam_id)
  ) then
    raise exception 'cannot grant a role with capabilities you do not hold' using errcode = '42501';
  end if;

  -- One rank per subteam: drop any existing rank this user holds in this subteam
  -- before adding the new one (no Engineer+Lead stacking).
  if p_subteam_id is not null then
    delete from pm.role_memberships where user_id = p_target and subteam_id = p_subteam_id;
  end if;

  insert into pm.role_memberships (user_id, role_id, subteam_id, granted_by)
  values (p_target, v_role.id, p_subteam_id, v_caller)
  on conflict do nothing;
end; $$;

-- 3. Clean re-seed into subteam + rank.
delete from pm.role_memberships;

with namemap(signup, code) as (values
  ('Engine', 'ENG'), ('Suspension', 'SUS'), ('Data Acquisition', 'DAQ'), ('Aero Design', 'AED'),
  ('Chassis', 'CHA'), ('Driver Interface', 'DRI'), ('Aero Manufacturing', 'AEM'), ('Brakes', 'BRK'),
  ('Drivetrain', 'DRV')
),
person as (
  select u.id as user_id,
         btrim(coalesce(u.raw_user_meta_data ->> 'subteam', '')) as signup,
         ur.role as vrole
  from auth.users u
  left join pdm.user_roles ur on ur.user_id = u.id and ur.vault_id is null
),
resolved as (
  select p.user_id,
    case
      when p.vrole = 'owner' then 'owner'
      when p.signup in ('Chief Engineer', 'President', 'CFO', 'COO') then 'executive'
      when p.vrole = 'admin' then 'lead'
      else 'engineer'
    end as role_key,
    case
      when p.vrole = 'owner' then null
      when p.signup in ('Chief Engineer', 'President', 'CFO', 'COO') then null
      else coalesce(
        (select s.id from pm.subteams s where s.code = (select nm.code from namemap nm where nm.signup = p.signup)),
        (select s.id from pm.subteams s where s.code = 'UNK')
      )
    end as subteam_id
  from person p
)
insert into pm.role_memberships (user_id, role_id, subteam_id, granted_by)
select res.user_id, r.id, res.subteam_id,
       (select o.user_id from pdm.user_roles o where o.role = 'owner' and o.vault_id is null limit 1)
from resolved res
join pm.roles r on r.key = res.role_key
on conflict do nothing;
