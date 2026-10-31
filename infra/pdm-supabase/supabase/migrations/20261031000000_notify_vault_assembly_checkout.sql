-- Master-assembly check-out bot: post "<name> is ON the assembly!" to a Slack
-- channel when someone checks out a car's master assembly, so the team can see
-- who is working on it. Configured per vault (one vault = one car) in Vault
-- Settings by a vault admin.
--
-- This is a standalone bot. It has its own queue, sender and cron job and does
-- not alter anything the PM and Vault Slack bots use; it only calls the
-- read-only notify.person_name helper. Keep it that way: a problem here must not
-- be able to take those bots down.
--
-- The hook is a trigger on pdm.locks rather than client code so every check-out
-- path fires it: row actions, bulk, folder dialog, add-and-lock, older clients.
--
-- SECRETS: webhook URLs live in Supabase Vault as slack_assembly_url_<vault_id>.
-- pdm.assembly_alert_get only ever reports whether one is set; no RPC returns
-- the URL.

-- 1. Config. Not in an exposed schema, so clients go through the RPCs below.
create table if not exists notify.assembly_alerts (
  vault_id   uuid primary key references pdm.vaults(id) on delete cascade,
  file_id    uuid references pdm.files(id) on delete set null,
  enabled    boolean not null default false,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table notify.assembly_alerts enable row level security;

-- The trigger probes this on every lock insert.
create index if not exists assembly_alerts_enabled_file
  on notify.assembly_alerts (file_id) where enabled;

-- 2. Queue. status: pending -> inflight -> sent | retrying | dead, or skipped.
--    Only 'pending' is in the unique index, so a failed send coming back as
--    'retrying' can never collide with a newer row and abort a dispatch run.
create table if not exists notify.assembly_outbox (
  id              bigint generated always as identity primary key,
  vault_id        uuid        not null,
  lock_id         uuid        not null,
  file_id         uuid        not null,
  user_id         uuid        not null,
  summary         text        not null,
  status          text        not null default 'pending',
  attempts        integer     not null default 0,
  request_id      bigint,
  http_status     integer,
  last_error      text,
  send_after      timestamptz not null default now(),
  next_attempt_at timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);
alter table notify.assembly_outbox enable row level security;

create unique index if not exists assembly_outbox_one_pending
  on notify.assembly_outbox (file_id, user_id) where status = 'pending';
create index if not exists assembly_outbox_due
  on notify.assembly_outbox (status, send_after);

-- 3. Enqueue. Must never block a check-out, hence the swallow-all handler. The
--    20 s delay lets a mis-clicked check-out be undone before anything is sent.
--    Re-checking out inside that window repoints the row at the new lock.
create or replace function notify.enqueue_assembly_checkout()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_vault uuid;
begin
  select a.vault_id into v_vault
    from notify.assembly_alerts a
   where a.file_id = NEW.file_id and a.enabled;
  if not found then return null; end if;

  insert into notify.assembly_outbox (vault_id, lock_id, file_id, user_id, summary, send_after)
  values (v_vault, NEW.id, NEW.file_id, NEW.user_id,
          notify.person_name(NEW.user_id) || ' is ON the assembly!',
          now() + interval '20 seconds')
  on conflict (file_id, user_id) where status = 'pending'
  do update set lock_id = excluded.lock_id, send_after = excluded.send_after;
  return null;
exception when others then return null;
end $function$;

drop trigger if exists trg_notify_assembly_checkout on pdm.locks;
create trigger trg_notify_assembly_checkout after insert on pdm.locks
  for each row execute function notify.enqueue_assembly_checkout();

-- 4. Sender, run by its own cron job.
create or replace function notify.dispatch_assembly_alerts()
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  r record; v_url text; v_req bigint;
begin
  -- Settle sends that Slack has answered.
  update notify.assembly_outbox o
     set status = case when resp.status_code between 200 and 299 then 'sent'
                       when o.attempts >= 5 then 'dead'
                       else 'retrying' end,
         http_status = resp.status_code,
         last_error  = case when resp.status_code between 200 and 299 then null
                            else coalesce(resp.error_msg, 'http '||coalesce(resp.status_code::text,'?')) end,
         sent_at     = case when resp.status_code between 200 and 299 then now() else o.sent_at end,
         send_after  = case when resp.status_code between 200 and 299 then o.send_after
                            else now() + (interval '30 seconds' * power(2, o.attempts)::int) end
    from net._http_response resp
   where o.status = 'inflight' and o.request_id = resp.id;

  -- Sends with no answer after two minutes.
  update notify.assembly_outbox o
     set status = case when o.attempts >= 5 then 'dead' else 'retrying' end,
         last_error = 'no response (stale)',
         send_after = now()
   where o.status = 'inflight' and o.next_attempt_at < now()
     and not exists (select 1 from net._http_response resp where resp.id = o.request_id);

  for r in
    select * from notify.assembly_outbox
     where status in ('pending', 'retrying') and send_after <= now()
     order by send_after limit 8 for update skip locked
  loop
    -- Already checked back in: the message would be false, so don't send it.
    if not exists (select 1 from pdm.locks l where l.id = r.lock_id and l.released_at is null) then
      update notify.assembly_outbox set status='skipped', last_error='lock released before send' where id = r.id;
      continue;
    end if;

    select decrypted_secret into v_url from vault.decrypted_secrets
     where name = 'slack_assembly_url_' || r.vault_id::text limit 1;
    if v_url is null then
      update notify.assembly_outbox set status='dead', last_error='no webhook configured for this vault' where id = r.id;
      continue;
    end if;

    begin
      v_req := net.http_post(url := v_url, body := jsonb_build_object('text', r.summary));
      update notify.assembly_outbox set status='inflight', request_id=v_req, attempts=attempts+1, last_error=null,
             next_attempt_at = now() + interval '2 minutes' where id = r.id;
    exception when others then
      update notify.assembly_outbox set status = case when attempts >= 5 then 'dead' else 'retrying' end,
             attempts = attempts+1, last_error = SQLERRM, send_after = now() + interval '1 minute' where id = r.id;
    end;
  end loop;
end $function$;

select cron.schedule('helios-assembly-alert-dispatch', '30 seconds', 'select notify.dispatch_assembly_alerts();');

-- 5. Settings RPCs (vault admins only).
create or replace function pdm.assembly_alert_get(p_vault_id uuid)
 returns table (enabled boolean, file_id uuid, file_name text, has_webhook boolean)
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
begin
  if not pdm.is_admin_in(p_vault_id) then
    raise exception 'Only a vault admin can view assembly alert settings.' using errcode = '42501';
  end if;
  return query
    select coalesce(a.enabled, false), a.file_id, f.name,
           exists (select 1 from vault.secrets s where s.name = 'slack_assembly_url_' || p_vault_id::text)
      from (select p_vault_id as vault_id) v
      left join notify.assembly_alerts a on a.vault_id = v.vault_id
      left join pdm.files f on f.id = a.file_id;
end $function$;

-- p_webhook_url null/blank keeps the saved webhook. The host is pinned because
-- the sender POSTs to this URL from inside the database.
create or replace function pdm.assembly_alert_set(
  p_vault_id uuid, p_enabled boolean, p_file_id uuid, p_webhook_url text default null)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_url text := nullif(btrim(p_webhook_url), '');
  v_name text := 'slack_assembly_url_' || p_vault_id::text;
  v_secret_id uuid;
begin
  if not pdm.is_admin_in(p_vault_id) then
    raise exception 'Only a vault admin can change assembly alert settings.' using errcode = '42501';
  end if;
  if p_file_id is not null and not exists (
    select 1 from pdm.files f
     where f.id = p_file_id and f.vault_id = p_vault_id and f.deleted_at is null
  ) then
    raise exception 'That file is not in this vault.' using errcode = '22023';
  end if;
  if v_url is not null and v_url !~ '^https://hooks\.slack\.com/[A-Za-z0-9/_-]+$' then
    raise exception 'That does not look like a Slack webhook URL (https://hooks.slack.com/...).' using errcode = '22023';
  end if;

  select s.id into v_secret_id from vault.secrets s where s.name = v_name;
  if p_enabled and p_file_id is null then
    raise exception 'Pick the assembly file before turning alerts on.' using errcode = '22023';
  end if;
  if p_enabled and v_url is null and v_secret_id is null then
    raise exception 'Add a Slack webhook URL before turning alerts on.' using errcode = '22023';
  end if;

  if v_url is not null then
    if v_secret_id is null then
      perform vault.create_secret(v_url, v_name, 'Slack webhook for master-assembly check-out alerts');
    else
      perform vault.update_secret(v_secret_id, v_url);
    end if;
  end if;

  insert into notify.assembly_alerts (vault_id, file_id, enabled, updated_by, updated_at)
  values (p_vault_id, p_file_id, p_enabled, auth.uid(), now())
  on conflict (vault_id) do update
    set file_id = excluded.file_id, enabled = excluded.enabled,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at;
end $function$;

revoke all on function pdm.assembly_alert_get(uuid) from public, anon;
revoke all on function pdm.assembly_alert_set(uuid, boolean, uuid, text) from public, anon;
grant execute on function pdm.assembly_alert_get(uuid) to authenticated;
grant execute on function pdm.assembly_alert_set(uuid, boolean, uuid, text) to authenticated;
