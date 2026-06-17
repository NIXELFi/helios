-- Phase 1f: give executives their specific titles (like Leads show their subteam).
-- President / COO / CFO / Chief Engineer become distinct org-scoped roles, each
-- with the SAME owner-level capability set as Executive (same pattern as Lead/VP).
-- The 5 current officers are re-pointed from the generic Executive role to their
-- title, based on their signup field. Still non-enforcing. Idempotent.

insert into pm.roles (key, label, tag, scope, is_system, sort_order) values
  ('president',      'President',      '#FFC627', 'org', false, 2),
  ('coo',            'COO',            '#FFC627', 'org', false, 3),
  ('cfo',            'CFO',            '#FFC627', 'org', false, 4),
  ('chief_engineer', 'Chief Engineer', '#FFC627', 'org', false, 5)
on conflict (key) do nothing;

-- Owner-level capabilities for each (every catalog capability, like Executive).
insert into pm.role_capabilities (role_id, capability_key)
select r.id, c.key
from pm.roles r
cross join pm.capabilities c
where r.key in ('president', 'coo', 'cfo', 'chief_engineer')
on conflict (role_id, capability_key) do nothing;

-- Re-point the officers' memberships from generic Executive to their title.
update pm.role_memberships m
set role_id = tr.id
from (
  select u.id as user_id,
         case btrim(u.raw_user_meta_data ->> 'subteam')
           when 'President'       then 'president'
           when 'COO'             then 'coo'
           when 'CFO'             then 'cfo'
           when 'Chief Engineer'  then 'chief_engineer'
         end as title_key
  from auth.users u
) t
join pm.roles tr on tr.key = t.title_key
where m.user_id = t.user_id
  and t.title_key is not null
  and m.role_id = (select id from pm.roles where key = 'executive');
