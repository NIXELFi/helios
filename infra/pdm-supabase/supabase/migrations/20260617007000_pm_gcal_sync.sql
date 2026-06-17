-- Phase 1h: pull the team Google Calendar into PM, refreshed every 6h, entirely
-- in Supabase (http extension + pg_cron). The public iCal feed is fetched,
-- parsed (all-day / TZID / UTC), and upserted into pm.gcal_events; the PM
-- calendar reads that table read-only. No external service, no API key.

create extension if not exists http with schema extensions;

create table if not exists pm.gcal_events (
  uid            text primary key,
  title          text,
  location       text,
  description    text,
  starts_at      timestamptz,
  ends_at        timestamptz,
  all_day        boolean not null default false,
  last_synced_at timestamptz not null default now()
);
create index if not exists gcal_events_starts_idx on pm.gcal_events (starts_at);

alter table pm.gcal_events enable row level security;
drop policy if exists gcal_read on pm.gcal_events;
create policy gcal_read on pm.gcal_events for select to authenticated using (true);
grant select on pm.gcal_events to authenticated;

-- Unescape ICS TEXT values (\n \, \; \\).
create or replace function pm._ics_unescape(t text)
returns text language sql immutable as $fn$
  select case when t is null then null
    else replace(replace(replace(replace(t, '\n', E'\n'), '\,', ','), '\;', ';'), '\\', '\')
  end;
$fn$;

-- Parse an ICS DTSTART/DTEND line (incl. its params) to timestamptz.
-- Handles VALUE=DATE (all-day), TZID=..., trailing Z (UTC), and floating local
-- (assumed America/Phoenix, the calendar's tz). Returns NULL on any oddity.
create or replace function pm._parse_ics_dt(p_line text)
returns timestamptz language plpgsql immutable as $fn$
declare v_val text; v_tz text; v_digits text; v_naive timestamp;
begin
  if p_line is null then return null; end if;
  v_val := split_part(p_line, ':', 2);
  if v_val ~* 'TZID=' is not true then null; end if;
  v_tz := substring(p_line from 'TZID=([^:;]+)');
  v_digits := regexp_replace(v_val, '[^0-9]', '', 'g');
  if length(v_digits) < 8 then return null; end if;
  if length(v_digits) = 8 then
    -- date only (all-day): midnight in the calendar's zone
    return make_timestamp(substr(v_digits,1,4)::int, substr(v_digits,5,2)::int, substr(v_digits,7,2)::int, 0,0,0)
           at time zone 'America/Phoenix';
  end if;
  v_naive := make_timestamp(
    substr(v_digits,1,4)::int, substr(v_digits,5,2)::int, substr(v_digits,7,2)::int,
    substr(v_digits,9,2)::int, substr(v_digits,11,2)::int, substr(v_digits,13,2)::int);
  if v_val ~ 'Z$' then return v_naive at time zone 'UTC';
  elsif v_tz is not null then
    begin return v_naive at time zone v_tz; exception when others then return v_naive at time zone 'America/Phoenix'; end;
  else return v_naive at time zone 'America/Phoenix';
  end if;
exception when others then
  return null;
end;
$fn$;

-- Fetch + parse the feed and upsert pm.gcal_events; returns the # of events seen.
create or replace function pm.sync_gcal()
returns integer language plpgsql security definer set search_path = pm, public, extensions as $fn$
declare
  v_url text := 'https://calendar.google.com/calendar/ical/c_9e79b04c7f2e1558ece37f059decb2cf6a3de4c68bfc56c0edf9d4e540790626%40group.calendar.google.com/public/basic.ics';
  v_raw text; v_body text; v_blk text; v_uid text; v_ds text; v_n int := 0;
begin
  select content into v_raw from extensions.http_get(v_url);
  if v_raw is null then return 0; end if;
  -- unfold ICS continuation lines (CRLF + space/tab)
  v_body := regexp_replace(v_raw, E'\r?\n[ \t]', '', 'g');

  create temp table _gcal_seen (uid text) on commit drop;

  for v_blk in
    select (regexp_matches(v_body, 'BEGIN:VEVENT(.*?)END:VEVENT', 'gs'))[1]
  loop
    v_uid := btrim(substring(v_blk from 'UID:([^\r\n]+)'));
    if v_uid is null or v_uid = '' then continue; end if;
    v_ds := substring(v_blk from 'DTSTART[^\r\n]*');
    insert into pm.gcal_events (uid, title, location, description, starts_at, ends_at, all_day, last_synced_at)
    values (
      v_uid,
      pm._ics_unescape(btrim(substring(v_blk from 'SUMMARY:([^\r\n]+)'))),
      pm._ics_unescape(btrim(substring(v_blk from 'LOCATION:([^\r\n]+)'))),
      pm._ics_unescape(btrim(substring(v_blk from 'DESCRIPTION:([^\r\n]+)'))),
      pm._parse_ics_dt(v_ds),
      pm._parse_ics_dt(substring(v_blk from 'DTEND[^\r\n]*')),
      coalesce(v_ds ~ 'VALUE=DATE', false),
      now()
    )
    on conflict (uid) do update set
      title = excluded.title, location = excluded.location, description = excluded.description,
      starts_at = excluded.starts_at, ends_at = excluded.ends_at, all_day = excluded.all_day,
      last_synced_at = now();
    insert into _gcal_seen values (v_uid);
    v_n := v_n + 1;
  end loop;

  -- drop events that disappeared from the feed
  delete from pm.gcal_events g where not exists (select 1 from _gcal_seen s where s.uid = g.uid);
  return v_n;
end;
$fn$;

-- Refresh every 6 hours (and reschedule idempotently by job name).
select cron.schedule('gcal-sync', '7 */6 * * *', $job$ select pm.sync_gcal(); $job$);
