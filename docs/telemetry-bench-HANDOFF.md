# Telemetry Pipeline + Bench Harness — Session Handoff

**Date:** 2026-06-12, 1:45 PM MST · **Branch:** `feat/telemetry-pipeline` ·
**Author:** Claude session on Nick's Windows machine (no Docker — see §2)

The task: build the cellular telemetry ingest pipeline (schema → edge
function → staging → parquet compaction) in the shared Supabase project, plus
a benchmark dev tool that drives synthetic/replayed telemetry through the
full production path and measures everything, Vault impact included. The full
original prompt's requirements are restated in condensed actionable form in
§5 so this doc stands alone.

> **VERIFICATION UPDATE (2026-06-12, Mac, local Docker stack):** §3 steps 2–4
> are DONE. Both migrations + seed apply cleanly (pg_cron NOTICE path
> confirmed); teardown verified clean after fixing it (storage rows can NOT be
> deleted via SQL — `storage.protect_delete()` trigger — bucket must be
> emptied/deleted via the Storage API first, script now guards on this);
> edge function verified end-to-end (deno tests 12/12, JSON ingest, seq acks,
> idempotent dup detection, HMAC + bearer auth, 401/400/413 paths, staged
> Arrow IPC decodes with apache-arrow JS). Two bugs found and fixed:
> (1) migration granted service_role no table privileges (RLS bypass ≠ table
> grants) — every service-role read/write 500'd; (2) frame.ts expected
> per-channel rate_hz while the seed/migration contract puts it on the group.
> Hosted backup (§3.1): still blocked on `supabase login` (no CLI token on
> this machine either). Operator direction 2026-06-12: Vault data does NOT
> need backup yet (unused, restorable); **PM data backed up locally** via
> PostgREST service-role dump → `~/helios-backups/pm-2026-06-12/` (22 tables,
> 1468 rows, plus OpenAPI schema spec).

## 1. What exists on this branch (authored, NOT yet verified — see update above)

| Artifact | State |
|---|---|
| `docs/telemetry-wire-protocol.md` | **Done.** HTP/1 binary frame spec — header/window layout, f32 + i16fp encodings, GPS ref/delta scheme, seq/ack + retry semantics, HMAC auth, C sketch, worked size math. The contract everything else implements. |
| `infra/telemetry-supabase/supabase/migrations/20260612200000_telemetry_schema.sql` | **Done.** Schema `telemetry`: sessions, channel_registry, channel_sets, staging_chunks (PK `(session_id, group_key, seq)` = idempotency), downsampled_1hz, events, bench_runs, bench_metrics. RLS on everything: authenticated read, service-role write, anon nothing. Zero Vault references. |
| `…20260612200100_telemetry_retention_and_storage.sql` | **Done.** `telemetry.config`, `telemetry.prune_staging()` (1 h retention default), pg_cron schedule guarded by extension presence (compactor prunes as fallback), private bucket `telemetry-sessions` + namespaced read policy. |
| `infra/telemetry-supabase/scripts/gen-seed.mjs` → `supabase/seed.sql` | **Done + run.** Seeds full channel registry from `docs/channels.yaml` (92 rows) and channel set 1 `SDM26-cell-v1`: 38 channels, 3 rate-homogeneous groups (10 Hz fast, 10 Hz GPS f32, 1 Hz thermal). |
| `infra/telemetry-supabase/scripts/teardown.sql` | **Done.** Single-command teardown: cron unschedule → storage policy/objects/bucket → `drop schema telemetry cascade`, with before/after `pg_database_size`. **Test on local stack before ever running hosted.** |
| `infra/telemetry-supabase/supabase/config.toml` | **Done.** Standalone local stack on ports 5433x, `telemetry` in PostgREST exposed schemas. Header comment documents the one-project/two-migration-dirs wrinkle (§4.2). |
| `infra/telemetry-supabase/supabase/functions/telemetry-ingest/` | **Drafted by subagent, unreviewed.** Decodes HTP/1 + JSON fallback, transcodes to Arrow IPC (npm:apache-arrow), upserts staging rows, broadcasts `telemetry:live:{session_id}`, returns seq acks. Has offline deno tests. Review before trusting; treat as a strong first cut. |
| `.gitignore` | `infra/telemetry-supabase/.env`, `bench-results/` added. |

**Nothing has touched the hosted project.** No migration applied, no function
deployed, no bucket created. The Vault is untouched.

## 2. Why work stopped where it did (this machine's gaps)

- **No Docker, no WSL2** → `supabase start` impossible → zero local
  verification ran. Everything in §1 is authored-only.
- **Supabase CLI not authenticated** (no `SUPABASE_ACCESS_TOKEN`, not logged
  in) → hosted push/deploy impossible. Hosted data-plane credentials exist in
  `infra/pdm-supabase/.env` (URL + service-role key) — already gitignored.
- Operator decisions recorded: hosted deploy **deferred**; verification moves
  to the Docker-equipped machine; **no backup currently exists** — taking one
  is step zero over there (§3).

## 3. FIRST ACTIONS on the Docker machine (in order)

1. **Back up the hosted project before anything else.** No backup exists.
   ```sh
   supabase login
   cd infra/pdm-supabase
   # Direct connection string: Dashboard → Settings → Database. Then:
   supabase db dump --linked -f ../../backups/pre-telemetry-roles.sql --role-only
   supabase db dump --linked -f ../../backups/pre-telemetry-schema.sql
   supabase db dump --linked -f ../../backups/pre-telemetry-data.sql --data-only --use-copy
   ```
   Also record the baseline: `select pg_size_pretty(pg_database_size(current_database()));`
   and per-schema sizes (query in §5.4). Verify the dumps are non-empty and
   restorable (`psql` them into a scratch local db) before any hosted write.
   Keep `backups/` outside the repo or gitignore it — it contains team data.
2. `supabase start` from `infra/telemetry-supabase` → `supabase db reset`
   (applies both migrations + seed) → confirm tables, RLS, bucket, and that
   the pg_cron guard takes the NOTICE path (local images lack pg_cron by
   default).
3. Run teardown against local; confirm clean removal and size return.
4. Reset again, `supabase functions serve telemetry-ingest`, review the
   edge function draft, run its deno tests, then POST the JSON-fallback curl
   from its README and confirm a staging row + broadcast frame.
5. Only then continue building §5. Hosted apply comes much later (§4).

## 4. Hosted-apply decisions already made (don't relitigate without reason)

1. **Same Supabase project as the Vault** — that's the point of the impact
   measurement. Spend cap stays ON. If quota blocks a run: stop, report,
   never work around.
2. **Migration-history wrinkle:** the CLI keeps one migration history per
   project and it currently belongs to `infra/pdm-supabase`. Hosted apply =
   copy `infra/telemetry-supabase/supabase/migrations/*.sql` into
   `infra/pdm-supabase/supabase/migrations/` (timestamps already sort last)
   and `supabase db push` from there. Authoring home remains
   `infra/telemetry-supabase`. (Alternative `psql` + `migration repair`
   documented in that config.toml header.)
3. **PostgREST exposure:** hosted Dashboard → Settings → API → add
   `telemetry` to exposed schemas (web read path for the bench and future
   Helios Lite).
4. **pg_cron:** enable the extension on hosted (Dashboard → Database →
   Extensions) before relying on retention; otherwise compactor fallback
   pruning covers it.
5. **Edge function deploy:** `supabase functions deploy telemetry-ingest`
   from `infra/telemetry-supabase`, secrets via
   `supabase secrets set TELEMETRY_HMAC_KEY=…`.

## 5. Remaining build plan (condensed spec with decisions locked)

### 5.1 `crates/helios-compactor` (Rust bin; add to workspace members)
Loop: scan `staging_chunks` where `compacted_at is null` and
`created_at < now() - settling_delay (5 s)`, group by `(session_id,
group_key)`; when ≥ 60 s pending or session ended: decode payloads via
`helios_arrow::batch_from_ipc`, concat with `arrow::compute::concat_batches`,
write zstd parquet (`parquet` crate, arrow writer) to
`telemetry-sessions/sessions/{session_id}/{group_key}/{seq_first}-{seq_last}.parquet`
via the storage REST API (service role). **Crash-safe:** deterministic object
key from seq range + overwrite-on-retry + only `update … set compacted_at`
after a verified upload (read back Content-Length or parquet footer). Also
writes `downsampled_1hz` chunks (mean per second per channel — document the
aggregation), emits its counters to `bench_metrics` (chunks_compacted,
lag_seconds, bytes_written, compression_ratio, errors), and calls
`telemetry.prune_staging()` each pass when pg_cron is absent. Config via env
+ clap flags. Unit tests: idempotent retry (kill between upload and mark →
re-run converges, no dupes), IPC→parquet roundtrip.

### 5.2 `crates/helios-telemetry-gen` (Rust bin — NOT `helios-bench`, that name is taken by the engine-sim bench)
The reference HTP/1 client (what the ESP32 firmware will copy):
- **Replay:** `helios-csv` parse → map channels onto a channel set → re-emit
  at 1x/5x/10x wall-clock rescaled. Sources are OUTSIDE the repo (samples were
  removed in v3.8.1): `C:\Users\nmurray\Documents\imu-track-reconstruction\data\
  {sdm26_best_accel,kaden_good_gps}.csv` **and**
  `C:\Users\nmurray\Documents\helios-test\CSVS\*.csv` (both sets, operator
  choice). Paths via config file, never committed data.
- **Synthetic:** physically plausible signals (RPM with gear-shift profile,
  GPS looping a closed track at lap pace, first-order thermal lag on temps,
  RPM-correlated pressures, configurable gaussian noise) — compression ratio
  is a measured output, white noise would skew it pessimistic.
- **Chaos wrapper:** drop % (drop the POST), latency + jitter, reorder,
  forced duplicates. Bounded retry queue (32 windows, drop-oldest + counter),
  seq/ack retry exactly per protocol §4.
- **Bandwidth throttles:** named profiles `cat_1` (2 Mbps effective),
  `cat_4` (8 Mbps), each with a `_degraded` variant at 25 %; all configurable;
  **must report** when the channel set doesn't fit the active profile instead
  of silently dropping.
- Unit tests: signal shapes (RPM bounds/shift profile, thermal monotonicity),
  chaos wrapper actually drops/dups/reorders, frame encode→(TS or Rust)
  decode roundtrip, retry-queue bounds.

### 5.3 `apps/telemetry-bench` (Vite + React, reuse `packages/ui`; internal dev tool, never deployed)
Control panel (scenario/source/speed/chaos/window/duration; start/stop/
emergency abort; preflight shows backup ack + per-schema DB size + restore
command and requires typing the project ref to arm). Live view subscribes to
Broadcast `telemetry:live:{id}` with supabase-js, renders value tiles +
strip chart, charts broadcast latency distribution from `send_timestamp_ms`.
Metrics dashboard per the prompt (offered vs acked, ack p50/95/99, broadcast
p50/95/99, **staging depth over time — must plateau**, compaction lag/bytes/
ratio, error timeline). DB impact panel sampled every few seconds via service
role SQL: `pg_database_size`, per-schema `pg_total_relation_size` sums, row/
index sizes, `pg_stat_activity` counts by `application_name` (tag every
component), cache hit ratio, **Vault canary** (realistic `pdm` read, e.g.
files⋈versions⋈locks lookup, every 5 s; baseline p95 vs under-load p95),
quota projection from a config file of Pro-plan quotas (not hardcoded).
Reads must use ONLY web-decodable paths: apache-arrow JS for IPC frames,
hyparquet (or parquet-wasm) if full-res parquet reading is exercised —
this validates the future Helios Lite path as a side effect.
Results: bench_runs + bench_metrics rows, plus self-contained markdown +
raw JSON exported to `bench-results/` (gitignored; commit ONE example from a
local run into `docs/`).

### 5.4 Scenarios + pass criteria (encode in the report generator)
S1 replay 1x curated set, cellular profile, no chaos → integrity exact.
S2 replay 10x unthrottled + synthetic 200 ch/~10 k samples/s → staging
plateaus below cap, compaction lag < 120 s. S3 1x + 20 % drop/300 ms
jitter/5 % dup → integrity exact (zero missing, zero dupes). S4 30 min+
synthetic → no drift (staging, compactor RSS, edge error rate). S5 = S1 +
scripted Vault read/write load + 3 broadcast subscribers → canary under-load
p95 within 10 % of baseline. Broadcast e2e p95 < 500 ms (S1). Cleanliness:
post-teardown DB within 1 % of baseline, zero telemetry objects. Quota: a
season at configured cadence < 50 % of every Pro quota.
Integrity differ: source CSV via `helios-csv` vs downloaded parquet via
`helios-arrow`, scoped to transmitted channels/rates; i16fp exact at
documented resolution, f32 bit-exact; per-channel diff summary.
Per-schema size query for the impact panel & baseline:
```sql
select n.nspname, pg_size_pretty(sum(pg_total_relation_size(c.oid))::bigint)
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r','i','t','m') group by 1 order by 1;
```

### 5.5 Safety rails (non-negotiable, enforce in code)
Writes confined to schema `telemetry`, bucket `telemetry-sessions`, channels
`telemetry:*`, function `telemetry-ingest`. Vault: plain reads only. Hard
caps (configurable defaults): 50 k staging rows, 2 GB parquet/run, 100 k
broadcast msgs/run, max run duration; hitting any cap aborts gracefully and
says so in the report. Auto-abort on DB growth > +1 GB over baseline or
canary p95 degraded > 50 % mid-run. Spend cap stays ON.

## 6. Open questions for the operator
1. Hosted apply path §4.2: copy-into-pdm-migrations (recommended) or
   psql+repair?
2. The edge function draft hardcodes nothing about `downsampled_1hz` — the
   compactor owns 1 Hz downsampling in this design (edge stays stateless).
   Confirm or move it edge-side.
3. `helios-test\CSVS` files are MoTeC exports with 100 Hz data — replay maps
   them down to the 10 Hz wire rates (decimation, not averaging) so the
   integrity differ compares like-for-like. Flag if averaging is preferred.

## 7. Process notes for the next session
Branch from `feat/telemetry-pipeline`, keep commits small/conventional.
`main` had a release (v4.3.7) in flight this session — do not rebase onto
main without checking release status. Run `cargo test` + `pnpm test` before
claiming anything works; do not modify `helios-csv`/`helios-arrow` behavior
(extend additively, with tests). Write `docs/telemetry-bench-RUNBOOK.md`
(operator-facing: backup, env, arm, run scenarios, read report, teardown,
restore) once the bench app exists — this handoff covers the interim.
