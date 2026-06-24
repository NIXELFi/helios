-- Feature: per-project subteam DISPLAY filter for the PM sidebar nav list.
-- Report: Daniel Germaine (Chief Engineer), 2026-06-24 — "subteams should be
-- specific to projects ... I do not want to see battery / high-voltage /
-- low-voltage in the sdm27 project."
--
-- DISPLAY-ONLY: a row here hides a subteam's SHORTCUT from a project's sidebar by
-- default; it NEVER changes task assignment, membership (task_subteams /
-- project_subteams), or any permission. A subteam's tasks still exist and stay
-- filterable in every view-level dropdown. Any user can locally un-hide for
-- themselves (client-side localStorage; not stored here). Absence of a row = the
-- subteam is shown, so newly created subteams are visible by default.
--
-- This is intentionally SEPARATE from pm.project_subteams (the program/car
-- "membership" map edited by the Org Structure panel): "not part of this car" is
-- a different concept from "hidden in this project's sidebar".
--
-- Conventions mirror 20260617000000 (capability/role seed) + 20260617002000
-- (locked-table + SECURITY DEFINER write RPCs) + 20260618000600 (idempotent
-- realtime publish DO-block). Every statement is idempotent.

-- ---------------------------------------------------------------------------
-- 1. Capability: pm.manage_project_subteams (scope subteam).
--    A NEW capability rather than reusing org.manage_structure, so the role
--    editor can hand out sidebar curation independently of the broader org
--    structure powers.
-- ---------------------------------------------------------------------------
insert into pm.capabilities (key, label, description, scope) values
  ('pm.manage_project_subteams', 'Manage project subteams',
   'Hide/show subteams in a project''s sidebar (display-only, server-wide)', 'subteam')
on conflict (key) do update
  set label = excluded.label, description = excluded.description, scope = excluded.scope;

-- Seed onto owner + executive ONLY. The write RPCs below gate on
-- pm.has_capability(uid, 'pm.manage_project_subteams', NULL) — passing stid=NULL
-- means ONLY an ORG-scoped membership (subteam_id IS NULL) can satisfy the check
-- (see has_capability in 20260617000000). Per the 20260617004000 re-seed, only
-- 'owner' and 'executive' are org-scoped; 'lead' and 'vp' are SUBTEAM-scoped, so
-- granting them this cap would be INERT (the NULL-scope gate never honors a
-- subteam membership — it fails closed). A Chief Engineer maps to 'executive'
-- (org-scoped, honored), so the requester already gets server-wide curation.
-- Extending curation to subteam-scoped leads/VPs would require a
-- per-project/subteam-aware gate (pass the target subteam_id instead of NULL)
-- and is deferred as future work. Idempotent.
insert into pm.role_capabilities (role_id, capability_key)
select r.id, 'pm.manage_project_subteams'
from pm.roles r
where r.key in ('owner', 'executive')
on conflict (role_id, capability_key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. The hide table. A row = "hidden server-wide for this project, by default".
--    Both FKs cascade so deleting a subteam or project cleans up its hides.
-- ---------------------------------------------------------------------------
create table if not exists pm.project_hidden_subteams (
  project_id uuid not null references pm.projects(id) on delete cascade,
  subteam_id uuid not null references pm.subteams(id) on delete cascade,
  hidden_by  uuid,
  hidden_at  timestamptz not null default now(),
  primary key (project_id, subteam_id)
);
create index if not exists project_hidden_subteams_project_idx
  on pm.project_hidden_subteams (project_id);

-- ---------------------------------------------------------------------------
-- 3. RLS: world-readable to authenticated; NO direct write policy. The table
--    stays RLS-locked for direct writes (the locked-table convention of
--    20260617002000). ALL writes go through the SECURITY DEFINER RPCs below,
--    which re-check the capability — making that check the single source of
--    truth. (No write policy + RLS enabled => direct INSERT/DELETE are denied.)
-- ---------------------------------------------------------------------------
alter table pm.project_hidden_subteams enable row level security;
drop policy if exists project_hidden_subteams_read on pm.project_hidden_subteams;
create policy project_hidden_subteams_read on pm.project_hidden_subteams
  for select to authenticated using (true);
grant select on pm.project_hidden_subteams to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Write RPCs (SECURITY DEFINER). Authorization is enforced HERE: the caller
--    must hold pm.manage_project_subteams ORG-scoped (stid NULL = held broadly).
--    Org-scoped (not the target subteam's id) because a project's chief engineer
--    curates ANY subteam in their project, including ones they don't belong to.
-- ---------------------------------------------------------------------------
create or replace function pm.hide_project_subteam(p_project_id uuid, p_subteam_id uuid)
returns void language plpgsql security definer set search_path = pm, public as $$
declare v_caller uuid := auth.uid();
begin
  if v_caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not pm.has_capability(v_caller, 'pm.manage_project_subteams', null) then
    raise exception 'not authorized to hide subteams for this project' using errcode = '42501';
  end if;
  insert into pm.project_hidden_subteams (project_id, subteam_id, hidden_by)
  values (p_project_id, p_subteam_id, v_caller)
  on conflict (project_id, subteam_id) do nothing;
end; $$;

create or replace function pm.show_project_subteam(p_project_id uuid, p_subteam_id uuid)
returns void language plpgsql security definer set search_path = pm, public as $$
declare v_caller uuid := auth.uid();
begin
  if v_caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not pm.has_capability(v_caller, 'pm.manage_project_subteams', null) then
    raise exception 'not authorized to show subteams for this project' using errcode = '42501';
  end if;
  delete from pm.project_hidden_subteams
   where project_id = p_project_id and subteam_id = p_subteam_id;
end; $$;

grant execute on function
  pm.hide_project_subteam(uuid, uuid),
  pm.show_project_subteam(uuid, uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Realtime: publish so a chief engineer's server-wide hide/show propagates
--    live to everyone's sidebar. DELETE happens here (show), so REPLICA IDENTITY
--    FULL lets the realtime layer deliver the old row + evaluate RLS on delete.
--    The ADD TABLE is wrapped in an idempotent DO-block (swallows
--    duplicate_object) so the migration is safe to re-run (mirrors 20260618000600).
-- ---------------------------------------------------------------------------
alter table pm.project_hidden_subteams replica identity full;

do $$
begin
  alter publication supabase_realtime add table pm.project_hidden_subteams;
exception
  when duplicate_object then null;
end
$$;
