-- Phase 1d: admin-gated directory read for the "Org & Access" People panel.
-- role_memberships is RLS-restricted to a user's own rows, so listing EVERYONE
-- with their roles needs a SECURITY DEFINER reader, gated to anyone who can
-- grant or manage roles (owner/executive via org.grant_roles, role editor via
-- org.manage_roles, or a subteam lead via pm.grant_subteam_roles). Read-only.

create or replace function pm.list_people()
returns table (
  user_id        uuid,
  email          text,
  display_name   text,
  signup_subteam text,
  roles          jsonb
)
language plpgsql stable security definer set search_path = pm, public, auth as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if not (
        pm.has_capability(auth.uid(), 'org.grant_roles', null)
     or pm.has_capability(auth.uid(), 'org.manage_roles', null)
     or exists (
          select 1 from pm.role_memberships m
          join pm.role_capabilities rc on rc.role_id = m.role_id
          where m.user_id = auth.uid() and rc.capability_key = 'pm.grant_subteam_roles'
        )
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return query
    select u.id,
           u.email::text,
           (u.raw_user_meta_data ->> 'display_name')::text,
           (u.raw_user_meta_data ->> 'subteam')::text,
           coalesce((
             select jsonb_agg(
                      jsonb_build_object(
                        'role', r.key, 'label', r.label, 'tag', r.tag,
                        'scope', r.scope, 'subteam_id', m.subteam_id
                      ) order by r.sort_order
                    )
             from pm.role_memberships m
             join pm.roles r on r.id = m.role_id
             where m.user_id = u.id
           ), '[]'::jsonb) as roles
    from auth.users u
    order by u.created_at asc;
end; $$;
grant execute on function pm.list_people() to authenticated;
