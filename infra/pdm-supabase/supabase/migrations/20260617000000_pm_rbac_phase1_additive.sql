-- Phase 1 (ADDITIVE, NON-ENFORCING) of the Unified Org & Access RBAC.
-- Spec: docs/superpowers/specs/2026-06-17-org-access-and-dashboard-design.md (Rev 3)
--
-- Adds data-driven roles + capabilities + memberships + the subteam<->project
-- map, plus read-only resolver helpers. NOTHING here changes existing RLS or
-- behavior: no existing policy is repointed and no membership is seeded
-- (default-deny). The access-preserving migration that maps existing roles in,
-- and the RLS cutover, are SEPARATE gated steps. Every statement is idempotent.

-- ---------------------------------------------------------------------------
-- 1. Capability catalog (the only hardcoded part: the keys the app checks).
-- ---------------------------------------------------------------------------
create table if not exists pm.capabilities (
  key         text primary key,
  label       text not null,
  description text,
  scope       text not null check (scope in ('org','subteam'))
);

insert into pm.capabilities (key, label, description, scope) values
  ('pm.view',                'View',                 'View tasks and dashboards in scope',            'subteam'),
  ('pm.edit_tasks',          'Edit tasks',           'Create and edit tasks in scope',                'subteam'),
  ('pm.manage_subsystems',   'Manage subsystems',    'Add/edit/remove a subteam''s subsystems',       'subteam'),
  ('pm.manage_dashboard',    'Manage dashboard',     'Edit the shared dashboard + photos in scope',   'subteam'),
  ('pm.grant_subteam_roles', 'Grant subteam roles',  'Assign roles to users within a subteam',        'subteam'),
  ('vault.view',             'Vault: view',          'Read files in scope',                           'subteam'),
  ('vault.edit',             'Vault: edit',          'Check in / edit files in scope',                'subteam'),
  ('vault.admin',            'Vault: admin',         'Force-unlock and delete files in scope',        'subteam'),
  ('org.manage_structure',   'Manage org structure', 'Edit the subteam<->project map + subteam list', 'org'),
  ('org.grant_roles',        'Grant roles',          'Assign org-scoped roles up to your own level',  'org'),
  ('org.manage_roles',       'Manage roles',         'Create/edit/delete role definitions',           'org'),
  ('org.manage_admins',      'Manage admins',        'Grant/revoke Owner and Executive (owner only)', 'org'),
  ('vault.grant_roles',      'Vault: grant roles',   'Assign vault roles',                            'org')
on conflict (key) do update
  set label = excluded.label, description = excluded.description, scope = excluded.scope;

-- ---------------------------------------------------------------------------
-- 2. Roles (editable data) + their capability sets.
-- ---------------------------------------------------------------------------
create table if not exists pm.roles (
  id         uuid primary key default gen_random_uuid(),
  key        text unique not null,
  label      text not null,
  tag        text,                              -- display color/tag
  scope      text not null check (scope in ('org','subteam')),
  is_system  boolean not null default false,    -- protected (Owner): not editable/deletable
  sort_order int not null default 100,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into pm.roles (key, label, tag, scope, is_system, sort_order) values
  ('owner',     'Owner',     '#FFC627', 'org',     true,  0),
  ('executive', 'Executive', '#FFC627', 'org',     false, 10),
  ('lead',      'Lead',      '#34D399', 'subteam', false, 20),
  ('vp',        'VP',        '#22D3EE', 'subteam', false, 21),
  ('engineer',  'Engineer',  '#94A3B8', 'subteam', false, 30),
  ('viewer',    'Viewer',    '#6B7280', 'subteam', false, 40)
on conflict (key) do nothing;

create table if not exists pm.role_capabilities (
  role_id        uuid not null references pm.roles(id) on delete cascade,
  capability_key text not null references pm.capabilities(key) on delete cascade,
  primary key (role_id, capability_key)
);

-- Seed capability sets (idempotent). Owner = all; Executive = all EXCEPT
-- org.manage_admins (so only Owner can grant Owner/Executive); Lead == VP.
insert into pm.role_capabilities (role_id, capability_key)
select r.id, c.key
from pm.roles r
join pm.capabilities c on (
  case r.key
    when 'owner'     then true
    when 'executive' then c.key <> 'org.manage_admins'
    when 'lead'      then c.key in ('pm.view','pm.edit_tasks','pm.manage_subsystems','pm.manage_dashboard','pm.grant_subteam_roles','vault.view','vault.edit')
    when 'vp'        then c.key in ('pm.view','pm.edit_tasks','pm.manage_subsystems','pm.manage_dashboard','pm.grant_subteam_roles','vault.view','vault.edit')
    when 'engineer'  then c.key in ('pm.view','pm.edit_tasks','vault.view')
    when 'viewer'    then c.key in ('pm.view','vault.view')
    else false
  end
)
on conflict (role_id, capability_key) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Role memberships (user -> role @ scope). DEFAULT-DENY: no rows seeded
--    here; existing users are mapped in a SEPARATE access-preserving migration.
-- ---------------------------------------------------------------------------
create table if not exists pm.role_memberships (
  user_id    uuid not null references auth.users(id) on delete cascade,
  role_id    uuid not null references pm.roles(id) on delete cascade,
  subteam_id uuid references pm.subteams(id) on delete cascade,  -- NULL = org-scoped
  granted_by uuid,
  granted_at timestamptz not null default now()
);
create unique index if not exists role_memberships_uniq
  on pm.role_memberships (user_id, role_id, coalesce(subteam_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists role_memberships_user_idx on pm.role_memberships (user_id);

alter table pm.role_memberships enable row level security;
-- Phase 1: a user may read their OWN memberships; admin-facing reads arrive with
-- the cutover. SECURITY DEFINER helpers below bypass this for capability checks.
drop policy if exists role_memberships_select_self on pm.role_memberships;
create policy role_memberships_select_self on pm.role_memberships
  for select to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 4. Subteam <-> project map (replaces "subteams are global"). Shared = >=2
--    projects. Seeded with the full cross-product so behavior is unchanged.
-- ---------------------------------------------------------------------------
create table if not exists pm.project_subteams (
  project_id uuid not null references pm.projects(id) on delete cascade,
  subteam_id uuid not null references pm.subteams(id) on delete cascade,
  primary key (project_id, subteam_id)
);
insert into pm.project_subteams (project_id, subteam_id)
select p.id, s.id from pm.projects p cross join pm.subteams s
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 5. Read-only resolver helpers (SECURITY DEFINER; they only read).
-- ---------------------------------------------------------------------------
-- True if the user holds any role granting `cap` that applies at scope `stid`:
-- an ORG-scoped membership (subteam_id IS NULL, applies everywhere), or a
-- SUBTEAM membership for `stid`.
create or replace function pm.has_capability(uid uuid, cap text, stid uuid default null)
returns boolean language sql stable security definer set search_path = pm, public as $$
  select exists (
    select 1
    from pm.role_memberships m
    join pm.role_capabilities rc on rc.role_id = m.role_id
    where m.user_id = uid
      and rc.capability_key = cap
      and (m.subteam_id is null or (stid is not null and m.subteam_id = stid))
  );
$$;
grant execute on function pm.has_capability(uuid, text, uuid) to authenticated;

-- The caller's (capability, scope) pairs; subteam_id NULL = applies everywhere.
create or replace function pm.my_capabilities()
returns table (capability_key text, subteam_id uuid)
language sql stable security definer set search_path = pm, public as $$
  select distinct rc.capability_key, m.subteam_id
  from pm.role_memberships m
  join pm.role_capabilities rc on rc.role_id = m.role_id
  where m.user_id = auth.uid();
$$;
grant execute on function pm.my_capabilities() to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Read access to the definitions (not secret; the role editor + People panel
--    read them). Writes arrive via admin-gated RPCs in a later phase.
-- ---------------------------------------------------------------------------
alter table pm.capabilities      enable row level security;
alter table pm.roles             enable row level security;
alter table pm.role_capabilities enable row level security;
alter table pm.project_subteams  enable row level security;
drop policy if exists capabilities_read      on pm.capabilities;
drop policy if exists roles_read              on pm.roles;
drop policy if exists role_capabilities_read  on pm.role_capabilities;
drop policy if exists project_subteams_read   on pm.project_subteams;
create policy capabilities_read     on pm.capabilities      for select to authenticated using (true);
create policy roles_read            on pm.roles             for select to authenticated using (true);
create policy role_capabilities_read on pm.role_capabilities for select to authenticated using (true);
create policy project_subteams_read on pm.project_subteams  for select to authenticated using (true);
grant select on pm.capabilities, pm.roles, pm.role_capabilities, pm.project_subteams, pm.role_memberships to authenticated;
