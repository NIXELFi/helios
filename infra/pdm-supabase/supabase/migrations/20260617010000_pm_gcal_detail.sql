-- Phase 1k: support the calendar event detail view + safer deletes.
--  * add is_recurring so the UI can label repeating events.
--  * guard the atomic rebuild: if a sync ever parses ZERO events (feed hiccup),
--    keep the existing rows instead of wiping the calendar. Genuine deletions
--    still propagate — a removed event simply isn't in the next full rebuild.

alter table pm.gcal_events add column if not exists is_recurring boolean not null default false;

create or replace function pm.sync_gcal()
returns integer language plpgsql security definer set search_path = pm, public, extensions as $fn$
declare
  v_url text := 'https://calendar.google.com/calendar/ical/c_9e79b04c7f2e1558ece37f059decb2cf6a3de4c68bfc56c0edf9d4e540790626%40group.calendar.google.com/public/basic.ics';
  v_raw text; v_body text; v_blk text; v_uid text; v_ds text; v_n int := 0;
  v_win_start timestamptz := now() - interval '60 days';
  v_win_end   timestamptz := now() + interval '365 days';
begin
  select content into v_raw from extensions.http_get(v_url);
  if v_raw is null then return 0; end if;
  v_body := regexp_replace(v_raw, E'\r?\n[ \t]', '', 'g');

  create temp table _ev (
    uid text, recid timestamptz, title text, location text, descr text,
    dtstart timestamptz, dtend timestamptz, rrule text, exdates timestamptz[], all_day boolean
  ) on commit drop;

  for v_blk in select (regexp_matches(v_body, 'BEGIN:VEVENT(.*?)END:VEVENT', 'gs'))[1] loop
    v_uid := btrim(substring(v_blk from 'UID:([^\r\n]+)'));
    if v_uid is null or v_uid = '' then continue; end if;
    v_ds := substring(v_blk from 'DTSTART[^\r\n]*');
    insert into _ev values (
      v_uid,
      case when v_blk ~ 'RECURRENCE-ID' then pm._parse_ics_dt(substring(v_blk from 'RECURRENCE-ID[^\r\n]*')) end,
      pm._ics_unescape(btrim(substring(v_blk from 'SUMMARY:([^\r\n]+)'))),
      pm._ics_unescape(btrim(substring(v_blk from 'LOCATION:([^\r\n]+)'))),
      pm._ics_unescape(btrim(substring(v_blk from 'DESCRIPTION:([^\r\n]+)'))),
      pm._parse_ics_dt(v_ds),
      pm._parse_ics_dt(substring(v_blk from 'DTEND[^\r\n]*')),
      substring(v_blk from 'RRULE:([^\r\n]+)'),
      (select coalesce(array_agg(pm._parse_ics_dt('X:' || btrim(val))) filter (where btrim(val) <> ''), array[]::timestamptz[])
         from regexp_matches(v_blk, 'EXDATE[^:\r\n]*:([^\r\n]+)', 'g') as r(arr),
              lateral unnest(string_to_array(r.arr[1], ',')) as val),
      coalesce(v_ds ~ 'VALUE=DATE', false)
    );
  end loop;

  -- Safety: never wipe the calendar on an empty/failed parse.
  if (select count(*) from _ev) = 0 then return 0; end if;

  delete from pm.gcal_events;
  insert into pm.gcal_events (uid, title, location, description, starts_at, ends_at, all_day, is_recurring, last_synced_at)
  select e.uid, e.title, e.location, e.descr, occ,
         occ + coalesce(e.dtend - e.dtstart, interval '1 hour'), e.all_day, e.rrule is not null, now()
  from _ev e
  cross join lateral pm._gcal_occurrences(e.dtstart, e.dtend, e.rrule, e.exdates, v_win_start, v_win_end) as occ
  where e.recid is null
    and not exists (select 1 from _ev o where o.uid = e.uid and o.recid = occ)
  on conflict (uid, starts_at) do nothing;

  insert into pm.gcal_events (uid, title, location, description, starts_at, ends_at, all_day, is_recurring, last_synced_at)
  select e.uid, e.title, e.location, e.descr, e.dtstart,
         coalesce(e.dtend, e.dtstart + interval '1 hour'), e.all_day, true, now()
  from _ev e
  where e.recid is not null and e.dtstart between v_win_start and v_win_end
  on conflict (uid, starts_at) do nothing;

  select count(*) into v_n from pm.gcal_events;
  return v_n;
end;
$fn$;

select pm.sync_gcal();
