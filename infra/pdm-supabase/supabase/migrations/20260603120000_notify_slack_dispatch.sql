-- Slack notifier: the `notify` schema (debounced outbox + pg_cron dispatcher).
--
-- Applied to dlmyixonuyckxkknolku via the Management API; this file keeps the
-- repo / a from-scratch rebuild in sync. It does NOT change the live DB.
--
-- How it works: AFTER triggers on pm.tasks / pm.task_comments enqueue a
-- coalesced summary row into notify.outbox (debounced ~20s, one pending row per
-- coalesce_key). A pg_cron job ("helios-notify-dispatch", every 30s) runs
-- notify.dispatch(), which POSTs pending rows to Slack via net.http_post and
-- tracks delivery/retry state.
--
-- SECRETS: the Slack webhook URLs are NOT in this file. dispatch() reads them at
-- runtime from Supabase Vault by name — `slack_wf_activity_url`,
-- `slack_wf_vault_url`, `slack_fallback_email`. A fresh environment must set
-- those vault secrets (dispatch() no-ops for any channel whose URL is unset).
-- The enqueue_from_activity / enqueue_from_pdm_audit functions are captured as
-- they exist in prod (currently no trigger is wired to them).

create extension if not exists pg_net;
create extension if not exists pg_cron;
create schema if not exists notify;

-- 1. Tables -----------------------------------------------------------------
create table if not exists notify.outbox (
  id              bigint generated always as identity primary key,
  source          text        not null default 'pm',
  event_id        uuid,
  project_id      uuid,
  actor_id        uuid,
  action          text,
  target_type     text,
  target_id       uuid,
  target_name     text,
  summary         text        not null,
  edit_count      integer     not null default 1,
  coalesce_key    text        not null,
  status          text        not null default 'pending',
  attempts        integer     not null default 0,
  request_id      bigint,
  http_status     integer,
  last_error      text,
  send_after      timestamptz not null default now(),
  next_attempt_at timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,
  actor_email     text,
  owner_email     text
);

create table if not exists notify.deliveries (
  id          bigint generated always as identity primary key,
  outbox_id   bigint references notify.outbox(id),
  event_id    uuid,
  target      text,
  status      text,
  http_status integer,
  attempts    integer,
  last_error  text,
  sent_at     timestamptz not null default now()
);

-- 2. Indexes ----------------------------------------------------------------
create unique index if not exists notify_outbox_coalesce_pending
  on notify.outbox (coalesce_key) where status = 'pending';
create index if not exists notify_outbox_due
  on notify.outbox (status, send_after);
create index if not exists notify_outbox_inflight
  on notify.outbox (status) where status = 'inflight';

-- 3. Failures view ----------------------------------------------------------
create or replace view notify.failures as
  select id, source, action, target_name, summary, attempts, last_error, http_status, created_at
  from notify.outbox
  where status = any (array['failed'::text, 'dead'::text]);

-- 4. Enqueue trigger functions ----------------------------------------------
CREATE OR REPLACE FUNCTION notify.enqueue_from_task()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor_id uuid; v_actor_email text;
  v_owner_id uuid; v_owner_email text;
  v_proj text; v_title text; v_pid uuid; v_target uuid; v_action text;
  v_summary text; v_ckey text; v_ch text[] := array[]::text[];
begin
  v_actor_id := auth.uid();
  select u.email::text into v_actor_email from auth.users u where u.id = v_actor_id;

  if tg_op = 'DELETE' then
    v_title:=OLD.title; v_pid:=OLD.project_id; v_target:=OLD.id; v_owner_id:=OLD.owner_id; v_action:='deleted';
    v_summary := 'deleted task "' || coalesce(v_title,'(untitled)') || '"';
  elsif tg_op = 'INSERT' then
    v_title:=NEW.title; v_pid:=NEW.project_id; v_target:=NEW.id; v_owner_id:=NEW.owner_id; v_action:='created';
    v_summary := 'created task "' || coalesce(v_title,'(untitled)') || '"';
  else
    v_title:=NEW.title; v_pid:=NEW.project_id; v_target:=NEW.id; v_owner_id:=NEW.owner_id; v_action:='updated';
    if NEW.status       is distinct from OLD.status       then v_ch:=v_ch||('status → '||NEW.status); end if;
    if NEW.owner_id     is distinct from OLD.owner_id      then v_ch:=v_ch||('owner → '||coalesce((select coalesce(nullif(u.raw_user_meta_data->>'display_name',''),u.email::text) from auth.users u where u.id=NEW.owner_id),'unassigned')); end if;
    if NEW.due_date     is distinct from OLD.due_date      then v_ch:=v_ch||('due → '||coalesce(NEW.due_date::text,'none')); end if;
    if NEW.priority     is distinct from OLD.priority      then v_ch:=v_ch||('priority → '||NEW.priority); end if;
    if NEW.subteam_id   is distinct from OLD.subteam_id    then v_ch:=v_ch||'subteam changed'; end if;
    if NEW.subsystem_id is distinct from OLD.subsystem_id  then v_ch:=v_ch||'subsystem changed'; end if;
    if NEW.title        is distinct from OLD.title         then v_ch:=v_ch||'renamed'; end if;
    if NEW.description   is distinct from OLD.description   then v_ch:=v_ch||'description edited'; end if;
    if NEW.start_date   is distinct from OLD.start_date    then v_ch:=v_ch||('start → '||coalesce(NEW.start_date::text,'none')); end if;
    if NEW.mrl          is distinct from OLD.mrl           then v_ch:=v_ch||('MRL → '||coalesce(NEW.mrl::text,'none')); end if;
    if NEW.type         is distinct from OLD.type          then v_ch:=v_ch||('type → '||NEW.type); end if;
    if array_length(v_ch,1) is null then return null; end if;
    v_summary := 'updated "' || coalesce(v_title,'(untitled)') || '": ' || array_to_string(v_ch, ', ');
  end if;

  if v_owner_id is not null then
    select u.email::text into v_owner_email from auth.users u where u.id = v_owner_id;
  end if;
  select p.name into v_proj from pm.projects p where p.id = v_pid;
  if v_proj is not null then v_summary := v_summary || '  (' || v_proj || ')'; end if;

  v_ckey := 'pm:' || v_target::text;
  update notify.outbox
     set edit_count=edit_count+1, summary=v_summary, action=v_action, actor_id=v_actor_id,
         actor_email=v_actor_email, owner_email=v_owner_email, send_after=now()+interval '20 seconds'
   where coalesce_key=v_ckey and status='pending';
  if not found then
    insert into notify.outbox (source, project_id, actor_id, actor_email, owner_email, action, target_type, target_id, target_name, summary, coalesce_key, send_after)
    values ('pm', v_pid, v_actor_id, v_actor_email, v_owner_email, v_action, 'task', v_target, v_title, v_summary, v_ckey, now()+interval '20 seconds');
  end if;
  return null;
exception when others then return null;
end $function$;

CREATE OR REPLACE FUNCTION notify.enqueue_from_comment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_actor_id uuid; v_actor_email text; v_owner_id uuid; v_owner_email text;
        v_task text; v_proj text; v_pid uuid; v_summary text; v_ckey text; v_snip text;
begin
  v_actor_id := coalesce(NEW.author_id, auth.uid());
  select u.email::text into v_actor_email from auth.users u where u.id = v_actor_id;
  select t.title, t.project_id, t.owner_id into v_task, v_pid, v_owner_id from pm.tasks t where t.id = NEW.task_id;
  v_task := coalesce(v_task,'(task)');
  if v_owner_id is not null then select u.email::text into v_owner_email from auth.users u where u.id = v_owner_id; end if;
  select p.name into v_proj from pm.projects p where p.id = v_pid;
  v_snip := left(regexp_replace(coalesce(NEW.body,''), '\s+', ' ', 'g'), 140);
  if NEW.kind::text = 'drawing_review' then v_summary := 'left a drawing review on "'||v_task||'"';
  else v_summary := 'commented on "'||v_task||'"' || case when v_snip<>'' then ': "'||v_snip||'"' else '' end; end if;
  if v_proj is not null then v_summary := v_summary || '  (' || v_proj || ')'; end if;
  v_ckey := 'pm-comment:'||NEW.task_id::text||':'||coalesce(v_actor_id::text,'?');
  update notify.outbox
     set edit_count=edit_count+1, summary=v_summary, action='commented', event_id=NEW.id,
         actor_id=v_actor_id, actor_email=v_actor_email, owner_email=v_owner_email, send_after=now()+interval '20 seconds'
   where coalesce_key=v_ckey and status='pending';
  if not found then
    insert into notify.outbox (source, event_id, project_id, actor_id, actor_email, owner_email, action, target_type, target_id, target_name, summary, coalesce_key, send_after)
    values ('pm', NEW.id, v_pid, v_actor_id, v_actor_email, v_owner_email, 'commented', 'comment', NEW.task_id, v_task, v_summary, v_ckey, now()+interval '20 seconds');
  end if;
  return null;
exception when others then return null;
end $function$;

CREATE OR REPLACE FUNCTION notify.enqueue_from_activity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor_id uuid;
  v_actor    text;
  v_proj     text;
  v_verb     text;
  v_summary  text;
  v_ckey     text;
begin
  if NEW.action::text = 'updated'
     and not (NEW.payload ?| array['status','due_date','owner_id','priority','on_critical_path'])
  then
    return null;
  end if;

  v_actor_id := coalesce(NEW.actor_id, auth.uid());
  select coalesce(nullif(u.raw_user_meta_data->>'display_name',''), u.email::text)
    into v_actor from auth.users u where u.id = v_actor_id;
  v_actor := coalesce(v_actor, 'Someone');

  select p.name into v_proj from pm.projects p where p.id = NEW.project_id;

  v_verb := case NEW.action::text
    when 'created'        then 'created'
    when 'deleted'        then 'deleted'
    when 'completed'      then 'completed'
    when 'status_changed' then 'moved'
    when 'reviewed'       then 'flagged for review'
    when 'linked'         then 'linked'
    when 'unlinked'       then 'unlinked'
    else 'updated' end;

  v_summary := v_actor || ' ' || v_verb || ' ' || coalesce(NEW.target_type,'item')
            || ' "' || coalesce(NEW.target_name,'(untitled)') || '"';
  if NEW.action::text = 'status_changed' and NEW.payload ? 'to' then
    v_summary := v_summary || ' -> ' || (NEW.payload->>'to');
  end if;
  if v_proj is not null then v_summary := v_summary || '  (' || v_proj || ')'; end if;

  v_ckey := 'pm:' || coalesce(NEW.target_id::text, NEW.target_name, NEW.id::text);

  update notify.outbox
     set edit_count = edit_count + 1, summary = v_summary, action = NEW.action::text,
         event_id = NEW.id, actor_id = v_actor_id, send_after = now() + interval '20 seconds'
   where coalesce_key = v_ckey and status = 'pending';
  if not found then
    insert into notify.outbox (source, event_id, project_id, actor_id, action, target_type, target_id, target_name, summary, coalesce_key, send_after)
    values ('pm', NEW.id, NEW.project_id, v_actor_id, NEW.action::text, NEW.target_type, NEW.target_id, NEW.target_name, v_summary, v_ckey, now() + interval '20 seconds');
  end if;
  return null;
exception when others then
  return null;
end $function$;

CREATE OR REPLACE FUNCTION notify.enqueue_from_pdm_audit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor   text;
  v_verb    text;
  v_file    text;
  v_target  text;
  v_summary text;
  v_ckey    text;
  v_fid     uuid;
begin
  if NEW.action = 'cancel_checkout' then return null; end if;  -- transient noise

  select coalesce(nullif(u.raw_user_meta_data->>'display_name',''), u.email::text)
    into v_actor from auth.users u where u.id = NEW.user_id;
  v_actor := coalesce(v_actor, 'Someone');

  -- Resolve a friendly file name when the event references one.
  if NEW.payload ? 'file_id' then
    begin v_fid := (NEW.payload->>'file_id')::uuid; exception when others then v_fid := null; end;
  end if;
  if v_fid is null and NEW.target_type = 'file' then v_fid := NEW.target_id; end if;
  if v_fid is not null then select name into v_file from pdm.files where id = v_fid; end if;
  v_target := coalesce(v_file, NEW.target_type || ' ' || coalesce(NEW.target_id::text,''));

  v_verb := case NEW.action
    when 'check_out'    then 'checked out'
    when 'check_in'     then 'checked in'
    when 'lock'         then 'locked'
    when 'unlock'       then 'unlocked'
    when 'force_unlock' then 'force-unlocked'
    when 'create'       then 'created'
    when 'file_create'  then 'created'
    when 'delete'       then 'deleted'
    when 'file_delete'  then 'deleted'
    when 'rename'       then 'renamed'
    when 'move'         then 'moved'
    when 'restore'      then 'restored'
    else replace(NEW.action, '_', ' ') end;

  v_summary := v_actor || ' ' || v_verb || ' ' || coalesce(v_file, v_target);
  v_ckey := 'vault:' || coalesce(v_fid::text, NEW.target_id::text, NEW.id::text);

  update notify.outbox
     set edit_count = edit_count + 1, summary = v_summary, action = NEW.action,
         send_after = now() + interval '20 seconds'
   where coalesce_key = v_ckey and status = 'pending';
  if not found then
    insert into notify.outbox (source, project_id, actor_id, action, target_type, target_id, target_name, summary, coalesce_key, send_after)
    values ('vault', null, NEW.user_id, NEW.action, NEW.target_type, NEW.target_id, coalesce(v_file, v_target), v_summary, v_ckey, now() + interval '20 seconds');
  end if;
  return null;
exception when others then
  return null;
end $function$;

-- 5. Dispatcher (runs from pg_cron; posts to Slack via net.http_post) --------
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

    v_text := r.summary || case when r.edit_count > 1 then '  (x'||r.edit_count||' edits)' else '' end;
    if r.source = 'vault' then
      v_body := jsonb_build_object('text', v_text);
    else
      v_body := jsonb_build_object('text', v_text,
                                   'actor', coalesce(r.actor_email, v_fallback),
                                   'owner', coalesce(r.owner_email, v_fallback));
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

-- 6. Triggers (the two wired in prod) ---------------------------------------
drop trigger if exists trg_notify_task on pm.tasks;
create trigger trg_notify_task after insert or delete or update on pm.tasks
  for each row execute function notify.enqueue_from_task();

drop trigger if exists trg_notify_comment on pm.task_comments;
create trigger trg_notify_comment after insert on pm.task_comments
  for each row execute function notify.enqueue_from_comment();

-- 7. Dispatcher cron (every 30s). cron.schedule upserts by job name. ---------
select cron.schedule('helios-notify-dispatch', '30 seconds', 'select notify.dispatch();');
