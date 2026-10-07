-- PM Slack notifications: car-aware lead resolution (IC vs EV).
--
-- Reported 2026-10-07: "When changing tasks for EV the respective IC lead gets
-- pinged, e.g. changing a chassis task for EV, Tim [IC chassis lead] gets
-- pinged. Same for suspension."
--
-- Cause: subteams are GLOBAL (pm.subteams has no car), and Chassis /
-- Suspension are mapped to both the IC and EV projects. A lead grant
-- (pm.role_memberships) carries no car either, so notify.lead_email(subteam)
-- (latest source 20260714020000) just returns the earliest-granted lead of the
-- subteam -- the IC lead -- for every task, whichever car it belongs to.
--
-- Fix: a lead grant can be tagged with a car program.
--   * pm.role_memberships.program: 'ic' | 'ev' | NULL. NULL = "both cars" and
--     is the default, so every existing grant keeps today's behaviour until an
--     admin tags it. The tag is an attribute of the (user, role, subteam)
--     grant, so the unique key is unchanged: someone who leads a subteam for
--     both cars is a single untagged grant.
--   * pm.set_role_program(...): tags/untags an existing subteam-scoped grant.
--     A separate setter (rather than a new pm.grant_role parameter) avoids
--     creating a grant_role overload, and is gated by exactly the subteam
--     branch of grant_role's authorization + grant-subset checks.
--   * notify.lead_email(subteam, project): for a task in a project with a
--     program, leads tagged for THAT program rank first, untagged (both-car)
--     leads next, the legacy pm.subteam_memberships fallback last; a lead
--     tagged for the OTHER program is never returned (no lead -> the
--     dispatcher's existing slack_fallback_email path). A project with no
--     program resolves exactly as before. Tie-break is unchanged (earliest
--     grant, then user id).
--   * notify.enqueue_from_task / notify.enqueue_from_comment: verbatim from
--     20260721000600 except the lead_email call now passes the task's project.
--   * pm.list_people: each role entry also reports `program`, so the Org &
--     Access UI can show and edit the tag (additive jsonb key; same OUT columns).
--
-- pm.list_directory (20260831000000) only reads which subteams a person
-- belongs to -- it does not pick a lead -- so it needs no change here.
--
-- NOTE: pm.grant_role's "one rank per subteam" delete+insert means re-granting
-- a subteam role creates a fresh, untagged grant; re-tag it afterwards.
--
-- Apply to hosted via the Management API query endpoint (the hosted migration
-- history is drifted -- never `supabase db push`).

-- 1. The tag ------------------------------------------------------------------
alter table pm.role_memberships
  add column if not exists program text null check (program in ('ic', 'ev'));

comment on column pm.role_memberships.program is
  'Car program a subteam grant applies to (ic/ev); NULL = both. Used by notify.lead_email to ping the right car''s lead.';

-- 2. Setter -------------------------------------------------------------------
create or replace function pm.set_role_program(p_target uuid, p_role_key text, p_subteam_id uuid, p_program text)
returns void language plpgsql security definer set search_path = pm, public as $$
declare v_caller uuid := auth.uid(); v_role pm.roles%rowtype;
begin
  if v_caller is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_program is not null and p_program not in ('ic', 'ev') then
    raise exception 'invalid program %', p_program using errcode = '22023';
  end if;
  select * into v_role from pm.roles where key = p_role_key;
  if not found then raise exception 'unknown role %', p_role_key using errcode = '22023'; end if;
  if v_role.scope <> 'subteam' or p_subteam_id is null then
    raise exception 'a car program can only be set on a subteam role' using errcode = '22023';
  end if;

  -- Same gate as pm.grant_role for a subteam grant (authorization, then the
  -- grant-subset rule): retagging a grant is as privileged as making it.
  if not (pm.has_capability(v_caller, 'pm.grant_subteam_roles', p_subteam_id)
          or pm.has_capability(v_caller, 'org.grant_roles', null)) then
    raise exception 'not authorized to grant roles in this subteam' using errcode = '42501';
  end if;
  if exists (
    select rc.capability_key from pm.role_capabilities rc where rc.role_id = v_role.id
    except select pm._user_caps(v_caller, p_subteam_id)
  ) then
    raise exception 'cannot grant a role with capabilities you do not hold' using errcode = '42501';
  end if;

  update pm.role_memberships
     set program = p_program
   where user_id = p_target and role_id = v_role.id and subteam_id = p_subteam_id;
  if not found then
    raise exception 'that person does not hold % in this subteam', p_role_key using errcode = 'P0002';
  end if;
end; $$;

revoke all on function pm.set_role_program(uuid, text, uuid, text) from public, anon;
grant execute on function pm.set_role_program(uuid, text, uuid, text) to authenticated;

-- 3. Car-aware lead resolution ------------------------------------------------
-- pri 0 = lead tagged for the task's car, 1 = untagged (both-car) lead,
-- 2 = legacy subteam_memberships lead. Leads tagged for the other car are
-- filtered out. With no project program every org lead is pri 1, which is
-- today's ordering.
create or replace function notify.lead_email(p_subteam uuid, p_project uuid)
 returns text language sql stable security definer set search_path to ''
as $$
  with prog as (
    select (select p.program from pm.projects p where p.id = p_project) as program
  )
  select u.email::text
    from (
      select m.user_id,
             case when prog.program is not null and m.program = prog.program then 0 else 1 end as pri,
             m.granted_at as since
        from pm.role_memberships m
        join pm.roles r on r.id = m.role_id
        cross join prog
       where m.subteam_id = p_subteam and r.key = 'lead'
         and (m.program is null or prog.program is null or m.program = prog.program)
      union all
      select sm.user_id, 2 as pri, sm.joined_at as since
        from pm.subteam_memberships sm
       where sm.subteam_id = p_subteam and sm.role = 'lead'
    ) c
    join auth.users u on u.id = c.user_id
   where p_subteam is not null
   order by c.pri, c.since, c.user_id
   limit 1;
$$;

-- Internal helper: only the SECURITY DEFINER enqueue triggers call it.
revoke all on function notify.lead_email(uuid, uuid) from public, anon, authenticated;

-- 4. Enqueue triggers (verbatim from 20260721000600 bar the lead_email call) ----
CREATE OR REPLACE FUNCTION notify.enqueue_from_task()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor_id uuid; v_actor_email text;
  v_owner_id uuid; v_owner_email text; v_lead_email text;
  v_pid uuid; v_title text; v_target uuid; v_action text;
  v_subteam_id uuid; v_proj text; v_subteam text; v_scope text := '';
  v_lines text[] := array[]::text[];
  v_summary text; v_ckey text;
  v_old_sub text; v_new_sub text;
begin
  v_actor_id := auth.uid();
  select u.email::text into v_actor_email from auth.users u where u.id = v_actor_id;

  if tg_op = 'DELETE' then
    v_title:=OLD.title; v_pid:=OLD.project_id; v_target:=OLD.id;
    v_owner_id:=OLD.owner_id; v_subteam_id:=OLD.subteam_id; v_action:='deleted';
  elsif tg_op = 'INSERT' then
    v_title:=NEW.title; v_pid:=NEW.project_id; v_target:=NEW.id;
    v_owner_id:=NEW.owner_id; v_subteam_id:=NEW.subteam_id; v_action:='created';
  else
    v_title:=NEW.title; v_pid:=NEW.project_id; v_target:=NEW.id;
    v_owner_id:=NEW.owner_id; v_subteam_id:=NEW.subteam_id; v_action:='updated';
    if NEW.status is distinct from OLD.status then
      v_lines := v_lines || ('• Status: '||notify.status_label(OLD.status::text)||' → '||notify.status_label(NEW.status::text));
    end if;
    if NEW.owner_id is distinct from OLD.owner_id then
      v_lines := v_lines || ('• Owner: '||notify.person_name(OLD.owner_id)||' → '||notify.person_name(NEW.owner_id));
    end if;
    if NEW.due_date is distinct from OLD.due_date then
      v_lines := v_lines || ('• Due: '||coalesce(OLD.due_date::text,'none')||' → '||coalesce(NEW.due_date::text,'none'));
    end if;
    if NEW.priority is distinct from OLD.priority then
      v_lines := v_lines || ('• Priority: '||initcap(coalesce(OLD.priority::text,'none'))||' → '||initcap(coalesce(NEW.priority::text,'none')));
    end if;
    if NEW.start_date is distinct from OLD.start_date then
      v_lines := v_lines || ('• Start: '||coalesce(OLD.start_date::text,'none')||' → '||coalesce(NEW.start_date::text,'none'));
    end if;
    if NEW.type is distinct from OLD.type then
      v_lines := v_lines || ('• Type: '||initcap(coalesce(OLD.type::text,'none'))||' → '||initcap(coalesce(NEW.type::text,'none')));
    end if;
    if NEW.mrl is distinct from OLD.mrl then
      v_lines := v_lines || ('• MRL: '||coalesce(OLD.mrl::text,'none')||' → '||coalesce(NEW.mrl::text,'none'));
    end if;
    if NEW.subteam_id is distinct from OLD.subteam_id then
      select s.name into v_old_sub from pm.subteams s where s.id = OLD.subteam_id;
      select s.name into v_new_sub from pm.subteams s where s.id = NEW.subteam_id;
      v_lines := v_lines || ('• Subteam: '||coalesce(v_old_sub,'none')||' → '||coalesce(v_new_sub,'none'));
    end if;
    if NEW.subsystem_id is distinct from OLD.subsystem_id then
      v_lines := v_lines || '• Subsystem changed';
    end if;
    if NEW.title is distinct from OLD.title then
      v_lines := v_lines || ('• Renamed: "'||coalesce(OLD.title,'')||'" → "'||coalesce(NEW.title,'')||'"');
    end if;
    if NEW.description is distinct from OLD.description then
      v_lines := v_lines || '• Description edited';
    end if;
    -- Only untracked fields changed → no notification.
    if array_length(v_lines, 1) is null then return null; end if;
  end if;

  -- Scope ( — project / subteam ) appended to the headline.
  select p.name into v_proj from pm.projects p where p.id = v_pid;
  select s.name into v_subteam from pm.subteams s where s.id = v_subteam_id;
  if v_proj is not null and v_subteam is not null then v_scope := ' — '||v_proj||' / '||v_subteam;
  elsif v_proj is not null then v_scope := ' — '||v_proj;
  elsif v_subteam is not null then v_scope := ' — '||v_subteam; end if;

  -- `text` is description only — the actor/owner/lead are sent as variables.
  if v_action = 'updated' then
    v_summary := 'updated "'||coalesce(v_title,'(untitled)')||'"'||v_scope
                 || E'\n' || array_to_string(v_lines, E'\n');
  else
    v_summary := v_action||' "'||coalesce(v_title,'(untitled)')||'"'||v_scope;
  end if;

  if v_owner_id is not null then
    select u.email::text into v_owner_email from auth.users u where u.id = v_owner_id;
  end if;
  v_lead_email := notify.lead_email(v_subteam_id, v_pid);

  v_ckey := 'pm:' || v_target::text;
  insert into notify.outbox (source, project_id, actor_id, actor_email, owner_email, lead_email, action, target_type, target_id, target_name, summary, coalesce_key, send_after)
  values ('pm', v_pid, v_actor_id, v_actor_email, v_owner_email, v_lead_email, v_action, 'task', v_target, v_title, v_summary, v_ckey, now()+interval '20 seconds')
  on conflict (coalesce_key) where status = 'pending'
  do update set edit_count = notify.outbox.edit_count + 1,
                summary = excluded.summary, action = excluded.action,
                actor_id = excluded.actor_id, actor_email = excluded.actor_email,
                owner_email = excluded.owner_email, lead_email = excluded.lead_email,
                send_after = excluded.send_after;
  return null;
exception when others then return null;
end $function$;

CREATE OR REPLACE FUNCTION notify.enqueue_from_comment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor_id uuid; v_actor_email text;
  v_owner_id uuid; v_owner_email text; v_lead_email text;
  v_task text; v_pid uuid; v_subteam_id uuid;
  v_proj text; v_subteam text; v_scope text := '';
  v_summary text; v_ckey text; v_snip text;
begin
  v_actor_id := coalesce(NEW.author_id, auth.uid());
  select u.email::text into v_actor_email from auth.users u where u.id = v_actor_id;

  select t.title, t.project_id, t.owner_id, t.subteam_id
    into v_task, v_pid, v_owner_id, v_subteam_id
    from pm.tasks t where t.id = NEW.task_id;
  v_task := coalesce(v_task, '(task)');

  select p.name into v_proj from pm.projects p where p.id = v_pid;
  select s.name into v_subteam from pm.subteams s where s.id = v_subteam_id;
  if v_proj is not null and v_subteam is not null then v_scope := ' — '||v_proj||' / '||v_subteam;
  elsif v_proj is not null then v_scope := ' — '||v_proj;
  elsif v_subteam is not null then v_scope := ' — '||v_subteam; end if;

  v_snip := left(regexp_replace(coalesce(NEW.body, ''), '\s+', ' ', 'g'), 140);

  if NEW.kind::text = 'drawing_review' then
    v_summary := 'left a drawing review on "'||v_task||'"'||v_scope;
  else
    v_summary := 'commented on "'||v_task||'"'||v_scope
                 || case when v_snip <> '' then E'\n'||'"'||v_snip||'"' else '' end;
  end if;

  if v_owner_id is not null then
    select u.email::text into v_owner_email from auth.users u where u.id = v_owner_id;
  end if;
  v_lead_email := notify.lead_email(v_subteam_id, v_pid);

  v_ckey := 'pm-comment:'||NEW.task_id::text||':'||coalesce(v_actor_id::text, '?');
  insert into notify.outbox (source, event_id, project_id, actor_id, actor_email, owner_email, lead_email, action, target_type, target_id, target_name, summary, coalesce_key, send_after)
  values ('pm', NEW.id, v_pid, v_actor_id, v_actor_email, v_owner_email, v_lead_email, 'commented', 'comment', NEW.task_id, v_task, v_summary, v_ckey, now()+interval '20 seconds')
  on conflict (coalesce_key) where status = 'pending'
  do update set edit_count = notify.outbox.edit_count + 1,
                summary = excluded.summary, action = excluded.action, event_id = excluded.event_id,
                actor_id = excluded.actor_id, actor_email = excluded.actor_email,
                owner_email = excluded.owner_email, lead_email = excluded.lead_email,
                send_after = excluded.send_after;
  return null;
exception when others then return null;
end $function$;

-- Nothing calls the subteam-only resolver any more (plpgsql bodies are not
-- dependency-tracked, so this is checked by the structure test instead).
drop function if exists notify.lead_email(uuid);

-- 5. Expose the tag to the Org & Access people list ---------------------------
-- Verbatim from 20260617003000 plus 'program' in each role object.
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
                        'scope', r.scope, 'subteam_id', m.subteam_id,
                        'program', m.program
                      ) order by r.sort_order
                    )
             from pm.role_memberships m
             join pm.roles r on r.id = m.role_id
             where m.user_id = u.id
           ), '[]'::jsonb) as roles
    from auth.users u
    order by u.created_at asc;
end; $$;
-- CREATE OR REPLACE preserves existing grants; re-stated to be explicit
-- (matches 20260617003000).
grant execute on function pm.list_people() to authenticated;
