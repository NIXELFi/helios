# Sim telemetry storage: bounding what the team keeps

Design, 2026-09-21.

## The problem, and what it is not

Shared sim telemetry is **12 MB across 9 objects**. The Supabase project holds
22 GB of a 100 GB Pro allowance, and almost all of it is PDM CAD. There is no
storage problem today.

There is one term that grows without a ceiling. `telemetryToKeep` keeps the
best three and most recent three runs **per course, per driver** — bounded, and
right, for the three fixed courses. But a generated course is a new `track` id
and the seed is four characters, so there are 1.7M of them and each one gets
its own six-slot allowance. Worse, the first run on a fresh seed is always a
personal best, so every one of them uploads.

The live table shows it exactly:

| track | runs | uploaded telemetry |
|---|---:|---:|
| `autocross` | 10 | 4 (40%) |
| `gen-ax-FJWH` | 2 | 2 (100%) |
| `gen-ax-QYUQ` | 2 | 2 (100%) |
| `gen-en-G2UA` | 1 | 1 (100%) |

On a fixed course the rule throttles to 40%. On generated courses it uploads
everything. Storage then grows with how much the team practises, which is
precisely the thing not to charge people for.

## Measured unit costs

Every shared run so far is a wheel run, and they are consistent: **154 bytes
per sample, gzipped**, across 76 channels at 100 Hz — 0.92 MB per minute of
driving. Non-wheel runs are thinned to 10 Hz before gzip (`thinCsv`), so they
cost roughly a tenth (slightly worse in practice: sparser rows compress less
well, call it a ninth).

| run | wheel | pad/keyboard |
|---|---:|---:|
| autocross lap (~43 s, 4,250 samples) | 0.66 MB | 0.075 MB |
| generated autocross lap (~6,000 samples) | 0.90 MB | 0.10 MB |
| endurance run (~7 min, 42,000 samples) | 6.50 MB | 0.72 MB |

These are the numbers every estimate below rests on, and they are solid — they
come from nine real uploads whose bytes-per-sample agree to within 3%. Three
things resting on top of them are not: `mis` is assumed autocross-length
because no `mis` run has ever been shared, the thinning ratio is taken as a
clean tenth, and every figure for how many people drive and how many seeds they
try is a guess. All of it is one driver's runs extrapolated to a team.

## What we are doing

Four changes. Three are small; the budget job is the only new machinery.

### 1. Prune the build bucket

`feed.json` lists exactly one build per platform and `available_build()` takes
the first match, so Helios has no concept of installing an older version. Every
build except `0.6.6` is already unreferenced: **18 objects, ~126 MB, with
nothing pointing at them.**

Keep the current build plus the previous two per platform. Rollback works by
republishing `feed.json` against an older URL, which only works if the object
still exists — hence two, not zero.

- Windows: keep `0.6.6`, `0.6.4`, `0.6.3`; delete `0.1.0` … `0.6.2` (15
  objects, ~107 MB).
- macOS: only `0.5.7` and `0.6.6` exist; both stay.

One-time cleanup, then the same rule goes into the release script so it does
not regrow. This is independent of everything else and can ship first.

### 2. Generated courses keep best 2 + recent 1

In `telemetryToKeep` (`apps/desktop/src/modules/sim/lib/share.ts`), branch on
`parseGeneratedId(track)` from `../api`:

- fixed courses (`autocross`, `endurance`, `mis`) keep the existing
  `KEEP_BEST = 3` / `KEEP_RECENT = 3`;
- generated seeds keep `GEN_KEEP_BEST = 2` / `GEN_KEEP_RECENT = 1`.

A personal best is usually also the most recent run, so the union is ~2 objects
per seed in practice and 3 at worst — down from 4–6 today.

This halves per-seed cost. It does **not** make the total bounded: cost still
scales with how many seeds a driver tries. That is what change 3 is for.

The two constants are printed in the UI copy (Launch tab, runs table, run
panel) alongside the fixed-course numbers, so the strings need updating in
step with them. The existing code comment on `KEEP_BEST` makes this point; it
now has to say two different things depending on the course.

### 3. A 20 GB budget, enforced server-side

New `sim.enforce_telemetry_budget()`, nightly on pg_cron beside the existing
`helios-ops-daily` job. Reads `sum((metadata->>'size')::bigint)` over
`sim-telemetry`, and while over budget, deletes in the eviction order below.

**Rows are never deleted. Only blobs.** Every run's time stays on the board
permanently. At ~1.3 kB per row, 50,000 runs is 65 MB of database — rows are
free and the history is the thing worth keeping.

**Why 20 GB.** The cap is a number we invent, not a Supabase setting, so unused
headroom costs nothing. 20 GB is a fifth of the plan allowance, leaves the
vault 3x room to grow, and takes the backstop from "will not fire for years" to
"will not fire". It is a safety net, not a workhorse; the generated-course rule
in change 2 is what actually keeps usage low.

**The storage-API gotcha.** `delete from storage.objects` removes the metadata
row but leaves the underlying S3 file. The object then becomes both unreachable
and uncounted, which is worse than leaving it alone. Deletion must go through
the Storage REST API. `pg_net` (0.20.0) and `supabase_vault` (0.3.1) are both
installed; the job calls `POST /storage/v1/object/sim-telemetry` with a
service-role key read from vault. Vault currently holds only the two Slack
secrets, so this adds one: `sim_storage_service_key`.

Deletion is batched and the row update is driven by what the API confirms —
never mark a row's telemetry gone on the strength of a request that was not
acknowledged, or the pointer is lost while the bytes stay.

### 4. The protection floor, and the tombstone that makes it hold

**Never evicted: every driver's best time on `autocross`, `endurance` and
`mis`.** Not a top-N — every driver's own best.

This is bounded by roster size rather than by practice: one object per driver
per fixed course, 7.8 MB for a wheel driver and 0.78 MB for a pad driver.

| | floor |
|---|---:|
| 20 drivers (6 on the rig) | ~58 MB |
| 46 active accounts | ~121 MB |
| all 125 accounts, all three courses | ~310 MB |

Even the absurd case — 125 accounts driving all three courses on wheels — is
975 MB, under 5% of a 20 GB budget.

It also simplifies the design rather than complicating it. Everyone's best
contains the top five, so top-N stops being a separate rule; and because
protection does not depend on device class, there is no wheel-versus-pad slot
competition to arbitrate.

Course revisions need no extra handling. `sim.run_predates_course` already
drops rows for a course that has changed shape, both by trigger and by a
one-time delete, so a stale time cannot be in the table to be protected. If a
fixed course is revised again, that migration's delete is re-run and the
protected set follows automatically.

**The tombstone.** `pushRuns` re-uploads anything in its local keep-set that has
no object. Without a marker, the morning after the budget evicts a ghost the
driver's Helios signs in and puts it straight back, and the bucket oscillates
at the cap forever. Add `evicted_at timestamptz` to `sim.runs`, set by the
budget job, checked by the upload loop. Without this the cap does not hold at
all.

A re-upload should stay possible deliberately — a driver who wants their ghost
back can clear it from the run panel — but never automatically.

### Eviction order

Delete from the top until under budget:

1. Objects held **only** by a recent slot — oldest `started_at` first, on any
   course.
2. Generated-seed best-slot objects, oldest seed first.
3. Fixed-course best-slot objects by depth — every driver's 3rd best, then
   every 2nd best — furthest off that course's record first within a depth.
   (Percentage off the record, not raw lap time: an endurance lap is ~90 s and
   an autocross lap ~43 s, so a global sort by lap time would delete every
   endurance ghost on the system before touching a single autocross one.)
4. **Never:** every driver's best on the three fixed courses.

Generated seeds evict **before** fixed-course extras, not after. A generated
course exists because somebody typed four characters; the 2026 courses are the
layouts the team actually competes on, and a second-best lap on one of those is
worth more than a best lap on a seed nobody will load again. This inverts the
order sketched in discussion, where generated sets were a last-resort tier —
the recency dimension is already handled by rule 1, so what survives into rules
2 and 3 is best-laps only, and among best-laps the fixed courses win.

If rule 4's floor ever exceeded the budget the job would have no legal move. At
310 MB against 20 GB that is not reachable; the job logs and alerts rather than
thrashing if it ever is.

## Capacity

With the new rules, assuming one wheel driver per three pad drivers and four
generated autocross seeds tried per endurance seed:

| drivers (on wheels) | generated seeds each, before eviction runs |
|---|---|
| 16 (4) | 190 endurance + 760 autocross |
| 32 (8) | 94 endurance + 376 autocross |
| 64 (16) | 46 endurance + 184 autocross |
| 128 (32) | 22 endurance + 88 autocross |

At realistic usage — 20 drivers, 6 on the rig, 10 autocross and 2 endurance
seeds a season — the team costs **~560 MB per season**, so roughly 36 seasons
to 20 GB.

The eviction logic will almost certainly never run. It is built anyway, because
the alternative is discovering the unbounded term the expensive way, and
because a cap nobody has tested is not a cap.

## Not doing

- **Best-lap slicing.** Sharing only the fastest lap rather than the whole run
  would cut endurance uploads ~5x and is the single biggest lever left. Not
  needed at these numbers; this is where to go first if it ever is.
- **Parquet / zstd, or rounding CSV fields.** 154 B/sample over 76 float
  columns is ~2 B per value, already decent. Worth measuring before assuming a
  win.
- **50 Hz for shared wheel runs.** 2x, nearly free, unnecessary today.
- **A per-driver ceiling.** With every driver's best protected and the rest
  evicting oldest-first, one driver cannot monopolise the bucket.
- **Deleting SDM25.** 8,688 files, but content-addressed and SDM26 forked from
  it: 15 GB is unique to SDM25 and recoverable, 827 MB is shared and would not
  be freed. Worth doing when the *vault* needs room — at 8–15 GB per season
  that is three or four cars away — and worth exporting to cold storage first.
  It has nothing to do with the sim budget.

## Testing

Unit, in `lib/__tests__/share.test.ts` alongside the existing
`telemetryToKeep` tests:

- a generated seed with five runs keeps 2–3, a fixed course with five keeps 4–6;
- the union behaves when a personal best is also the most recent run;
- a driver's best on a fixed course survives an eviction pass that removes
  everything else of theirs;
- percentage-off-record ordering puts a slow autocross lap ahead of a fast
  endurance one, which raw lap time would not;
- an evicted run is not re-uploaded while `evicted_at` is set, and is once it
  is cleared.

Against a local Supabase (`infra/pdm-supabase`):

- the budget job over a seeded bucket deletes in the documented order and stops
  as soon as it is under;
- a deletion the Storage API did not acknowledge leaves the row's pointer
  intact;
- the job is idempotent — a second run immediately after does nothing;
- the floor-exceeds-budget case alerts instead of looping.

## Rollout

1. Build-bucket prune plus the release-script rule. Independent, ships alone.
2. The `2 + 1` generated rule and UI copy, in a Helios release.
3. Migration: `evicted_at`, `sim.enforce_telemetry_budget()`, the vault secret,
   the cron schedule — scheduled but with the budget set high enough to be
   inert, so the job runs and logs without deleting.
4. Watch a few nightly runs, then set the budget to 20 GB.

Step 3 before step 4 is the point: the first time the job deletes anything
should not also be the first time it runs.
