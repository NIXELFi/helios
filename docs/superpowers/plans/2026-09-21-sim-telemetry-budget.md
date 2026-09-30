# Sim Telemetry Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound what the sim telemetry bucket keeps — generated courses stop getting a six-slot allowance each, a nightly job holds the bucket under budget, and every driver's best on the 2026 courses is never evicted.

**Architecture:** Four independent changes. Client-side retention (`telemetryToKeep`) learns that generated courses are cheaper. A Postgres function walks a deterministic eviction order and deletes through the Storage REST API using the synchronous `http` extension. An `evicted_at` tombstone stops the client re-uploading what the server just removed. The build publisher prunes its own history.

**Tech Stack:** TypeScript/Vitest (Helios desktop), Postgres 17 + pg_cron + `http` 1.6 + supabase_vault (Supabase), Node ESM (fsae-sim tooling).

**Spec:** `docs/superpowers/specs/2026-09-21-sim-telemetry-budget-design.md`

---

## File Structure

**Helios (`C:\Users\nick5\helios`)**

| File | Responsibility |
|---|---|
| `apps/desktop/src/modules/sim/lib/share.ts` | Modify: per-course-kind retention limits; `evicted_at` in the row type; skip upload when tombstoned |
| `apps/desktop/src/modules/sim/lib/__tests__/share.test.ts` | Modify: tests for generated limits and the tombstone |
| `apps/desktop/src/modules/sim/components/{LaunchPanel,RunDetail,RunsTable}.tsx` | Modify: copy that prints the two numbers |
| `apps/desktop/src/modules/sim/__tests__/SimHome.test.tsx` | Modify: mock gains the two new constants |
| `infra/pdm-supabase/supabase/migrations/20260921100000_sim_telemetry_budget.sql` | Create: `evicted_at`, config + log tables, eviction-order view, `enforce_telemetry_budget()`, cron schedule |

**fsae-sim (`C:\Users\nick5\fsae-sim`)**

| File | Responsibility |
|---|---|
| `sim/tools/publish_build.mjs` | Modify: export `buildsToDelete()`, prune after publish, add `--prune-only` |
| `sim/tools/test_publish_prune.mjs` | Create: unit test for `buildsToDelete()` |
| `sim/package.json` | Modify: add the new test to the `test` script |

---

## Task 1: Generated courses keep best 2 + recent 1

**Files:**
- Modify: `apps/desktop/src/modules/sim/lib/share.ts`
- Test: `apps/desktop/src/modules/sim/lib/__tests__/share.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `share.test.ts`, inside the `describe` that already holds the
`telemetryToKeep` tests (it defines helpers `r`, `at`, `localRun`):

```ts
  it("keeps only best two and latest one on a generated course", () => {
    const g = (id: string, best: number, hour: number) =>
      r(id, best, hour, { track: "gen-ax-K7Q2", trackName: "Generated autocross K7Q2" });
    const runs = [g("a", 44, 1), g("b", 41, 2), g("c", 43, 3), g("d", 42, 4), g("e", 45, 5)];
    // best 2 by time: b (41), d (42). recent 1 by clock: e.
    expect(telemetryToKeep(runs, "me")).toEqual(new Set(["b", "d", "e"]));
    expect(GEN_KEEP_BEST).toBe(2);
    expect(GEN_KEEP_RECENT).toBe(1);
  });

  it("applies the fixed-course rule and the generated rule side by side", () => {
    const runs = [
      r("ax1", 41, 1), r("ax2", 42, 2), r("ax3", 43, 3), r("ax4", 44, 4),
      r("g1", 51, 5, { track: "gen-en-QYUQ" }), r("g2", 52, 6, { track: "gen-en-QYUQ" }),
      r("g3", 53, 7, { track: "gen-en-QYUQ" }), r("g4", 54, 8, { track: "gen-en-QYUQ" }),
    ];
    const keep = telemetryToKeep(runs, "me");
    // autocross: best 3 = ax1,ax2,ax3; recent 3 = ax4,ax3,ax2 -> all four.
    expect(keep.has("ax1")).toBe(true);
    expect(keep.has("ax4")).toBe(true);
    // generated: best 2 = g1,g2; recent 1 = g4. g3 is in neither.
    expect(keep.has("g1")).toBe(true);
    expect(keep.has("g2")).toBe(true);
    expect(keep.has("g4")).toBe(true);
    expect(keep.has("g3")).toBe(false);
  });

  it("is bounded by the generated constants on a generated course", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      r(`r${i}`, 40 + i, i % 24, { track: "gen-ax-ZZZZ" }));
    expect(telemetryToKeep(many, "me").size).toBeLessThanOrEqual(GEN_KEEP_BEST + GEN_KEEP_RECENT);
  });
```

Extend the existing import at the top of the file:

```ts
import {
  GEN_KEEP_BEST, GEN_KEEP_RECENT, KEEP_BEST, KEEP_RECENT,
  rowStamp, rowToRun, telemetryToKeep, thinCsv,
} from "../share";
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /c/Users/nick5/helios/apps/desktop && pnpm vitest run src/modules/sim/lib/__tests__/share.test.ts
```

Expected: FAIL — `GEN_KEEP_BEST` is not exported.

- [ ] **Step 3: Add the constants and branch the rule**

In `share.ts`, directly after the existing `KEEP_RECENT` declaration:

```ts
/**
 * The same two numbers for a PROCEDURAL course, which is a different kind of
 * thing and has to be paid for differently.
 *
 * A generated course is named by its seed -- four characters, so 1.7M of them
 * -- and the rule above is per course. That made the bound a bound on courses
 * rather than on storage: every fresh seed opened a new six-slot allowance,
 * and because the first run on a course nobody has driven is always a personal
 * best, every one of those runs uploaded. The live table showed it plainly --
 * fixed courses uploading 40% of runs, generated courses 100%.
 *
 * Two and one rather than three and three. A seed is somewhere you went once:
 * worth a ghost to race and a look at the last lap you threw away, not worth a
 * history. In practice the two sets overlap and it is nearer two objects than
 * three.
 */
export const GEN_KEEP_BEST = 2;
export const GEN_KEEP_RECENT = 1;
```

Add `parseGeneratedId` to the existing import from `../api`:

```ts
import {
  deviceClass, isRankable, parseGeneratedId, predatesCourse, runBest, type SimRun,
} from "../api";
```

Inside `telemetryToKeep`, replace the body of the `for (const list of byCourse.values())` loop's
slicing so the limits come from the course kind. The loop currently reads
`byCourse.values()`; change it to iterate entries so the track id is in hand:

```ts
  const keep = new Set<string>();
  for (const [track, list] of byCourse) {
    // A procedural course is bounded more tightly than a fixed one. See
    // `GEN_KEEP_BEST`.
    const generated = parseGeneratedId(track) !== null;
    const nBest = generated ? GEN_KEEP_BEST : KEEP_BEST;
    const nRecent = generated ? GEN_KEEP_RECENT : KEEP_RECENT;

    const ranked = list
      .filter((r) => isRankable(r) && runBest(r) != null)
      .sort((a, b) => (runBest(a) as number) - (runBest(b) as number));
    for (const r of ranked.slice(0, nBest)) keep.add(r.runId);

    const withALap = list
      .filter((r) => (r.stats.laps ?? 0) > 0)
      .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
    for (const r of withALap.slice(0, nRecent)) keep.add(r.runId);
  }
  return keep;
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd /c/Users/nick5/helios/apps/desktop && pnpm vitest run src/modules/sim/lib/__tests__/share.test.ts
```

Expected: PASS, including the pre-existing fixed-course tests unchanged.

- [ ] **Step 5: Commit**

```bash
cd /c/Users/nick5/helios
git add apps/desktop/src/modules/sim/lib/share.ts apps/desktop/src/modules/sim/lib/__tests__/share.test.ts
git commit -m "Sim: a generated course keeps two laps and a look back, not six"
```

---

## Task 2: The copy that prints those numbers

**Files:**
- Modify: `apps/desktop/src/modules/sim/components/LaunchPanel.tsx:198`
- Modify: `apps/desktop/src/modules/sim/components/RunDetail.tsx:25-26,235-239`
- Modify: `apps/desktop/src/modules/sim/components/RunsTable.tsx:487`
- Modify: `apps/desktop/src/modules/sim/__tests__/SimHome.test.tsx:50-51`

The rule is now two rules, and three places in the UI state it as one. Each
prints `KEEP_BEST` and `KEEP_RECENT` inline, so each needs to say which courses
it is talking about.

- [ ] **Step 1: Update `SimHome.test.tsx`'s mock**

At lines 50-51 the mock of `../lib/share` supplies the constants. Add the two
new ones so the module's consumers keep type-checking:

```ts
  KEEP_BEST: 3,
  KEEP_RECENT: 3,
  GEN_KEEP_BEST: 2,
  GEN_KEEP_RECENT: 1,
```

- [ ] **Step 2: Update `LaunchPanel.tsx`**

Import the new constants alongside the old:

```ts
import { GEN_KEEP_BEST, GEN_KEEP_RECENT, KEEP_BEST, KEEP_RECENT } from "../lib/share";
```

Replace the sentence at line 198:

```tsx
          {KEEP_BEST} and latest {KEEP_RECENT} on each course ({GEN_KEEP_BEST} and{" "}
          {GEN_KEEP_RECENT} on a generated one) &mdash; older laps are removed
```

- [ ] **Step 3: Update `RunsTable.tsx`**

Import the new constants, then replace the sentence at line 487:

```tsx
        itself is uploaded only for your best {KEEP_BEST} and latest {KEEP_RECENT} on each
        fixed course, and your best {GEN_KEEP_BEST} and latest {GEN_KEEP_RECENT} on a
        generated one
```

- [ ] **Step 4: Update `RunDetail.tsx`**

Import the new constants. Replace the doc comment at lines 25-26:

```ts
  /**
   * The team keeps the lap for a driver's best `KEEP_BEST` and latest
   * `KEEP_RECENT` runs per fixed course, and `GEN_KEEP_BEST` / `GEN_KEEP_RECENT`
   * per generated one; the rest share their time only.
   */
```

Replace the three strings at 235-239 so they read the limits from the run's own
course. Add this helper above the component:

```ts
/** What this run's course costs: generated courses are bounded more tightly. */
function limitsFor(track: string): { best: number; recent: number; kind: string } {
  return parseGeneratedId(track) !== null
    ? { best: GEN_KEEP_BEST, recent: GEN_KEEP_RECENT, kind: "generated course" }
    : { best: KEEP_BEST, recent: KEEP_RECENT, kind: "course" };
}
```

Import `parseGeneratedId` from `../api`, then inside the component take
`const lim = limitsFor(run.track);` and use it:

```tsx
                  ? `time and lap — one of your best ${lim.best} or latest ${lim.recent} on this ${lim.kind}`
                  : `time only — the lap is kept here; only your best ${lim.best} and latest ${lim.recent} per ${lim.kind} go up`
```

```tsx
                `Every run's time is shared with the team. The lap itself is uploaded for your best ${lim.best} and latest ${lim.recent} runs on this ${lim.kind}, and removed from the team's copy as newer or quicker ones replace it. Nothing is removed from this machine.`
```

- [ ] **Step 5: Typecheck and run the sim tests**

```bash
cd /c/Users/nick5/helios/apps/desktop && pnpm typecheck && pnpm vitest run src/modules/sim
```

Expected: no type errors, all sim tests pass.

- [ ] **Step 6: Commit**

```bash
cd /c/Users/nick5/helios
git add apps/desktop/src/modules/sim
git commit -m "Sim: say which courses keep six laps and which keep three"
```

---

## Task 3: The `evicted_at` tombstone in the client

**Files:**
- Modify: `apps/desktop/src/modules/sim/lib/share.ts`
- Test: `apps/desktop/src/modules/sim/lib/__tests__/share-sync.test.ts`

Without this the cap cannot hold: `pushRuns` re-uploads anything in its
keep-set with no object, so the morning after the budget evicts a ghost the
driver's Helios puts it straight back.

- [ ] **Step 1: Write the failing test**

Append to `share-sync.test.ts` (it already builds a fake Supabase client; reuse
whatever factory the neighbouring tests use — the assertion is what matters):

```ts
  it("does not re-upload a run the budget evicted", async () => {
    // The server removed this lap to stay under budget and stamped the row.
    // The keep rule still wants it -- that is exactly the oscillation the
    // tombstone exists to stop.
    const run = localRun({ runId: "r1", startedAt: "2026-09-20T10:00:00Z" });
    const client = fakeClient({
      rows: [{ ...rowFor(run), telemetry_object: null, evicted_at: "2026-09-21T03:00:00Z" }],
    });
    const readTelemetry = vi.fn(async () => new TextEncoder().encode("time_s\n0\n"));
    const out = await pushRuns(client, "me", [run], readTelemetry);
    expect(out.telemetryPushed).toBe(0);
    expect(readTelemetry).not.toHaveBeenCalled();
  });

  it("uploads again once the tombstone is cleared", async () => {
    const run = localRun({ runId: "r1", startedAt: "2026-09-20T10:00:00Z" });
    const client = fakeClient({
      rows: [{ ...rowFor(run), telemetry_object: null, evicted_at: null }],
    });
    const readTelemetry = vi.fn(async () => new TextEncoder().encode("time_s\n0\n"));
    const out = await pushRuns(client, "me", [run], readTelemetry);
    expect(out.telemetryPushed).toBe(1);
  });
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /c/Users/nick5/helios/apps/desktop && pnpm vitest run src/modules/sim/lib/__tests__/share-sync.test.ts
```

Expected: FAIL — the first test uploads anyway (`telemetryPushed` is 1).

- [ ] **Step 3: Carry the column through**

In `share.ts`, add to the `RunRow` interface after `telemetry_bytes`:

```ts
  /** Set by the nightly budget job when it removed this run's lap. See
   *  `SharedState.evictedAt`. Null for every run whose lap is still up, and
   *  for every run whose lap was never worth uploading. */
  evicted_at: string | null;
```

Add to `SharedState`:

```ts
interface SharedState {
  telemetryObject: string | null;
  /**
   * When the server took this run's lap away to stay under budget.
   *
   * The retention rule is a rule about what a DRIVER should keep, and it does
   * not know what the bucket costs; the budget is a rule about the bucket, and
   * it does not care whose lap it is. Left to themselves they fight: the job
   * deletes the object at three in the morning, the rule still wants it, and
   * the next sign-in uploads it again -- for ever, at whatever the cap is.
   *
   * So the server says so, and the client believes it. Not permanent: clearing
   * the column shares the lap again, which is what the run panel's button
   * does. The rule is "do not put back what was deliberately removed", not
   * "never again".
   */
  evictedAt: string | null;
  stamp: string;
  run: SimRun;
}
```

In `sharedRowsFor`, populate it:

```ts
    out.set(r.run_id, {
      telemetryObject: r.telemetry_object,
      evictedAt: r.evicted_at ?? null,
      stamp: rowStamp(r),
      run: rowToRun(r),
    });
```

In `pushRuns`, build a tombstone set beside `objectOf` (after the `objectOf`
loop):

```ts
  // Runs whose lap the budget job removed. See `SharedState.evictedAt`.
  const evicted = new Set<string>();
  for (const [runId, s] of already) if (s.evictedAt) evicted.add(runId);
```

and in the upload loop, immediately after the `wantTelemetry` check:

```ts
    if (!wantTelemetry.has(run.runId)) continue;
    if (evicted.has(run.runId)) continue;
    if (objectOf.get(run.runId)) continue;
```

The sweep at the end of `pushRuns` must not collect on behalf of a tombstoned
run either — it already only removes objects no row points at, and an evicted
run's object is gone, so no change is needed there.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd /c/Users/nick5/helios/apps/desktop && pnpm vitest run src/modules/sim && pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /c/Users/nick5/helios
git add apps/desktop/src/modules/sim
git commit -m "Sim: do not put back the lap the budget deliberately removed"
```

---

## Task 4: The migration — config, eviction order, and the job

**Files:**
- Create: `infra/pdm-supabase/supabase/migrations/20260921100000_sim_telemetry_budget.sql`

Ships **inert**: the budget is seeded absurdly high so the job runs, logs, and
deletes nothing. Task 6 lowers it to 20 GB once a few nightly runs look right.

- [ ] **Step 1: Write the migration**

```sql
-- 20260921100000_sim_telemetry_budget.sql
--
-- Helios Sim module — a ceiling on what the team's telemetry costs.
--
-- The retention rule in the client (`telemetryToKeep`) is a rule about what a
-- DRIVER keeps: best three and latest three per course, best two and latest
-- one on a generated one. It is the right rule and it is not a ceiling. It
-- runs only where a driver is signed in, so a member who graduates leaves
-- their objects behind for ever; and it is per course, so it bounds a course
-- rather than a bucket.
--
-- This is the other half: one job, judging the bucket, deleting in an order
-- that is written down.
--
-- ROWS ARE NEVER DELETED. Only blobs. A time stays on the board permanently --
-- at 1.3 kB a row, fifty thousand runs is 65 MB, and the history is the part
-- worth keeping. What goes is the replay, which is megabytes.

-- =============================================================================
-- THE TOMBSTONE
-- =============================================================================
--
-- Without it the cap cannot hold. `pushRuns` uploads anything in its keep set
-- with no object, so a lap deleted at three in the morning is back at the next
-- sign-in and the bucket oscillates at the cap for ever. The client reads this
-- column and declines. Clearing it shares the lap again, deliberately.

alter table sim.runs add column if not exists evicted_at timestamptz;

-- =============================================================================
-- CONFIG AND LOG
-- =============================================================================

create table if not exists sim.telemetry_budget (
  id            integer primary key default 1,
  -- Seeded far above anything reachable so the job is INERT on arrival: it
  -- runs, it logs what it would do, it deletes nothing. Lowered to 20 GB by a
  -- later migration once a few nightly runs have been read. The first time
  -- this job deletes something should not also be the first time it runs.
  budget_bytes  bigint not null,
  -- Where the storage API lives. Not in vault: it is not a secret, and a
  -- config row is the place somebody will look for it.
  base_url      text   not null,
  -- Belt and braces against a mistake in a later migration: a budget below
  -- this is refused rather than applied, because a budget of zero would
  -- delete every evictable lap the team has on its first run.
  floor_bytes   bigint not null default 1073741824,
  updated_at    timestamptz not null default now(),
  constraint telemetry_budget_singleton check (id = 1),
  constraint telemetry_budget_sane check (budget_bytes >= floor_bytes)
);

insert into sim.telemetry_budget (id, budget_bytes, base_url)
values (1, 1125899906842624, 'https://dlmyixonuyckxkknolku.supabase.co')
on conflict (id) do nothing;

create table if not exists sim.telemetry_budget_log (
  id            bigserial primary key,
  ran_at        timestamptz not null default now(),
  bytes_before  bigint not null,
  bytes_after   bigint not null,
  budget_bytes  bigint not null,
  deleted       integer not null default 0,
  note          text
);

create index if not exists idx_sim_budget_log_ran on sim.telemetry_budget_log (ran_at desc);

-- =============================================================================
-- THE ORDER
-- =============================================================================
--
-- Every shared object, with the tier that decides when it goes and the keys
-- that order it within that tier. Read top to bottom, delete until under.
--
--   1  in no keep set at all -- the client should have pruned it and did not
--   2  held only by a RECENT slot: the lap you threw away, on any course
--   3  a generated course's best laps, oldest SEED first
--   4  a fixed course's second and third best, worst first
--   -  a driver's BEST on a fixed course: never, at any tier
--
-- Generated seeds go before fixed-course extras, not after. Tier 2 has already
-- taken the recency dimension, so what survives into 3 and 4 is best-laps; and
-- among best-laps a second-best on the 2026 autocross course is worth more
-- than the best lap on a seed somebody typed once and will not load again.
--
-- Tier 4 orders by PERCENTAGE OFF THAT COURSE'S RECORD, not by lap time. An
-- endurance lap is ~90 s and an autocross lap ~43 s, so a global sort by raw
-- time would delete every endurance ghost on the system before touching one
-- autocross lap.

create or replace view sim.telemetry_eviction_order as
with shared as (
  select
    r.run_id, r.user_id, r.track, r.started_at, r.best_lap_s,
    r.telemetry_object, coalesce(r.telemetry_bytes, 0) as bytes,
    (r.track like 'gen-a%' or r.track like 'gen-e%') as generated,
    -- The same predicate the client's `isRankable` applies, so the two agree
    -- about which laps are benchmarks.
    (not r.synthetic
     and r.best_lap_s is not null
     and not coalesce((r.assists->>'traction')::boolean, false)
     and not coalesce((r.assists->>'abs')::boolean, false)
     and not coalesce((r.assists->>'autoShift')::boolean, false)) as rankable
  from sim.runs r
  where r.telemetry_object is not null
),
ranked as (
  select s.*,
    case when s.rankable then
      row_number() over (
        partition by s.user_id, s.track
        order by case when s.rankable then s.best_lap_s end nulls last, s.run_id)
    end as best_rank,
    row_number() over (
      partition by s.user_id, s.track
      order by s.started_at desc nulls last, s.run_id desc) as recent_rank,
    min(case when s.rankable then s.best_lap_s end) over (partition by s.track) as course_record,
    min(s.started_at) over (partition by s.track) as seed_first_seen
  from shared s
),
classed as (
  select r.*,
    (r.best_rank is not null
      and r.best_rank <= case when r.generated then 2 else 3 end) as in_best,
    (r.recent_rank <= case when r.generated then 1 else 3 end) as in_recent
  from ranked r
)
select
  c.run_id, c.user_id, c.track, c.telemetry_object, c.bytes,
  c.started_at, c.best_lap_s, c.best_rank, c.generated,
  case
    when not c.generated and c.best_rank = 1 then 0   -- never
    when not c.in_best and not c.in_recent  then 1
    when c.in_recent and not c.in_best      then 2
    when c.generated                        then 3
    else                                          4
  end as tier,
  c.seed_first_seen,
  case when c.course_record > 0
       then (c.best_lap_s / c.course_record) - 1 end as pct_off_record
from classed c;

comment on view sim.telemetry_eviction_order is
  'Every shared telemetry object with the tier and keys that decide when it is '
  'deleted. Tier 0 is never evicted: a driver''s best on a fixed course.';

-- =============================================================================
-- THE JOB
-- =============================================================================
--
-- SYNCHRONOUS deletes, via the `http` extension rather than `pg_net`. The
-- pointer and the bytes have to agree: marking a row's lap gone on the
-- strength of a request nobody acknowledged loses the pointer while the object
-- stays, and then nothing can reach it -- the download reads the pointer and
-- so does every prune. `http` returns the status in the same statement, so the
-- row is only marked for a delete that actually happened.
--
-- DELETING FROM storage.objects DIRECTLY WOULD NOT DO. It removes the metadata
-- row and leaves the file in S3: unreachable AND uncounted, which is worse
-- than leaving it alone. The Storage API is the only thing that removes both.

create extension if not exists http with schema extensions;

create or replace function sim.enforce_telemetry_budget(p_dry_run boolean default false)
returns sim.telemetry_budget_log
language plpgsql
security definer
set search_path = sim, storage, extensions, vault, public
as $$
declare
  cfg        sim.telemetry_budget;
  v_key      text;
  v_before   bigint;
  v_total    bigint;
  v_deleted  int := 0;
  v_note     text := null;
  v_batch    text[];
  v_ids      text[];
  v_freed    bigint;
  v_status   int;
  v_body     text;
  v_log      sim.telemetry_budget_log;
begin
  select * into cfg from sim.telemetry_budget where id = 1;
  if cfg is null then
    raise exception 'sim.telemetry_budget has no row';
  end if;

  select coalesce(sum((metadata->>'size')::bigint), 0) into v_before
    from storage.objects where bucket_id = 'sim-telemetry';
  v_total := v_before;

  if v_total <= cfg.budget_bytes then
    insert into sim.telemetry_budget_log (bytes_before, bytes_after, budget_bytes, deleted, note)
    values (v_before, v_total, cfg.budget_bytes, 0, 'under budget')
    returning * into v_log;
    return v_log;
  end if;

  select decrypted_secret into v_key
    from vault.decrypted_secrets where name = 'sim_storage_service_key';
  if v_key is null and not p_dry_run then
    insert into sim.telemetry_budget_log (bytes_before, bytes_after, budget_bytes, deleted, note)
    values (v_before, v_total, cfg.budget_bytes, 0,
            'OVER BUDGET and cannot act: vault has no sim_storage_service_key')
    returning * into v_log;
    return v_log;
  end if;

  -- In batches, because the Storage API takes a list and one round trip per
  -- object would be thousands of them.
  loop
    exit when v_total <= cfg.budget_bytes;

    select array_agg(telemetry_object order by ord),
           array_agg(run_id order by ord),
           sum(bytes)
      into v_batch, v_ids, v_freed
    from (
      select e.run_id, e.telemetry_object, e.bytes,
             row_number() over (
               order by e.tier,
                        -- tier 1 and 2: oldest first
                        case when e.tier in (1, 2) then e.started_at end asc nulls first,
                        -- tier 3: oldest SEED first, then oldest run in it
                        case when e.tier = 3 then e.seed_first_seen end asc nulls first,
                        case when e.tier = 3 then e.started_at end asc nulls first,
                        -- tier 4: third best before second best, worst first
                        case when e.tier = 4 then e.best_rank end desc nulls last,
                        case when e.tier = 4 then e.pct_off_record end desc nulls last,
                        e.run_id
             ) as ord
      from sim.telemetry_eviction_order e
      where e.tier > 0
    ) q
    where ord <= 100;

    if v_batch is null or array_length(v_batch, 1) = 0 then
      v_note := format(
        'OVER BUDGET with nothing left to evict: %s bytes are protected best laps, '
        'budget is %s. Raise the budget or revisit the protection rule.',
        v_total, cfg.budget_bytes);
      exit;
    end if;

    if p_dry_run then
      v_deleted := v_deleted + array_length(v_batch, 1);
      v_total := v_total - coalesce(v_freed, 0);
      v_note := coalesce(v_note, '') || format('dry run: would delete %s objects; ', array_length(v_batch, 1));
      continue;
    end if;

    select status, content into v_status, v_body
      from extensions.http((
        'DELETE',
        cfg.base_url || '/storage/v1/object/sim-telemetry',
        array[
          extensions.http_header('authorization', 'Bearer ' || v_key),
          extensions.http_header('apikey', v_key)
        ],
        'application/json',
        json_build_object('prefixes', v_batch)::text
      )::extensions.http_request);

    if v_status is distinct from 200 then
      -- Say nothing to the rows. The objects are still there; the pointers
      -- still reach them; the next run tries again.
      v_note := format('storage delete failed: HTTP %s %s', v_status, left(coalesce(v_body, ''), 300));
      exit;
    end if;

    -- Only now, and only for what the API acknowledged.
    update sim.runs
       set telemetry_object = null,
           telemetry_bytes  = null,
           evicted_at       = now()
     where run_id = any (v_ids);

    v_deleted := v_deleted + array_length(v_batch, 1);
    v_total := v_total - coalesce(v_freed, 0);
  end loop;

  insert into sim.telemetry_budget_log (bytes_before, bytes_after, budget_bytes, deleted, note)
  values (v_before, v_total, cfg.budget_bytes, v_deleted, v_note)
  returning * into v_log;
  return v_log;
end;
$$;

-- Nobody but the scheduler. The function reads a service-role key out of
-- vault; `security definer` plus a public grant would hand every signed-in
-- member a way to delete the team's telemetry.
revoke all on function sim.enforce_telemetry_budget(boolean) from public;
revoke all on function sim.enforce_telemetry_budget(boolean) from authenticated;

-- The log is worth reading from the app; the config is not worth writing from
-- it, and the view exposes every driver's objects.
grant select on sim.telemetry_budget_log to authenticated;

-- Nightly, twenty minutes after the ops snapshot so the two do not overlap.
select cron.unschedule('sim-telemetry-budget')
  where exists (select 1 from cron.job where jobname = 'sim-telemetry-budget');
select cron.schedule('sim-telemetry-budget', '30 0 * * *',
                     $cron$select sim.enforce_telemetry_budget();$cron$);
```

- [ ] **Step 2: Apply it to a local Supabase and check it parses**

```bash
cd /c/Users/nick5/helios/infra/pdm-supabase && npx supabase db reset
```

Expected: every migration applies, including this one, with no error.

- [ ] **Step 3: Check the view returns nothing surprising on an empty table**

```bash
cd /c/Users/nick5/helios/infra/pdm-supabase && npx supabase db reset >/dev/null 2>&1 && psql "$(npx supabase status -o json | node -e 'process.stdin.once("data",d=>console.log(JSON.parse(d).DB_URL))')" -c "select * from sim.telemetry_eviction_order;" -c "select (sim.enforce_telemetry_budget(true)).*;"
```

Expected: zero rows from the view; one log row reading `under budget`.

- [ ] **Step 4: Commit**

```bash
cd /c/Users/nick5/helios
git add infra/pdm-supabase/supabase/migrations/20260921100000_sim_telemetry_budget.sql
git commit -m "Sim: a ceiling on what the team's telemetry costs, inert on arrival"
```

---

## Task 5: Prune the build bucket

**Files:**
- Modify: `C:\Users\nick5\fsae-sim\sim\tools\publish_build.mjs`
- Create: `C:\Users\nick5\fsae-sim\sim\tools\test_publish_prune.mjs`
- Modify: `C:\Users\nick5\fsae-sim\sim\package.json`

`feed.json` carries one entry per platform and `available_build()` takes the
first match, so Helios cannot install an older version. 18 objects (~126 MB)
are already unreferenced. Keep current + 2 for rollback-by-republishing-feed.

- [ ] **Step 1: Write the failing test**

Create `sim/tools/test_publish_prune.mjs`, matching the plain-node style of the
neighbouring `test_*.mjs` files:

```js
// Which old builds a publish retires.
import assert from "node:assert/strict";
import { buildsToDelete, KEEP_BUILDS } from "./publish_build.mjs";

const names = (v) => v.map((x) => `windows/${x}/fsae-sim.exe`);

// Newest three survive; everything older goes.
assert.deepEqual(
  buildsToDelete(names(["0.1.0", "0.2.0", "0.5.7", "0.6.3", "0.6.4", "0.6.6"]), "windows"),
  names(["0.1.0", "0.2.0", "0.5.7"]),
  "keeps the newest three by version order",
);

// Version order, not lexical: 0.10.0 is newer than 0.9.0.
assert.deepEqual(
  buildsToDelete(names(["0.9.0", "0.10.0", "0.11.0", "0.2.0"]), "windows"),
  names(["0.2.0"]),
  "compares versions numerically",
);

// Fewer than the keep count: nothing goes.
assert.deepEqual(
  buildsToDelete(names(["0.6.4", "0.6.6"]), "windows"),
  [],
  "nothing to prune when there is nothing spare",
);

// Another platform's objects are none of this platform's business.
assert.deepEqual(
  buildsToDelete(
    [...names(["0.1.0", "0.2.0", "0.5.7", "0.6.6"]), "macos/0.1.0/fsae-sim", "feed.json"],
    "windows",
  ),
  names(["0.1.0"]),
  "only touches this platform, and never the feed",
);

assert.equal(KEEP_BUILDS, 3);
console.log("test_publish_prune: ok");
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /c/Users/nick5/fsae-sim && node sim/tools/test_publish_prune.mjs
```

Expected: FAIL — `buildsToDelete` is not exported.

- [ ] **Step 3: Implement the pruner**

`publish_build.mjs` does its work at import time — top-level `await
ensureBucket()` and the rest — so importing it from a test would publish a
build. The pure rule therefore lives in its own module.

Create `sim/tools/build_retention.mjs`:

```js
/**
 * How many builds per platform stay in the bucket.
 *
 * The feed carries ONE entry per platform and Helios takes the first match for
 * its own, so it cannot be asked for an older version: every build but the
 * current one is already unreachable through the app. They are kept anyway,
 * and only a few, because rollback is republishing the feed against an older
 * url -- which works only while the object is still there. Three is the
 * current build and two to fall back to.
 */
export const KEEP_BUILDS = 3;

/** `0.10.0` sorts above `0.9.0`; a version that is not numeric sorts oldest. */
function versionKey(v) {
  const parts = String(v).split("-")[0].split(".").map((n) => Number.parseInt(n, 10));
  return parts.every((n) => Number.isFinite(n)) ? parts : [-1];
}

function compareVersions(a, b) {
  const [x, y] = [versionKey(a), versionKey(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Which objects to retire, given everything in the bucket and a platform.
 *
 * Pure, and exported, so the rule can be tested without a network or a key --
 * this is the one function here that deletes things, and it is the one that
 * must not be got wrong.
 */
export function buildsToDelete(objectNames, platform) {
  const mine = [];
  for (const name of objectNames) {
    const m = new RegExp(`^${platform}/([^/]+)/[^/]+$`).exec(name);
    if (m) mine.push({ name, version: m[1] });
  }
  mine.sort((a, b) => compareVersions(b.version, a.version));
  return mine.slice(KEEP_BUILDS).map((b) => b.name);
}
```

Then, in `publish_build.mjs`, import it beside the existing imports:

```js
import { buildsToDelete } from "./build_retention.mjs";
```

- [ ] **Step 4: Run it to verify it passes**

```bash
cd /c/Users/nick5/fsae-sim && node sim/tools/test_publish_prune.mjs
```

Expected: `test_publish_prune: ok`

- [ ] **Step 5: Wire the prune into publishing**

In `publish_build.mjs`, add a lister and a deleter beside `upload`:

```js
/** Everything in the bucket, as object names. */
async function listObjects(prefix = "") {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`, apikey: KEY, "Content-Type": "application/json",
    },
    body: JSON.stringify({ prefix, limit: 1000, sortBy: { column: "name", order: "asc" } }),
  });
  if (!res.ok) throw new Error(`list ${BUCKET}: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  // The list API is one level at a time: a row with no id is a folder.
  const out = [];
  for (const row of rows) {
    const name = prefix ? `${prefix}/${row.name}` : row.name;
    if (row.id == null) out.push(...(await listObjects(name)));
    else out.push(name);
  }
  return out;
}

async function removeObjects(names) {
  if (!names.length) return;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${KEY}`, apikey: KEY, "Content-Type": "application/json",
    },
    body: JSON.stringify({ prefixes: names }),
  });
  if (!res.ok) throw new Error(`delete from ${BUCKET}: ${res.status} ${await res.text()}`);
}
```

After the feed read-back block near the end, before the final `console.log`s:

```js
// Retire what the feed can no longer reach. See KEEP_BUILDS.
try {
  const stale = buildsToDelete(await listObjects(), PLATFORM);
  if (stale.length) {
    console.log(`\npruning ${stale.length} old ${PLATFORM} build(s):`);
    for (const s of stale) console.log(`        ${s}`);
    if (!has("no-prune")) await removeObjects(stale);
    else console.log("        --no-prune: left in place");
  }
} catch (err) {
  // A publish that worked must not report failure because the tidy-up did not.
  console.warn(`\n(could not prune old builds: ${err?.message ?? err})`);
}
```

Add a `--prune-only` mode near the top of the script body, right after
`ensureBucket()`, so the one-time cleanup can be run without publishing:

```js
if (has("prune-only")) {
  const stale = buildsToDelete(await listObjects(), PLATFORM);
  console.log(`${stale.length} old ${PLATFORM} build(s) to retire:`);
  for (const s of stale) console.log(`  ${s}`);
  if (DRY) { console.log("--dry-run: nothing deleted."); process.exit(0); }
  await removeObjects(stale);
  console.log(`retired ${stale.length} object(s).`);
  process.exit(0);
}
```

`--prune-only` needs `--version` not to be required. Move the `--version`
checks below the `prune-only` block, or pass `--version 0.0.0` when using it;
prefer moving the checks.

- [ ] **Step 6: Add the test to the suite**

In `sim/package.json`, append to the `test` script:

```
 && node tools/test_publish_prune.mjs
```

- [ ] **Step 7: Run the whole fsae-sim suite**

```bash
cd /c/Users/nick5/fsae-sim/sim && npm test
```

Expected: every test passes, ending with `test_publish_prune: ok`.

- [ ] **Step 8: Commit**

```bash
cd /c/Users/nick5/fsae-sim
git add sim/tools/build_retention.mjs sim/tools/test_publish_prune.mjs sim/tools/publish_build.mjs sim/package.json
git commit -m "publish: keep the current build and two, not every build ever"
```

---

## Task 6: Deploy

Each step is a real action against the live project
(`dlmyixonuyckxkknolku`). They are ordered so that nothing deletes anything
until something has been watched not deleting anything.

- [ ] **Step 1: Dry-run the build prune against production**

```bash
cd /c/Users/nick5/fsae-sim
SUPABASE_URL=https://dlmyixonuyckxkknolku.supabase.co SUPABASE_SERVICE_KEY=<service key> \
  node sim/tools/publish_build.mjs --prune-only --platform windows --dry-run
```

Expected: lists exactly 15 objects, `windows/0.1.0/...` through
`windows/0.6.2/...`, and keeps `0.6.3`, `0.6.4`, `0.6.6`.

- [ ] **Step 2: Run it for real**

Same command without `--dry-run`. Then confirm, expecting 3 Windows objects,
2 macOS objects and `feed.json` — about 47 MB total:

```sql
select name, pg_size_pretty((metadata->>'size')::bigint)
from storage.objects where bucket_id = 'sim' order by name;
```

- [ ] **Step 3: Confirm the feed still installs**

```bash
curl -s https://dlmyixonuyckxkknolku.supabase.co/storage/v1/object/public/sim/feed.json
curl -sI "$(curl -s https://dlmyixonuyckxkknolku.supabase.co/storage/v1/object/public/sim/feed.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).builds.find(b=>b.platform==="windows").url))')" | head -1
```

Expected: the feed names 0.6.6 for both platforms; the Windows url returns
`HTTP/2 200`.

- [ ] **Step 4: Put the service-role key in vault**

Get it from the dashboard (Project Settings → API → `service_role`), then:

```sql
select vault.create_secret(
  '<service role key>',
  'sim_storage_service_key',
  'Storage deletes for sim.enforce_telemetry_budget'
);
```

- [ ] **Step 5: Apply the migration**

Push `20260921100000_sim_telemetry_budget.sql` to the live project. Confirm the
job is scheduled and inert:

```sql
select jobname, schedule, active from cron.job where jobname = 'sim-telemetry-budget';
select budget_bytes, base_url from sim.telemetry_budget;
```

- [ ] **Step 6: Dry-run the job by hand**

```sql
select (sim.enforce_telemetry_budget(true)).*;
```

Expected: `deleted = 0`, note `under budget` — the seeded budget is 1 PB.

- [ ] **Step 7: Check the order says something sensible about real data**

```sql
select tier, count(*), pg_size_pretty(sum(bytes))
from sim.telemetry_eviction_order group by tier order by tier;
```

Expected: every current object in tier 0 or 2 (one driver, few runs). No object
should be missing from the view — the count must equal
`select count(*) from sim.runs where telemetry_object is not null`.

- [ ] **Step 8: Let it run two nights, then read the log**

```sql
select ran_at, pg_size_pretty(bytes_before), deleted, note
from sim.telemetry_budget_log order by ran_at desc limit 5;
```

Expected: one `under budget` row per night, `deleted = 0`.

- [ ] **Step 9: Set the real budget**

```sql
update sim.telemetry_budget set budget_bytes = 21474836480, updated_at = now() where id = 1;
```

- [ ] **Step 10: Rotate the personal access token**

The `sbp_` management token used during this work is in a chat transcript.
Revoke it at https://supabase.com/dashboard/account/tokens.

---

## Verification

- `cd apps/desktop && pnpm typecheck && pnpm vitest run src/modules/sim` — clean.
- `cd /c/Users/nick5/fsae-sim/sim && npm test` — clean.
- `sim` bucket holds 6 objects, ~47 MB.
- `sim.telemetry_budget_log` has rows and `deleted = 0` in all of them.
- `select count(*) from sim.telemetry_eviction_order where tier = 0` is greater
  than zero — the protection rule is actually protecting something.
