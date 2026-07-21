-- 5.2.1 hardening: make the notify-outbox coalesce enqueue atomic.
--
-- notify.enqueue_from_task / notify.enqueue_from_comment (latest source
-- 20260629000000) did a non-atomic `update ... where coalesce_key=X and
-- status='pending'; if not found then insert ...` against the partial unique
-- index notify_outbox_coalesce_pending (coalesce_key) where status='pending'.
-- Two concurrent same-key edits could both miss the UPDATE, both take the
-- INSERT path, and the loser's unique_violation was swallowed by the
-- trailing `exception when others then return null` — silently dropping that
-- edit's delta.
--
-- Fix: replace the update-then-insert block in BOTH functions with a single
-- INSERT ... ON CONFLICT (coalesce_key) WHERE status='pending' DO UPDATE that
-- performs the same coalesce (bump edit_count, refresh the payload fields the
-- old UPDATE set, push send_after). Everything else — including the
-- swallow-all exception handler, which still guards the "row went inflight
-- between conflict check and lock" edge — is verbatim from 20260629000000.
-- No grants to (re)state: these run only as triggers.

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
  v_lead_email := notify.lead_email(v_subteam_id);

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
  v_lead_email := notify.lead_email(v_subteam_id);

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
