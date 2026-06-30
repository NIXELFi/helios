-- PM Slack notifications: restructured message + a new `lead` recipient variable.
--
-- Supersedes the PM enqueue layout from 20260603120000_notify_slack_dispatch.sql.
-- Apply to dlmyixonuyckxkknolku via the Management API; this file keeps the repo
-- in sync and does NOT change the live DB on its own. Secrets/cron/tables/triggers
-- from the base migration are otherwise unchanged.
--
-- HOW MENTIONS WORK (important): the Slack Workflow renders people from DATA
-- VARIABLES (Slack-user emails), NOT from text — putting <@id> in text shows up
-- literally. So this migration keeps actor/owner/lead as separate EMAIL fields in
-- the dispatch payload and puts only the human-readable description in `text`.
-- The dispatch body for the PM channel is:
--     { text, actor: <email>, owner: <email>, lead: <email> }
-- The Workflow message template arranges them, e.g.  {actor} {text}
--                                                    Owner {owner} · Lead {lead}
--
-- `text` (no markdown — Slack shows it literally; •, ·, →, — are plain Unicode):
--     updated "Frame rev B" — SDM27 / Chassis
--     • Status: In Review → In Progress
--     • Due: 2026-07-01 → 2026-07-08
--
-- Notes:
--   * Actor is NOT pinged about their own edit: Slack does not notify a user of a
--     self-mention, so when the actor is also the owner/lead it resolves to no
--     self-ping automatically.
--   * `lead` is the task's primary-subteam lead by email (earliest-joined when a
--     subteam has several). Empty string when the subteam has no lead — the
--     Workflow should treat an empty lead as "skip".
--   * Friendly status labels (pm-ui statusMeta.ts parity) + old → new for the
--     changed fields; label-only lines for subsystem/rename/description.

-- 1. Outbox gains a lead recipient column -----------------------------------
alter table notify.outbox add column if not exists lead_email text;

-- 2. Helpers ----------------------------------------------------------------

-- Friendly label for the 5-status enum (single source: pm-ui statusMeta.ts).
create or replace function notify.status_label(p_status text)
 returns text language sql immutable
as $$
  select case p_status
    when 'not_started'  then 'Not Started'
    when 'in_progress'  then 'In Progress'
    when 'needs_review' then 'Needs Review'
    when 'blocked'      then 'Blocked'
    when 'done'         then 'Done'
    else coalesce(initcap(replace(p_status, '_', ' ')), '—')
  end;
$$;

-- Plain display name (used for the old→new owner CHANGE line in `text`; the
-- owner/lead MENTIONS are separate email variables, not this).
create or replace function notify.person_name(p_uid uuid)
 returns text language sql stable security definer set search_path to ''
as $$
  select coalesce(
    (select coalesce(nullif(u.raw_user_meta_data->>'display_name', ''), u.email::text)
       from auth.users u where u.id = p_uid),
    case when p_uid is null then 'unassigned' else 'someone' end);
$$;

-- Email of the subteam's lead (earliest-joined when several). Null when none.
create or replace function notify.lead_email(p_subteam uuid)
 returns text language sql stable security definer set search_path to ''
as $$
  select u.email::text
    from pm.subteam_memberships m
    join auth.users u on u.id = m.user_id
   where p_subteam is not null and m.subteam_id = p_subteam and m.role = 'lead'
   order by m.joined_at, m.user_id
   limit 1;
$$;

-- person_token / lead_tokens from the earlier <@id>-in-text draft are obsolete.
drop function if exists notify.person_token(uuid, uuid);
drop function if exists notify.lead_tokens(uuid, uuid);

-- 3. Task enqueue (description-only text; owner/lead travel as variables) -----
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
  update notify.outbox
     set edit_count=edit_count+1, summary=v_summary, action=v_action, actor_id=v_actor_id,
         actor_email=v_actor_email, owner_email=v_owner_email, lead_email=v_lead_email,
         send_after=now()+interval '20 seconds'
   where coalesce_key=v_ckey and status='pending';
  if not found then
    insert into notify.outbox (source, project_id, actor_id, actor_email, owner_email, lead_email, action, target_type, target_id, target_name, summary, coalesce_key, send_after)
    values ('pm', v_pid, v_actor_id, v_actor_email, v_owner_email, v_lead_email, v_action, 'task', v_target, v_title, v_summary, v_ckey, now()+interval '20 seconds');
  end if;
  return null;
exception when others then return null;
end $function$;

-- 4. Comment enqueue (same contract) ----------------------------------------
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
  update notify.outbox
     set edit_count=edit_count+1, summary=v_summary, action='commented', event_id=NEW.id,
         actor_id=v_actor_id, actor_email=v_actor_email, owner_email=v_owner_email, lead_email=v_lead_email,
         send_after=now()+interval '20 seconds'
   where coalesce_key=v_ckey and status='pending';
  if not found then
    insert into notify.outbox (source, event_id, project_id, actor_id, actor_email, owner_email, lead_email, action, target_type, target_id, target_name, summary, coalesce_key, send_after)
    values ('pm', NEW.id, v_pid, v_actor_id, v_actor_email, v_owner_email, v_lead_email, 'commented', 'comment', NEW.task_id, v_task, v_summary, v_ckey, now()+interval '20 seconds');
  end if;
  return null;
exception when others then return null;
end $function$;

-- 5. Dispatcher: send the new `lead` email field; " · N edits" suffix --------
--    All other dispatch logic (incl. the vault path) is unchanged from
--    20260603120000.
CREATE OR REPLACE FUNCTION notify.dispatch()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_pm_url text; v_vault_url text; v_fallback text; v_url text; v_target text;
  r record; v_req bigint; v_text text; v_body jsonb;
begin
  update notify.outbox o
     set status = case when resp.status_code between 200 and 299 then 'sent'
                       when o.attempts >= 5 then 'dead' else 'pending' end,
         http_status = resp.status_code,
         last_error  = case when resp.status_code between 200 and 299 then null
                            else coalesce(resp.error_msg, 'http '||coalesce(resp.status_code::text,'?')) end,
         sent_at     = case when resp.status_code between 200 and 299 then now() else o.sent_at end,
         send_after  = case when resp.status_code between 200 and 299 then o.send_after
                            else now() + (interval '30 seconds' * power(2, o.attempts)::int) end
   from net._http_response resp
  where o.status = 'inflight' and o.request_id = resp.id;

  update notify.outbox o
     set status = case when o.attempts >= 5 then 'dead' else 'pending' end,
         last_error = 'no response (stale)', send_after = now()
   where o.status = 'inflight' and o.next_attempt_at < now()
     and not exists (select 1 from net._http_response resp where resp.id = o.request_id);

  select decrypted_secret into v_pm_url    from vault.decrypted_secrets where name='slack_wf_activity_url' limit 1;
  select decrypted_secret into v_vault_url from vault.decrypted_secrets where name='slack_wf_vault_url'    limit 1;
  select decrypted_secret into v_fallback  from vault.decrypted_secrets where name='slack_fallback_email'  limit 1;

  for r in
    select * from notify.outbox where status='pending' and send_after<=now()
     order by send_after limit 8 for update skip locked
  loop
    if r.source = 'vault' then v_url:=v_vault_url; v_target:='channel:vault';
    else                       v_url:=v_pm_url;    v_target:='channel:pm'; end if;
    if v_url is null then continue; end if;

    v_text := r.summary || case when r.edit_count > 1 then ' · '||r.edit_count||' edits' else '' end;
    if r.source = 'vault' then
      v_body := jsonb_build_object('text', v_text);
    else
      -- actor/owner/lead are Slack-user EMAILS; the Workflow resolves + mentions
      -- them. owner falls back to slack_fallback_email; lead is '' when none so
      -- the Workflow can skip it (the fallback person is not anyone's "lead").
      v_body := jsonb_build_object('text', v_text,
                                   'actor', coalesce(r.actor_email, v_fallback),
                                   'owner', coalesce(r.owner_email, v_fallback),
                                   'lead',  coalesce(r.lead_email, ''));
    end if;

    begin
      v_req := net.http_post(url := v_url, body := v_body);
      update notify.outbox set status='inflight', request_id=v_req, attempts=attempts+1, last_error=null,
             next_attempt_at = now() + interval '2 minutes' where id = r.id;
      insert into notify.deliveries (outbox_id, event_id, target, status, attempts)
        values (r.id, r.event_id, v_target, 'sent', r.attempts+1);
    exception when others then
      update notify.outbox set status = case when attempts >= 5 then 'dead' else 'pending' end,
             attempts = attempts+1, last_error = SQLERRM, send_after = now() + interval '1 minute' where id = r.id;
      insert into notify.deliveries (outbox_id, event_id, target, status, attempts, last_error)
        values (r.id, r.event_id, v_target, 'error', r.attempts+1, SQLERRM);
    end;
  end loop;
end $function$;
