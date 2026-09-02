-- Telemetry pipeline schema. Fully isolated: lives in schema `telemetry`,
-- zero foreign keys to any pdm/pm/games (Vault) object, no Vault grants or
-- policies touched. Reversible: see 20260612200001_telemetry_schema_down
-- companion notes at the bottom (drop schema telemetry cascade).

create schema if not exists telemetry;

-- ── sessions ────────────────────────────────────────────────────────────────
create table telemetry.sessions (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  car         text not null default 'SDM26',
  source      text not null check (source in ('replay', 'synthetic', 'live')),
  started_at  timestamptz,
  ended_at    timestamptz,
  status      text not null default 'created'
              check (status in ('created', 'running', 'ended', 'aborted')),
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

-- ── channel registry (mirror of docs/channels.yaml entries in use) ─────────
create table telemetry.channel_registry (
  id             text primary key,            -- e.g. 'engine.rpm'
  display_name   text not null,
  units          text not null default '',
  "group"        text not null default '',
  sample_rate_hz real not null,
  created_at     timestamptz not null default now()
);

-- ── channel sets (the wire contract; see docs/telemetry-wire-protocol.md) ──
-- definition jsonb shape:
-- { "groups": { "0": { "rate_hz": 10, "channels":
--     [{ "id":"engine.rpm", "enc":"i16fp", "scale":0.25, "offset":0 }, ...] } } }
-- Sets are immutable once used by data; register a new id to change channels.
create table telemetry.channel_sets (
  id          int primary key,                -- channel_set_id on the wire (u16)
  name        text not null,
  car         text not null default 'SDM26',
  definition  jsonb not null,
  created_at  timestamptz not null default now()
);

-- ── staging ring buffer ─────────────────────────────────────────────────────
-- One row per (session, group, 1-second window). payload = Arrow IPC stream
-- record batch for that window (time_us int64 + float64 per channel).
create table telemetry.staging_chunks (
  session_id     uuid not null references telemetry.sessions(id) on delete cascade,
  group_key      smallint not null,
  seq            bigint not null,
  t_start_us     bigint not null,
  channel_set_id int not null,
  payload        bytea not null,
  sample_count   int not null,
  created_at     timestamptz not null default now(),
  compacted_at   timestamptz,
  -- retried uploads dedupe instead of duplicating:
  primary key (session_id, group_key, seq)
);

-- compactor scan: uncompacted rows in arrival order
create index staging_chunks_compaction_scan
  on telemetry.staging_chunks (compacted_at, created_at);

-- ── 1 Hz downsample for web queries (chunked arrays, never row-per-sample) ──
create table telemetry.downsampled_1hz (
  session_id  uuid not null references telemetry.sessions(id) on delete cascade,
  group_key   smallint not null,
  t_start_us  bigint not null,               -- start of the chunk (60 s of 1 Hz rows)
  duration_s  int not null default 60,
  payload     bytea not null,                -- Arrow IPC, 1 sample/s per channel
  created_at  timestamptz not null default now(),
  primary key (session_id, group_key, t_start_us)
);

-- ── events (future Carvis feature/event surface) ────────────────────────────
create table telemetry.events (
  id          bigint generated always as identity primary key,
  session_id  uuid not null references telemetry.sessions(id) on delete cascade,
  t_us        bigint not null,
  severity    text not null default 'info'
              check (severity in ('debug', 'info', 'warn', 'error', 'critical')),
  code        text not null,
  message     text not null default '',
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index events_session_time on telemetry.events (session_id, t_us);

-- ── bench bookkeeping (the dev tool persists its runs + metric series) ──────
create table telemetry.bench_runs (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid references telemetry.sessions(id) on delete set null,
  scenario     text not null,                -- S1..S5 or custom
  config       jsonb not null,
  started_at   timestamptz not null default now(),
  ended_at     timestamptz,
  status       text not null default 'running'
               check (status in ('running', 'passed', 'failed', 'aborted')),
  verdict      jsonb not null default '{}'::jsonb   -- pass/fail per criterion
);

create table telemetry.bench_metrics (
  run_id      uuid not null references telemetry.bench_runs(id) on delete cascade,
  t           timestamptz not null default now(),
  source      text not null,                 -- 'generator' | 'compactor' | 'bench-ui' | 'db-sampler'
  metric      text not null,                 -- e.g. 'staging_depth_rows', 'ack_p95_ms'
  value       double precision not null,
  labels      jsonb not null default '{}'::jsonb
);
create index bench_metrics_run_metric_t on telemetry.bench_metrics (run_id, metric, t);

-- ── RLS: service role writes, authenticated reads ───────────────────────────
-- (service_role bypasses RLS; policies below grant read to authenticated and
-- nothing to anon. No Vault policy is referenced or modified.)
alter table telemetry.sessions         enable row level security;
alter table telemetry.channel_registry enable row level security;
alter table telemetry.channel_sets     enable row level security;
alter table telemetry.staging_chunks   enable row level security;
alter table telemetry.downsampled_1hz  enable row level security;
alter table telemetry.events           enable row level security;
alter table telemetry.bench_runs       enable row level security;
alter table telemetry.bench_metrics    enable row level security;

create policy authenticated_read on telemetry.sessions         for select to authenticated using (true);
create policy authenticated_read on telemetry.channel_registry for select to authenticated using (true);
create policy authenticated_read on telemetry.channel_sets     for select to authenticated using (true);
create policy authenticated_read on telemetry.staging_chunks   for select to authenticated using (true);
create policy authenticated_read on telemetry.downsampled_1hz  for select to authenticated using (true);
create policy authenticated_read on telemetry.events           for select to authenticated using (true);
create policy authenticated_read on telemetry.bench_runs       for select to authenticated using (true);
create policy authenticated_read on telemetry.bench_metrics    for select to authenticated using (true);

-- PostgREST exposure: grant usage/select to the API roles. Writes stay
-- service-role-only. NOTE: service_role bypasses RLS but is NOT the table
-- owner — it still needs explicit table privileges (verified locally:
-- without these every service-role read fails with "permission denied").
grant usage on schema telemetry to authenticated, anon, service_role;
grant select on all tables in schema telemetry to authenticated;
grant select, insert, update, delete on all tables in schema telemetry to service_role;
grant usage on all sequences in schema telemetry to service_role;
alter default privileges in schema telemetry grant select on tables to authenticated;
alter default privileges in schema telemetry grant select, insert, update, delete on tables to service_role;
alter default privileges in schema telemetry grant usage on sequences to service_role;
-- anon gets schema usage but NO table selects (Lite reads run authenticated).

-- NOTE (operational, not in this migration): the `telemetry` schema must be
-- added to the PostgREST exposed schemas list for web reads:
--   local: [api] schemas in supabase/config.toml
--   hosted: Dashboard → Settings → API → Exposed schemas (or management API).

-- ── reversibility ───────────────────────────────────────────────────────────
-- Down: `drop schema telemetry cascade;` removes everything this migration
-- created. Nothing outside the schema is created here.
