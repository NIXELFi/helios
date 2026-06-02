-- 20260602000000_pm_schema.sql
--
-- Helios PM module — initial schema, reconciled against the as-built front-end.
--
-- This SUPERSEDES the never-applied draft at
-- Helios-PM/docs/pm/migrations/001-pm-initial-schema.sql. It is reconciled with
-- the canonical TypeScript contract in packages/pm-ui/src/types.ts and the
-- as-built data layer in apps/web/src/lib/data.ts. Differences from the draft:
--   * "subsystem" (old top-level) -> "subteam" (top-level) + "subsystem"
--     (finer-grained, nested under a subteam). Both are GLOBAL org structure
--     (no project_id) shared across every season/project.
--   * tasks gain `type` (pm.task_type) and a NOT NULL `subteam_id`.
--   * New tables the front-end already consumes: vendors, calendar_events,
--     task_comments (with `kind`), build_records. pages gain `subteam_id`;
--     activity gains `subteam_ids`.
--   * Fixed bug: on_vault_revision_bump referenced 'in_progress', which is not
--     a valid pm.task_status value.
--   * projects KEEP car_year/car_code — they ARE the season identity
--     (SDM25/SDM26/SDM27), surfaced via the project switcher.
--
-- Lives alongside the Vault PDM schema (pdm.*) in the SAME Supabase project and
-- shares auth.users. After applying, add `pm` to the project's exposed schemas
-- (Dashboard -> Project Settings -> API -> Exposed schemas) so the JS client's
-- client.schema('pm') can reach pm.* tables.

-- =============================================================================
-- SCHEMA AND EXTENSIONS
-- =============================================================================

create schema if not exists pm;

create extension if not exists "pgcrypto";  -- gen_random_uuid()

-- =============================================================================
-- ENUMS
-- =============================================================================

create type pm.task_status as enum (
  'backlog',
  'designing',
  'manufacturing',
  'testing',
  'needs_review',
  'blocked',
  'done'
);

create type pm.task_priority as enum ('low', 'medium', 'high', 'critical');

create type pm.task_type as enum (
  'part',
  'drawing',
  'simulation',
  'assembly',
  'analysis',
  'test',
  'general'
);

create type pm.dep_type as enum ('FS', 'SS', 'FF', 'SF');

create type pm.link_type as enum (
  'designs',
  'validates',
  'manufactures',
  'tests',
  'reviews'
);

create type pm.team_role as enum ('admin', 'lead', 'engineer', 'viewer');

create type pm.project_status as enum ('active', 'archived', 'template');

create type pm.milestone_type as enum (
  'design_review',
  'integration',
  'validation',
  'gate',
  'comp_event'
);

create type pm.activity_action as enum (
  'created',
  'updated',
  'deleted',
  'status_changed',
  'linked',
  'unlinked',
  'completed',
  'reviewed'
);

create type pm.page_type as enum (
  'doc',
  'design_review',
  'post_mortem',
  'meeting_notes',
  'generic'
);

create type pm.block_type as enum (
  'text',
  'h1',
  'h2',
  'h3',
  'list_item',
  'todo',
  'callout',
  'divider',
  'image',
  'code',
  'embed_view',
  'embed_part'
);

create type pm.view_entity as enum ('task', 'page', 'milestone', 'part');

create type pm.view_type as enum ('table', 'board', 'gantt', 'calendar', 'graph');

create type pm.vendor_category as enum (
  'machining',
  'sheet_metal',
  'waterjet',
  'laser',
  '3d_print',
  'composites',
  'fasteners',
  'other'
);

create type pm.vendor_status as enum ('active', 'preferred', 'inactive');

create type pm.comment_kind as enum ('general', 'drawing_review');

create type pm.drawing_review as enum ('not_submitted', 'pending', 'pass', 'fail');

-- =============================================================================
-- ORG STRUCTURE (GLOBAL — shared across all seasons/projects)
-- =============================================================================
-- Subteams and subsystems carry no project_id: the team org (Aero, Chassis, …)
-- is stable year to year, while tasks/pages/milestones are season-scoped via
-- project_id. Names are aligned to pdm.subteams so the two can be linked later.

create table pm.subteams (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  code         text not null,
  slug         text not null,
  color        text,
  sort_order   int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid references auth.users(id),

  constraint subteams_name_unique unique (name),
  constraint subteams_code_unique unique (code),
  constraint subteams_slug_unique unique (slug)
);

create table pm.subsystems (
  id                   uuid primary key default gen_random_uuid(),
  subteam_id           uuid not null references pm.subteams(id) on delete cascade,
  parent_subsystem_id  uuid references pm.subsystems(id) on delete cascade,
  name                 text not null,
  code                 text not null,
  color                text,
  display_order        int not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index idx_subsystems_subteam on pm.subsystems(subteam_id);
create index idx_subsystems_parent on pm.subsystems(parent_subsystem_id);
create unique index idx_subsystems_code_per_subteam on pm.subsystems(subteam_id, code);

-- =============================================================================
-- PROJECTS (each row = a competition season: SDM25 / SDM26 / SDM27)
-- =============================================================================

create table pm.projects (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  car_year            int not null,
  car_code            text not null,
  status              pm.project_status not null default 'active',
  template_source_id  uuid references pm.projects(id),
  ship_date           date,
  comp_event          text,
  description         text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid references auth.users(id),

  constraint projects_car_code_unique unique (car_code)
);

create index idx_projects_status on pm.projects(status);

-- =============================================================================
-- MEMBERSHIPS / ROLES
-- =============================================================================
-- team_memberships: a user's role within one season/project.
-- subteam_memberships: a GLOBAL per-subteam override (e.g. "lead in Chassis,
-- viewer everywhere else"). Effective task edit-role = coalesce(subteam role,
-- project role).

create table pm.team_memberships (
  user_id     uuid not null references auth.users(id) on delete cascade,
  project_id  uuid not null references pm.projects(id) on delete cascade,
  team_role   pm.team_role not null,
  joined_at   timestamptz not null default now(),

  primary key (user_id, project_id)
);

create index idx_team_memberships_project on pm.team_memberships(project_id);

create table pm.subteam_memberships (
  user_id     uuid not null references auth.users(id) on delete cascade,
  subteam_id  uuid not null references pm.subteams(id) on delete cascade,
  role        pm.team_role not null,
  joined_at   timestamptz not null default now(),

  primary key (user_id, subteam_id)
);

-- =============================================================================
-- TASKS
-- =============================================================================

create table pm.tasks (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references pm.projects(id) on delete cascade,
  subteam_id          uuid not null references pm.subteams(id),
  subsystem_id        uuid references pm.subsystems(id) on delete set null,
  parent_task_id      uuid references pm.tasks(id) on delete cascade,
  title               text not null,
  description         text,
  type                pm.task_type not null default 'general',
  status              pm.task_status not null default 'backlog',
  priority            pm.task_priority not null default 'medium',
  owner_id            uuid references auth.users(id),
  start_date          date,
  due_date            date,
  estimate_days       numeric,
  actual_days         numeric,
  mrl                 int check (mrl between 1 and 9),
  auto_position_x     float,
  auto_position_y     float,
  manual_position_x   float,
  manual_position_y   float,
  blocked_reason      text,
  review_reason       text,
  on_critical_path    boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid references auth.users(id),
  updated_by          uuid references auth.users(id)
);

create index idx_tasks_project on pm.tasks(project_id);
create index idx_tasks_subteam on pm.tasks(subteam_id);
create index idx_tasks_subsystem on pm.tasks(subsystem_id);
create index idx_tasks_owner on pm.tasks(owner_id);
create index idx_tasks_status on pm.tasks(status);
create index idx_tasks_due_date on pm.tasks(due_date);
create index idx_tasks_parent on pm.tasks(parent_task_id);
create index idx_tasks_critical on pm.tasks(project_id, on_critical_path)
  where on_critical_path = true;

create table pm.task_dependencies (
  predecessor_id  uuid not null references pm.tasks(id) on delete cascade,
  successor_id    uuid not null references pm.tasks(id) on delete cascade,
  dep_type        pm.dep_type not null default 'FS',
  lag_days        numeric not null default 0,
  created_at      timestamptz not null default now(),

  primary key (predecessor_id, successor_id),
  check (predecessor_id <> successor_id)
);

create index idx_deps_successor on pm.task_dependencies(successor_id);

-- Soft link to a Vault file (pdm.files.id). Kept as a plain uuid until we add
-- the cross-schema FK to pdm in a follow-up; see on_vault_revision_bump below.
create table pm.task_part_link (
  task_id    uuid not null references pm.tasks(id) on delete cascade,
  part_id    uuid not null,
  link_type  pm.link_type not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),

  primary key (task_id, part_id, link_type)
);

create index idx_tpl_part on pm.task_part_link(part_id);
create index idx_tpl_task on pm.task_part_link(task_id);

-- =============================================================================
-- MILESTONES
-- =============================================================================

create table pm.milestones (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references pm.projects(id) on delete cascade,
  name         text not null,
  target_date  date not null,
  type         pm.milestone_type not null,
  is_locked    boolean not null default false,
  description  text,
  created_at   timestamptz not null default now()
);

create index idx_milestones_project on pm.milestones(project_id);
create index idx_milestones_date on pm.milestones(target_date);

create table pm.task_milestones (
  task_id      uuid not null references pm.tasks(id) on delete cascade,
  milestone_id uuid not null references pm.milestones(id) on delete cascade,

  primary key (task_id, milestone_id)
);

-- =============================================================================
-- PAGES AND BLOCKS (Notion-style docs)
-- =============================================================================

create table pm.pages (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references pm.projects(id) on delete cascade,
  subteam_id      uuid references pm.subteams(id) on delete set null,
  title           text not null,
  icon            text,
  type            pm.page_type not null default 'generic',
  parent_page_id  uuid references pm.pages(id) on delete cascade,
  order_key       text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id)
);

create index idx_pages_project on pm.pages(project_id);
create index idx_pages_subteam on pm.pages(subteam_id);
create index idx_pages_parent on pm.pages(parent_page_id);

create table pm.blocks (
  id              uuid primary key default gen_random_uuid(),
  page_id         uuid not null references pm.pages(id) on delete cascade,
  parent_block_id uuid references pm.blocks(id) on delete cascade,
  order_key       text not null,
  type            pm.block_type not null,
  props           jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index idx_blocks_page on pm.blocks(page_id);
create index idx_blocks_parent on pm.blocks(parent_block_id);

-- =============================================================================
-- BUILD WORKSPACE (manufacturing): vendors + per-part build records
-- =============================================================================

create table pm.vendors (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references pm.projects(id) on delete cascade,
  name           text not null,
  category       pm.vendor_category not null,
  contact_name   text,
  email          text,
  phone          text,
  website        text,
  location       text,
  processes      text[] not null default '{}',
  machining      jsonb,           -- { types[], features[], axis_count } or null
  lead_time_days int,
  status         pm.vendor_status not null default 'active',
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index idx_vendors_project on pm.vendors(project_id);

-- One row per part-type task. part_file / drawing_file are { name, present }
-- placeholders for Vault file state, replaced by a real pdm.files link later.
create table pm.build_records (
  task_id        uuid primary key references pm.tasks(id) on delete cascade,
  part_file      jsonb,
  drawing_file   jsonb,
  drawing_review pm.drawing_review not null default 'not_submitted',
  updated_at     timestamptz not null default now()
);

-- =============================================================================
-- CALENDAR EVENTS (not tasks: a single day, free-text tags, taggable to
-- one/many/all subteams). subteam_ids is a denormalized array to match the
-- read shape; all_subteams=true means "applies to everyone" and ignores it.
-- =============================================================================

create table pm.calendar_events (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references pm.projects(id) on delete cascade,
  title         text not null,
  date          date not null,
  all_subteams  boolean not null default false,
  subteam_ids   uuid[] not null default '{}',
  type_tags     text[] not null default '{}',
  description   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id)
);

create index idx_events_project on pm.calendar_events(project_id);
create index idx_events_date on pm.calendar_events(date);

-- =============================================================================
-- COMMENTS (task-scoped, with a kind for drawing-review feedback)
-- =============================================================================

create table pm.task_comments (
  id                uuid primary key default gen_random_uuid(),
  task_id           uuid not null references pm.tasks(id) on delete cascade,
  author_id         uuid references auth.users(id) on delete set null,
  body              text not null,
  kind              pm.comment_kind not null default 'general',
  parent_comment_id uuid references pm.task_comments(id) on delete cascade,
  resolved_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index idx_task_comments_task on pm.task_comments(task_id);

-- =============================================================================
-- DATABASE VIEWS (saved table/board/gantt/calendar/graph configs)
-- =============================================================================

create table pm.database_views (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references pm.projects(id) on delete cascade,
  name              text not null,
  entity_type       pm.view_entity not null,
  view_type         pm.view_type not null,
  owner_id          uuid references auth.users(id),
  is_shared         boolean not null default false,
  filter            jsonb not null default '{}'::jsonb,
  sort              jsonb not null default '[]'::jsonb,
  group_by          text,
  properties_shown  jsonb not null default '[]'::jsonb,
  created_at        timestamptz not null default now()
);

create index idx_views_project on pm.database_views(project_id);

-- =============================================================================
-- ACTIVITY LOG (subteam_ids: the subteams touched by the event)
-- =============================================================================

create table pm.activity (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references pm.projects(id) on delete cascade,
  actor_id     uuid references auth.users(id),
  action       pm.activity_action not null,
  target_type  text not null,
  target_id    uuid not null,
  target_name  text,
  subteam_ids  uuid[] not null default '{}',
  payload      jsonb,
  created_at   timestamptz not null default now()
);

create index idx_activity_project on pm.activity(project_id, created_at desc);
create index idx_activity_target on pm.activity(target_type, target_id);

-- =============================================================================
-- HELPER FUNCTIONS FOR RLS
-- =============================================================================
-- SECURITY DEFINER so they can read membership tables regardless of the
-- caller's RLS context. They only read.

create or replace function pm.user_role_in_project(uid uuid, pid uuid)
returns pm.team_role
language sql stable security definer set search_path = pm, public
as $$
  select team_role
  from pm.team_memberships
  where user_id = uid and project_id = pid
  limit 1;
$$;

create or replace function pm.user_role_in_subteam(uid uuid, stid uuid)
returns pm.team_role
language sql stable security definer set search_path = pm, public
as $$
  select role
  from pm.subteam_memberships
  where user_id = uid and subteam_id = stid
  limit 1;
$$;

create or replace function pm.is_project_member(uid uuid, pid uuid)
returns boolean
language sql stable security definer set search_path = pm, public
as $$
  select exists (
    select 1 from pm.team_memberships
    where user_id = uid and project_id = pid
  );
$$;

create or replace function pm.is_any_admin(uid uuid)
returns boolean
language sql stable security definer set search_path = pm, public
as $$
  select exists (
    select 1 from pm.team_memberships
    where user_id = uid and team_role = 'admin'
  );
$$;

-- Effective role for a user in a given season + subteam. A user must be a
-- MEMBER of the season (team_membership) to have any role in it; a GLOBAL
-- subteam role then only ENHANCES access within seasons they belong to — it
-- never grants access to a season they are not a member of (closes the
-- cross-season escalation where a global "lead in Chassis" could edit a season
-- they never joined). Effective role = the more permissive of project/subteam.
create or replace function pm.effective_role(uid uuid, pid uuid, stid uuid)
returns pm.team_role
language sql stable security definer set search_path = pm, public
as $$
  with r as (
    select
      pm.user_role_in_project(uid, pid)::text as pr,
      pm.user_role_in_subteam(uid, stid)::text as st
  )
  select case
    when not pm.is_project_member(uid, pid) then null
    when 'admin'    in (pr, st) then 'admin'::pm.team_role
    when 'lead'     in (pr, st) then 'lead'::pm.team_role
    when 'engineer' in (pr, st) then 'engineer'::pm.team_role
    when 'viewer'   in (pr, st) then 'viewer'::pm.team_role
    else null
  end
  from r;
$$;

create or replace function pm.can_edit_task(uid uuid, tid uuid)
returns boolean
language sql stable security definer set search_path = pm, public
as $$
  select case pm.effective_role(uid, t.project_id, t.subteam_id)
    when 'admin' then true
    when 'lead' then true
    when 'engineer' then (t.owner_id = uid or t.created_by = uid)
    else false
  end
  from pm.tasks t where t.id = tid;
$$;

-- =============================================================================
-- USER DIRECTORY
-- =============================================================================
-- The PM UI shows owner/author display names. Names live in
-- auth.users.raw_user_meta_data->>'display_name' (set at sign-up, same place
-- the Vault reads them). Expose a read-only directory to authenticated users.

create or replace function pm.list_directory()
returns table (id uuid, name text, email text)
language sql stable security definer set search_path = pm, public, auth
as $$
  select
    u.id,
    coalesce(nullif(u.raw_user_meta_data->>'display_name', ''), u.email::text),
    u.email::text
  from auth.users u
  order by 2 asc;
$$;

grant execute on function pm.list_directory() to authenticated;

-- =============================================================================
-- PROJECT CREATION (bootstrap-safe)
-- =============================================================================
-- Direct INSERTs into pm.projects can't pass the admin RLS check (no membership
-- exists yet for a brand-new project), so season creation goes through these
-- SECURITY DEFINER RPCs, which atomically create the project AND the caller's
-- admin team_membership.

-- The very first season. Only callable while pm.projects is empty; makes the
-- caller the founding admin. After this, use create_project / clone.
create or replace function pm.create_first_project(p_name text, p_car_year int, p_car_code text)
returns uuid language plpgsql security definer set search_path = pm, public
as $$
declare new_id uuid;
begin
  if auth.uid() is null then
    raise exception 'must be signed in' using errcode = '42501';
  end if;
  if exists (select 1 from pm.projects) then
    raise exception 'projects already exist; use pm.create_project()' using errcode = '42501';
  end if;
  insert into pm.projects (name, car_year, car_code, created_by)
    values (p_name, p_car_year, p_car_code, auth.uid())
    returning id into new_id;
  insert into pm.team_memberships (user_id, project_id, team_role)
    values (auth.uid(), new_id, 'admin');
  return new_id;
end;
$$;
grant execute on function pm.create_first_project(text, int, text) to authenticated;

-- Subsequent seasons (e.g. creating SDM27 from scratch). Requires the caller to
-- already be an admin of some existing season; makes them admin of the new one.
create or replace function pm.create_project(p_name text, p_car_year int, p_car_code text)
returns uuid language plpgsql security definer set search_path = pm, public
as $$
declare new_id uuid;
begin
  if not pm.is_any_admin(auth.uid()) then
    raise exception 'only an existing project admin can create a season' using errcode = '42501';
  end if;
  insert into pm.projects (name, car_year, car_code, created_by)
    values (p_name, p_car_year, p_car_code, auth.uid())
    returning id into new_id;
  insert into pm.team_memberships (user_id, project_id, team_role)
    values (auth.uid(), new_id, 'admin');
  return new_id;
end;
$$;
grant execute on function pm.create_project(text, int, text) to authenticated;

-- =============================================================================
-- ROW LEVEL SECURITY
-- =============================================================================

alter table pm.subteams            enable row level security;
alter table pm.subsystems          enable row level security;
alter table pm.projects            enable row level security;
alter table pm.team_memberships    enable row level security;
alter table pm.subteam_memberships enable row level security;
alter table pm.tasks               enable row level security;
alter table pm.task_dependencies   enable row level security;
alter table pm.task_part_link      enable row level security;
alter table pm.milestones          enable row level security;
alter table pm.task_milestones     enable row level security;
alter table pm.pages               enable row level security;
alter table pm.blocks              enable row level security;
alter table pm.vendors             enable row level security;
alter table pm.build_records       enable row level security;
alter table pm.calendar_events     enable row level security;
alter table pm.task_comments       enable row level security;
alter table pm.database_views      enable row level security;
alter table pm.activity            enable row level security;

-- org structure: readable by any authenticated user; writes are admin-gated.
create policy "authenticated read subteams"
  on pm.subteams for select to authenticated using (true);
create policy "admins write subteams"
  on pm.subteams for all to authenticated
  using (pm.is_any_admin(auth.uid()))
  with check (pm.is_any_admin(auth.uid()));

create policy "authenticated read subsystems"
  on pm.subsystems for select to authenticated using (true);
create policy "admins write subsystems"
  on pm.subsystems for all to authenticated
  using (pm.is_any_admin(auth.uid()))
  with check (pm.is_any_admin(auth.uid()));

-- projects: members read; admins update/delete. There is intentionally NO
-- client INSERT policy — a direct insert can never pass an admin check because
-- no membership exists yet for a brand-new project. Season creation goes through
-- the SECURITY DEFINER RPCs below (create_first_project / create_project /
-- clone_project_as_template), which create the project AND the caller's admin
-- membership atomically.
create policy "members read projects"
  on pm.projects for select to authenticated
  using (pm.is_project_member(auth.uid(), id));
create policy "admins update projects"
  on pm.projects for update to authenticated
  using (pm.user_role_in_project(auth.uid(), id) = 'admin')
  with check (pm.user_role_in_project(auth.uid(), id) = 'admin');
create policy "admins delete projects"
  on pm.projects for delete to authenticated
  using (pm.user_role_in_project(auth.uid(), id) = 'admin');

-- memberships
create policy "members read team_memberships"
  on pm.team_memberships for select to authenticated
  using (pm.is_project_member(auth.uid(), project_id));
create policy "admins write team_memberships"
  on pm.team_memberships for all to authenticated
  using (pm.user_role_in_project(auth.uid(), project_id) = 'admin')
  with check (pm.user_role_in_project(auth.uid(), project_id) = 'admin');

create policy "authenticated read subteam_memberships"
  on pm.subteam_memberships for select to authenticated using (true);
create policy "admins write subteam_memberships"
  on pm.subteam_memberships for all to authenticated
  using (pm.is_any_admin(auth.uid()))
  with check (pm.is_any_admin(auth.uid()));

-- tasks: broad read for project members, role-aware writes
create policy "members read tasks"
  on pm.tasks for select to authenticated
  using (pm.is_project_member(auth.uid(), project_id));
create policy "engineers+ insert tasks"
  on pm.tasks for insert to authenticated
  with check (
    pm.effective_role(auth.uid(), project_id, subteam_id) in ('admin', 'lead', 'engineer')
  );
create policy "role-based update tasks"
  on pm.tasks for update to authenticated
  using (pm.can_edit_task(auth.uid(), id))
  with check (pm.can_edit_task(auth.uid(), id));
create policy "admins and leads delete tasks"
  on pm.tasks for delete to authenticated
  using (
    pm.effective_role(auth.uid(), project_id, subteam_id) in ('admin', 'lead')
  );

-- task_dependencies / task_part_link / task_milestones: follow the successor /
-- linked task's permissions.
create policy "members read task_dependencies"
  on pm.task_dependencies for select to authenticated
  using (pm.is_project_member(auth.uid(),
    (select project_id from pm.tasks where id = successor_id)));
create policy "engineers+ write task_dependencies"
  on pm.task_dependencies for all to authenticated
  using (pm.can_edit_task(auth.uid(), successor_id))
  with check (pm.can_edit_task(auth.uid(), successor_id));

create policy "members read task_part_link"
  on pm.task_part_link for select to authenticated
  using (pm.is_project_member(auth.uid(),
    (select project_id from pm.tasks where id = task_id)));
create policy "engineers+ write task_part_link"
  on pm.task_part_link for all to authenticated
  using (pm.can_edit_task(auth.uid(), task_id))
  with check (pm.can_edit_task(auth.uid(), task_id));

create policy "members read task_milestones"
  on pm.task_milestones for select to authenticated
  using (pm.is_project_member(auth.uid(),
    (select project_id from pm.tasks where id = task_id)));
create policy "engineers+ write task_milestones"
  on pm.task_milestones for all to authenticated
  using (pm.can_edit_task(auth.uid(), task_id))
  with check (pm.can_edit_task(auth.uid(), task_id));

-- milestones
create policy "members read milestones"
  on pm.milestones for select to authenticated
  using (pm.is_project_member(auth.uid(), project_id));
create policy "admins and leads write milestones"
  on pm.milestones for all to authenticated
  using (pm.user_role_in_project(auth.uid(), project_id) in ('admin', 'lead'))
  with check (pm.user_role_in_project(auth.uid(), project_id) in ('admin', 'lead'));

-- pages and blocks
create policy "members read pages"
  on pm.pages for select to authenticated
  using (pm.is_project_member(auth.uid(), project_id));
create policy "engineers+ write pages"
  on pm.pages for all to authenticated
  using (pm.user_role_in_project(auth.uid(), project_id) in ('admin', 'lead', 'engineer'))
  with check (pm.user_role_in_project(auth.uid(), project_id) in ('admin', 'lead', 'engineer'));

create policy "members read blocks"
  on pm.blocks for select to authenticated
  using (pm.is_project_member(auth.uid(),
    (select project_id from pm.pages where id = page_id)));
create policy "engineers+ write blocks"
  on pm.blocks for all to authenticated
  using (pm.user_role_in_project(auth.uid(),
    (select project_id from pm.pages where id = page_id)) in ('admin', 'lead', 'engineer'))
  with check (pm.user_role_in_project(auth.uid(),
    (select project_id from pm.pages where id = page_id)) in ('admin', 'lead', 'engineer'));

-- vendors / build_records / calendar_events
create policy "members read vendors"
  on pm.vendors for select to authenticated
  using (pm.is_project_member(auth.uid(), project_id));
create policy "engineers+ write vendors"
  on pm.vendors for all to authenticated
  using (pm.user_role_in_project(auth.uid(), project_id) in ('admin', 'lead', 'engineer'))
  with check (pm.user_role_in_project(auth.uid(), project_id) in ('admin', 'lead', 'engineer'));

create policy "members read build_records"
  on pm.build_records for select to authenticated
  using (pm.is_project_member(auth.uid(),
    (select project_id from pm.tasks where id = task_id)));
create policy "engineers+ write build_records"
  on pm.build_records for all to authenticated
  using (pm.can_edit_task(auth.uid(), task_id))
  with check (pm.can_edit_task(auth.uid(), task_id));

create policy "members read calendar_events"
  on pm.calendar_events for select to authenticated
  using (pm.is_project_member(auth.uid(), project_id));
create policy "engineers+ write calendar_events"
  on pm.calendar_events for all to authenticated
  using (pm.user_role_in_project(auth.uid(), project_id) in ('admin', 'lead', 'engineer'))
  with check (pm.user_role_in_project(auth.uid(), project_id) in ('admin', 'lead', 'engineer'));

-- task_comments: members read; an author manages their own comment
create policy "members read task_comments"
  on pm.task_comments for select to authenticated
  using (pm.is_project_member(auth.uid(),
    (select project_id from pm.tasks where id = task_id)));
create policy "members insert task_comments"
  on pm.task_comments for insert to authenticated
  with check (
    author_id = auth.uid()
    and pm.is_project_member(auth.uid(), (select project_id from pm.tasks where id = task_id))
  );
create policy "authors update own task_comments"
  on pm.task_comments for update to authenticated
  using (author_id = auth.uid())
  with check (author_id = auth.uid());
create policy "authors delete own task_comments"
  on pm.task_comments for delete to authenticated
  using (author_id = auth.uid());

-- database_views: a user manages their own; shared views are readable by members
create policy "members read views"
  on pm.database_views for select to authenticated
  using (
    pm.is_project_member(auth.uid(), project_id)
    and (owner_id = auth.uid() or is_shared)
  );
create policy "members write own views"
  on pm.database_views for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- activity: members read; only the security-definer trigger writes
create policy "members read activity"
  on pm.activity for select to authenticated
  using (pm.is_project_member(auth.uid(), project_id));

-- =============================================================================
-- updated_at MAINTENANCE
-- =============================================================================

create or replace function pm.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_subteams_updated_at        before update on pm.subteams        for each row execute function pm.set_updated_at();
create trigger trg_subsystems_updated_at      before update on pm.subsystems      for each row execute function pm.set_updated_at();
create trigger trg_projects_updated_at        before update on pm.projects        for each row execute function pm.set_updated_at();
create trigger trg_tasks_updated_at           before update on pm.tasks           for each row execute function pm.set_updated_at();
create trigger trg_pages_updated_at           before update on pm.pages           for each row execute function pm.set_updated_at();
create trigger trg_blocks_updated_at          before update on pm.blocks          for each row execute function pm.set_updated_at();
create trigger trg_vendors_updated_at         before update on pm.vendors         for each row execute function pm.set_updated_at();
create trigger trg_build_records_updated_at   before update on pm.build_records   for each row execute function pm.set_updated_at();
create trigger trg_calendar_events_updated_at before update on pm.calendar_events for each row execute function pm.set_updated_at();
create trigger trg_task_comments_updated_at   before update on pm.task_comments   for each row execute function pm.set_updated_at();

-- =============================================================================
-- ACTIVITY + SYNC TRIGGERS
-- =============================================================================

-- Every task insert/status-change writes an activity row, tagged with the
-- task's subteam so the per-subteam activity feed can filter on it.
create or replace function pm.on_task_change()
returns trigger language plpgsql security definer set search_path = pm, public
as $$
begin
  if tg_op = 'INSERT' then
    insert into pm.activity (project_id, actor_id, action, target_type, target_id, target_name, subteam_ids)
      values (new.project_id, new.created_by, 'created', 'task', new.id, new.title, array[new.subteam_id]);
    return new;
  elsif tg_op = 'UPDATE' then
    if new.status is distinct from old.status then
      insert into pm.activity (project_id, actor_id, action, target_type, target_id, target_name, subteam_ids, payload)
        values (
          new.project_id, new.updated_by,
          case when new.status = 'done' then 'completed'::pm.activity_action else 'status_changed'::pm.activity_action end,
          'task', new.id, new.title, array[new.subteam_id],
          jsonb_build_object('from', old.status, 'to', new.status)
        );
    end if;
    return new;
  end if;
  return null;
end;
$$;

create trigger trg_task_activity
  after insert or update on pm.tasks
  for each row execute function pm.on_task_change();

-- Vault -> PM: a revision bump on a linked part auto-flags its design tasks for
-- review. The trigger is created only once the Vault exposes revisions; for now
-- the function exists with CORRECT enum values (the draft's 'in_progress' was
-- not a valid pm.task_status — fixed to the real "active" statuses).
create or replace function pm.on_vault_revision_bump(p_part_id uuid, p_rev text, p_actor uuid)
returns void language plpgsql security definer set search_path = pm, public
as $$
begin
  update pm.tasks
    set status = 'needs_review',
        review_reason = format('Rev %s bumped on part %s', p_rev, p_part_id),
        updated_at = now()
  where id in (
    select task_id from pm.task_part_link
    where part_id = p_part_id and link_type in ('designs', 'reviews')
  )
  and status in ('done', 'designing', 'manufacturing', 'testing');

  insert into pm.activity (project_id, actor_id, action, target_type, target_id, target_name, subteam_ids, payload)
    select t.project_id, p_actor, 'reviewed', 'task', t.id, t.title, array[t.subteam_id],
           jsonb_build_object('reason', 'auto-flag from rev bump', 'rev', p_rev, 'part_id', p_part_id)
    from pm.tasks t
    where id in (
      select task_id from pm.task_part_link
      where part_id = p_part_id and link_type in ('designs', 'reviews')
    );
end;
$$;

-- PM -> Vault: completing a 'manufactures' task stamps the part. Stub until the
-- pdm.* parts/manufactured_at columns are wired; kept as a no-op trigger.
create or replace function pm.on_task_manufacture_done()
returns trigger language plpgsql security definer set search_path = pm, public
as $$
begin
  if new.status = 'done' and (old.status is null or old.status <> 'done') then
    -- Wire to pdm when the parts lifecycle exists:
    -- update pdm.files set ... where id in (
    --   select part_id from pm.task_part_link
    --   where task_id = new.id and link_type = 'manufactures');
    null;
  end if;
  return new;
end;
$$;

create trigger trg_task_manufacture_done
  after update on pm.tasks
  for each row execute function pm.on_task_manufacture_done();

-- =============================================================================
-- CRITICAL PATH (placeholder — real longest-path DP lands in a follow-up)
-- =============================================================================

create or replace function pm.recompute_critical_path(p_project_id uuid)
returns void language plpgsql security definer set search_path = pm, public
as $$
begin
  -- TODO: longest-path DP over pm.task_dependencies. No-op for now.
  null;
end;
$$;

-- =============================================================================
-- CROSS-YEAR TEMPLATE CLONING (season turnover)
-- =============================================================================
-- Org (subteams/subsystems) is GLOBAL and shared, so cloning a season copies
-- only tasks, dependencies, and milestones — with dates offset by one year and
-- statuses reset. This is the SDM26 -> SDM27 turnover path.

create or replace function pm.clone_project_as_template(
  source_id uuid,
  new_name text,
  new_car_year int,
  new_car_code text
)
returns uuid language plpgsql security definer set search_path = pm, public
as $$
declare
  new_project_id uuid;
  source_ship_date date;
begin
  if pm.user_role_in_project(auth.uid(), source_id) <> 'admin' then
    raise exception 'only project admins can clone';
  end if;

  select ship_date into source_ship_date from pm.projects where id = source_id;

  insert into pm.projects (name, car_year, car_code, status, template_source_id, ship_date, created_by)
    values (new_name, new_car_year, new_car_code, 'active', source_id,
            (source_ship_date + interval '1 year')::date, auth.uid())
    returning id into new_project_id;

  -- Clone tasks (statuses reset to backlog, dates offset by 1 year). subteam_id
  -- / subsystem_id are GLOBAL so they carry over unchanged.
  create temp table _t_map (old_id uuid primary key, new_id uuid not null) on commit drop;

  insert into _t_map (old_id, new_id)
    select id, gen_random_uuid() from pm.tasks where project_id = source_id;

  insert into pm.tasks (
    id, project_id, subteam_id, subsystem_id, parent_task_id, title, description,
    type, status, priority, start_date, due_date, estimate_days, mrl, created_by
  )
    select
      tm.new_id, new_project_id, t.subteam_id, t.subsystem_id,
      (select new_id from _t_map where old_id = t.parent_task_id),
      t.title, t.description, t.type, 'backlog'::pm.task_status, t.priority,
      (t.start_date + interval '1 year')::date, (t.due_date + interval '1 year')::date,
      t.estimate_days, t.mrl, auth.uid()
    from pm.tasks t join _t_map tm on tm.old_id = t.id
    where t.project_id = source_id;

  -- Clone dependencies (remap both endpoints)
  insert into pm.task_dependencies (predecessor_id, successor_id, dep_type, lag_days)
    select
      (select new_id from _t_map where old_id = d.predecessor_id),
      (select new_id from _t_map where old_id = d.successor_id),
      d.dep_type, d.lag_days
    from pm.task_dependencies d
    where d.predecessor_id in (select old_id from _t_map);

  -- Clone milestones + their task links
  create temp table _m_map (old_id uuid primary key, new_id uuid not null) on commit drop;

  insert into _m_map (old_id, new_id)
    select id, gen_random_uuid() from pm.milestones where project_id = source_id;

  insert into pm.milestones (id, project_id, name, target_date, type, description)
    select mm.new_id, new_project_id, m.name, (m.target_date + interval '1 year')::date, m.type, m.description
    from pm.milestones m join _m_map mm on mm.old_id = m.id;

  insert into pm.task_milestones (task_id, milestone_id)
    select (select new_id from _t_map where old_id = tm.task_id),
           (select new_id from _m_map where old_id = tm.milestone_id)
    from pm.task_milestones tm
    where tm.task_id in (select old_id from _t_map);

  -- The cloning admin becomes admin of the new season
  insert into pm.team_memberships (user_id, project_id, team_role)
    values (auth.uid(), new_project_id, 'admin');

  return new_project_id;
end;
$$;

grant execute on function pm.clone_project_as_template(uuid, text, int, text) to authenticated;

-- =============================================================================
-- POSTGREST EXPOSURE + GRANTS
-- =============================================================================
-- Mirrors the pdm pattern. RLS gates row visibility; these grants gate the
-- privilege so DML doesn't fail with 42501 before RLS runs. NOTE: `pm` must
-- also be added to the project's exposed schemas in the Dashboard API settings.

grant usage on schema pm to anon, authenticated, service_role;

grant all on all tables in schema pm to service_role;
grant select on all tables in schema pm to authenticated;

-- Writable tables (RLS-gated). Org structure + activity are intentionally
-- excluded from broad client DML (org via admin policies above is enough;
-- activity is written by the security-definer trigger only).
grant insert, update, delete on
  pm.projects, pm.team_memberships, pm.subteam_memberships,
  pm.subteams, pm.subsystems,
  pm.tasks, pm.task_dependencies, pm.task_part_link,
  pm.milestones, pm.task_milestones,
  pm.pages, pm.blocks, pm.vendors, pm.build_records,
  pm.calendar_events, pm.task_comments, pm.database_views
  to authenticated;

alter default privileges in schema pm grant select on tables to authenticated;
alter default privileges in schema pm grant all on tables to service_role;

-- =============================================================================
-- END OF MIGRATION
-- =============================================================================
