-- Phase 1j: expand recurring Google Calendar events so weekly meetings show on
-- EVERY date, honoring EXDATE exclusions and RECURRENCE-ID single-instance
-- overrides. The SDM feed is entirely FREQ=WEEKLY; any other FREQ falls back to a
-- single occurrence. America/Phoenix observes no DST, so weekly stepping is plain
-- timestamptz arithmetic. pm.gcal_events now holds one row per OCCURRENCE,
-- rebuilt atomically each sync. Refresh dropped to hourly.

alter table pm.gcal_events drop constraint if exists gcal_events_pkey;
delete from pm.gcal_events;
alter table pm.gcal_events add primary key (uid, starts_at);

create or replace function pm._ics_dow(code text) returns int language sql immutable as $fn$
  select case code when 'SU' then 0 when 'MO' then 1 when 'TU' then 2 when 'WE' then 3
                   when 'TH' then 4 when 'FR' then 5 when 'SA' then 6 else null end;
$fn$;

-- Expand one event into occurrence start-times within [win_start, win_end].
create or replace function pm._gcal_occurrences(
  p_start timestamptz, p_end timestamptz, p_rrule text, p_exdates timestamptz[],
  p_win_start timestamptz, p_win_end timestamptz
) returns setof timestamptz language plpgsql immutable as $fn$
declare
  v_freq text; v_interval int; v_until timestamptz; v_count int; v_bydays text[];
  v_end timestamptz; v_code text; v_dow int; v_d timestamptz; v_emitted int := 0;
begin
  if p_start is null then return; end if;
  if p_rrule is null then
    if p_start between p_win_start and p_win_end then return next p_start; end if;
    return;
  end if;
  v_freq := substring(p_rrule from 'FREQ=([A-Z]+)');
  v_interval := coalesce(nullif(substring(p_rrule from 'INTERVAL=([0-9]+)'), '')::int, 1);
  v_count := nullif(substring(p_rrule from 'COUNT=([0-9]+)'), '')::int;
  if p_rrule ~ 'UNTIL=' then
    v_until := pm._parse_ics_dt('X:' || substring(p_rrule from 'UNTIL=([0-9TZ]+)'));
  end if;
  v_end := least(coalesce(v_until, 'infinity'::timestamptz), p_win_end);

  if v_freq <> 'WEEKLY' then
    if p_start between p_win_start and p_win_end then return next p_start; end if;
    return;
  end if;

  v_bydays := nullif(string_to_array(coalesce(substring(p_rrule from 'BYDAY=([A-Z,]+)'), ''), ','), array['']::text[]);
  if v_bydays is null then
    v_bydays := array[(array['SU','MO','TU','WE','TH','FR','SA'])[extract(dow from p_start at time zone 'America/Phoenix')::int + 1]];
  end if;

  foreach v_code in array v_bydays loop
    v_dow := pm._ics_dow(v_code);
    if v_dow is null then continue; end if;
    -- first on/after p_start with the target Phoenix weekday, same time-of-day
    v_d := p_start + (((v_dow - extract(dow from p_start at time zone 'America/Phoenix')::int) + 7) % 7 || ' days')::interval;
    while v_d <= v_end loop
      if v_d >= p_win_start and v_d >= p_start
         and not (v_d = any(coalesce(p_exdates, array[]::timestamptz[]))) then
        return next v_d;
        v_emitted := v_emitted + 1;
      end if;
      exit when v_count is not null and v_emitted >= v_count;
      v_d := v_d + ((v_interval * 7) || ' days')::interval;
    end loop;
  end loop;
end;
$fn$;

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

  -- atomic rebuild: base/non-recurring occurrences (skipping any with an override)
  delete from pm.gcal_events;
  insert into pm.gcal_events (uid, title, location, description, starts_at, ends_at, all_day, last_synced_at)
  select e.uid, e.title, e.location, e.descr, occ,
         occ + coalesce(e.dtend - e.dtstart, interval '1 hour'), e.all_day, now()
  from _ev e
  cross join lateral pm._gcal_occurrences(e.dtstart, e.dtend, e.rrule, e.exdates, v_win_start, v_win_end) as occ
  where e.recid is null
    and not exists (select 1 from _ev o where o.uid = e.uid and o.recid = occ)
  on conflict (uid, starts_at) do nothing;

  -- modified single instances (overrides) at their new time
  insert into pm.gcal_events (uid, title, location, description, starts_at, ends_at, all_day, last_synced_at)
  select e.uid, e.title, e.location, e.descr, e.dtstart,
         coalesce(e.dtend, e.dtstart + interval '1 hour'), e.all_day, now()
  from _ev e
  where e.recid is not null and e.dtstart between v_win_start and v_win_end
  on conflict (uid, starts_at) do nothing;

  select count(*) into v_n from pm.gcal_events;
  return v_n;
end;
$fn$;

-- hourly refresh
select cron.schedule('gcal-sync', '7 * * * *', $job$ select pm.sync_gcal(); $job$);
