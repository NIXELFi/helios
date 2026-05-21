# CFD Tab — Phase 1 Design

**Date:** 2026-05-21
**Status:** ready for implementation planning
**Target repo:** `github.com/NIXELFi/helios` on branch `feat/engine-sim-rust-port`
**Predecessor spec:** [2026-05-20-engine-sim-rust-port-design.md](2026-05-20-engine-sim-rust-port-design.md)
**Reference upstream (read-only, outside repo):** `github.com/NIXELFi/1dFVEngineSolver` @ `research/low-rpm-iteration`

## Goal

Add a new top-level tab to the Helios desktop app — "CFD" — that exposes the
`engine-sim` Rust crate to the user as an interactive simulator. Phase 1 ships
the foundation: tab scaffold, load configs from disk, run a single-RPM
simulation with streaming progress + cancellation, and render the resulting
per-cycle stats.

The crate's math has already been proven identical to the Python upstream to
≤ 1e-6 rtol / 1e-9 atol at the engine-cycle level (see the predecessor spec).
Phase 1 must preserve that guarantee end-to-end, including across the new
Tauri command boundary.

## Phase decomposition (context only)

This spec covers **Phase 1**. The CFD tab will eventually host five phases;
they are listed here so Phase 1 architecture decisions do not box later
phases out:

| Phase | Scope |
| --- | --- |
| 1 (this spec) | Tab scaffold, load configs, single-RPM run, streaming progress + cancel, cycle-stats table + basic charts |
| 2 | Full SDM26Config form-based editor, save/load, validation, "new from template", diff vs. upstream config |
| 3 | Post-cycle visualization: multi-RPM sweep driver + sweep view, per-cylinder P-V loops, per-pipe end-of-cycle profiles, config-vs-config comparison |
| 4 | Live per-step flow viz: streaming pipe-state during a run, x-t waterfalls, animated network view, playback |
| 5 | Parameter sensitivity (tornado) and optimization studies |

Each future phase gets its own brainstorm → spec → plan cycle.

## Scope

In scope (Phase 1):

- New "cfd" entry in `ModuleId` + `ModulePicker` button
- New module at `apps/desktop/src/modules/cfd/`
- Three internal screens (Config, Studies, Results) selected via a Vault-style NavRail
- Local-file persistence (no Supabase / auth gate); `lastConfigPath` + recent study headers in localStorage
- Two bundled example configs (SDM25 and SDM26) shipped as Tauri resources
- Four Tauri commands and a five-event stream (see Section 2)
- A background-thread runner that drives `SDM26Engine` cycle-by-cycle, supports cancellation, and detects convergence
- 27 new parity fixtures + Rust tests in the `engine-sim` crate (Section 6)
- 3 narrow Rust tests in the desktop crate proving the runner does not perturb the math
- React + vitest tests on the module (state transitions, screens, charts)

Out of scope (deferred to later phases):

- Config editing
- Multi-RPM sweeps and sweep visualization
- Per-cylinder P-V loops, per-pipe end-of-cycle profiles
- Live per-step flow visualization, x-t waterfalls, animated network view
- Parameter sensitivity, optimization
- Saving / loading completed studies to disk
- Supabase / auth integration
- Tauri end-to-end integration tests (manual smoke gate covers Phase 1)

## Section 1 — Architecture overview

### The "studies" model

The unit of work is a *study*. Phase 1 ships one study kind (`single-rpm`);
later phases add `sweep`, `optimization`, and `comparison`. Every part of the
architecture is structured around this taxonomy so adding a study kind is
additive, not refactor-heavy.

```ts
type StudyKind = "single-rpm" | "sweep" | "optimization";  // Phase 1: only single-rpm
type StudyStatus = "idle" | "running" | "cancelling" | "done" | "cancelled" | "error";

interface StudyBase {
  id: string;            // ulid
  kind: StudyKind;
  status: StudyStatus;
  configPath: string;    // source on disk
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

interface SingleRpmStudy extends StudyBase {
  kind: "single-rpm";
  params: {
    rpm: number;
    nCyclesMax: number;
    junctionKind: "stagnation" | "characteristic";
    convergenceTolImep: number;
    convergenceMinCycles: number;
  };
  cycles: CycleStats[];   // streams in as the job runs
  result?: {
    convergedCycle: number;
    nCyclesRun: number;
    stepCount: number;
  };
}

type Study = SingleRpmStudy /* | SweepStudy | OptimizationStudy in later phases */;
```

### Module structure

```
apps/desktop/src/modules/cfd/
├── index.tsx                    — module entry, renders <CfdHome>
├── CfdHome.tsx                  — owns CfdContext, NavRail + active screen
├── state/
│   └── CfdContext.tsx           — React context: loadedConfig, studies map,
│                                  activeStudyId, activeScreen, mutators,
│                                  Tauri event listener registration
├── components/
│   ├── NavRail.tsx              — data-driven entries array (Config / Studies / Results)
│   ├── charts/
│   │   └── CycleChart.tsx       — uPlot wrapper, generic (xField, yField, series)
│   └── path/
│       └── PathLabel.tsx        — basename + tooltip full path
├── screens/
│   ├── ConfigScreen.tsx         — read-only config summary + Open/Load Example
│   ├── StudiesScreen.tsx        — studies table + New Study kind picker
│   └── ResultsScreen.tsx        — dispatches on study.kind
├── results/
│   └── SingleRpmResults.tsx     — Phase 1 result renderer
├── lib/
│   ├── sdm26Schema.ts           — SDM26Config TS type + field metadata
│   │                              (units, labels, ranges) — drives the
│   │                              read-only summary now, the Phase 2 editor later
│   └── cfdStorage.ts            — versioned localStorage I/O
└── __tests__/
    ├── fakes/
    │   ├── tauri.ts             — invoke + listen fake
    │   └── study.ts             — Study, CycleStats, LoadedConfig factories
    ├── CfdContext.test.tsx
    ├── ConfigScreen.test.tsx
    ├── StudiesScreen.test.tsx
    ├── SingleRpmResults.test.tsx
    └── NavRail.test.tsx
```

### Tab wiring

- `apps/desktop/src/shell/ModulePicker.tsx`: add `"cfd"` to `ModuleId` union and a button entry alongside Logs and Vault.
- `apps/desktop/src/Shell.tsx`: no logic change — its mount-once / toggle-visibility pattern handles the new entry automatically.

### State management choice

React context scoped to the CFD module (matches Vault's pattern of local
state + hooks). No Zustand store yet. If Phase 2's editor introduces enough
cross-screen state to make context messy, promote then; don't pre-optimize.

### NavRail extensibility

`NavRail.tsx` reads its entries from a data structure, not hardcoded JSX. The
screen registry is `Record<NavId, FC>`. Future phases plug in new entries
(e.g., "Sweep", "Optimization", "Compare") without touching NavRail's
internals.

## Section 2 — Tauri command surface + sim driver

### Rust module layout

```
apps/desktop/src-tauri/src/cfd/
├── mod.rs                   — re-exports commands + CfdState
├── state.rs                 — CfdState { jobs: Mutex<HashMap<JobId, JobHandle>> }
├── commands.rs              — the four commands below
├── runner.rs                — worker-thread loop driving SDM26Engine
└── dto.rs                   — serde-derived DTOs (LoadedConfig, ExampleConfig,
                               StartJobRequest, JobEvent payloads)
```

Wired into `apps/desktop/src-tauri/src/lib.rs` alongside the existing
`load_csv` and `helios_relaunch` commands. `CfdState` is registered via
`.manage(CfdState::default())`.

### Commands

```rust
#[tauri::command]
fn cfd_load_config(path: String) -> Result<LoadedConfig, String>;
// reads JSON via engine_sim::config::loader::load_v1_json; returns
// LoadedConfig { path, cfg: SDM26ConfigDto, summary: ConfigSummary }

#[tauri::command]
fn cfd_list_examples(app: tauri::AppHandle) -> Vec<ExampleConfig>;
// returns bundled sdm25 + sdm26 with resolved resource paths

#[tauri::command]
fn cfd_start_job(
    window: tauri::Window,
    state: tauri::State<CfdState>,
    request: StartJobRequest,
) -> Result<StartJobResponse, String>;     // { job_id: String }

#[tauri::command]
fn cfd_cancel_job(state: tauri::State<CfdState>, job_id: String) -> Result<(), String>;

#[tauri::command]
fn cfd_list_jobs(state: tauri::State<CfdState>) -> Vec<JobSummary>;
// rehydration hook: lets the frontend recover after HMR / remount
```

`StartJobRequest` is a discriminated union, keyed by `kind`:

```rust
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum StartJobRequest {
    SingleRpm {
        config_path: String,
        params: SingleRpmParams,
    },
    // Sweep { ... }           // Phase 3
    // Optimization { ... }    // Phase 5
}
```

### Event stream

Five Tauri events. Payload shape varies per kind only on the `progress` /
`done` channels:

| Event | Payload |
| --- | --- |
| `cfd:job-started` | `{ job_id, kind, started_at }` |
| `cfd:job-progress` | `{ job_id, kind, payload }` — for single-rpm: `{ cycle, total, cycle_stats }` |
| `cfd:job-done` | `{ job_id, kind, payload }` — for single-rpm: `{ converged_cycle, n_cycles_run, step_count }` |
| `cfd:job-cancelled` | `{ job_id }` |
| `cfd:job-error` | `{ job_id, error, reason: "config-load" | "solver-diverged" | "panic" | "other", partial_cycles? }` |

`CfdContext` subscribes once at mount, routes by `job_id`, merges into the
right `Study`. The contract is stable across study kinds — only `progress` /
`done` payloads change.

### Runner loop

`SDM26Engine` is not `Send`, so the runner thread owns it from construction
to drop. Cancellation is checked between cycles via an `AtomicBool` in the
`JobHandle`.

```rust
fn run_single_rpm_job(
    window: tauri::Window,
    job_id: JobId,
    config_path: PathBuf,
    params: SingleRpmParams,
    cancel: Arc<AtomicBool>,
) {
    emit_started(&window, &job_id, "single-rpm");

    let cfg = match engine_sim::config::loader::load_v1_json(&config_path) {
        Ok(c) => c,
        Err(e) => return emit_error(&window, &job_id, "config-load", e.to_string(), &[]),
    };

    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
        let mut eng = SDM26Engine::new(cfg, params.junction_kind.into());
        let mut accumulated: Vec<CycleStats> = Vec::new();
        for cycle_i in 0..params.n_cycles_max {
            if cancel.load(Ordering::Relaxed) {
                return RunOutcome::Cancelled(accumulated);
            }
            // Drive ONE 720° cycle so we can stream progress + check cancel.
            let r = eng.run_single_rpm(
                params.rpm, 1, false,
                params.convergence_tol_imep, params.convergence_min_cycles,
                /* stop_at_convergence = */ false,
            );
            let cs = r.cycle_stats.last().cloned().expect("one cycle");
            if !cycle_stats_finite(&cs) {
                accumulated.push(cs.clone());
                return RunOutcome::Diverged(accumulated, cycle_i);
            }
            accumulated.push(cs.clone());
            emit_progress_single_rpm(&window, &job_id, cycle_i + 1, params.n_cycles_max, &cs);
            if check_convergence(&accumulated, &params) {
                return RunOutcome::Converged(accumulated, cycle_i);
            }
        }
        RunOutcome::Completed(accumulated)
    }));

    match result {
        Ok(RunOutcome::Completed(cs)) => emit_done_single_rpm(&window, &job_id, build_summary(&cs, None)),
        Ok(RunOutcome::Converged(cs, c)) => emit_done_single_rpm(&window, &job_id, build_summary(&cs, Some(c))),
        Ok(RunOutcome::Cancelled(_))    => emit_cancelled(&window, &job_id),
        Ok(RunOutcome::Diverged(cs, c)) => emit_error(&window, &job_id, "solver-diverged",
            format!("non-finite at cycle {c}"), &cs),
        Err(panic) => emit_error(&window, &job_id, "panic", format_panic(panic), &[]),
    }
}
```

The single-cycle-at-a-time loop is the cost of cancellation + progress
streaming. The engine struct lives across iterations (no rebuild). Cost is
small (one `run_single_rpm(.., n_cycles=1, ..)` call ≡ advancing 720° in the
existing crate). Convergence detection runs in Rust so we can stop early and
still report partial cycles to the UI.

### Bundled configs

Committed at
`apps/desktop/src-tauri/resources/cfd/configs/sdm25.json` and `sdm26.json`,
copied verbatim from `crates/engine-sim/python_ref/configs/`. Declared in
`tauri.conf.json` under `bundle.resources`. `cfd_list_examples` resolves
them via `app.path().resource_dir()`.

### Why a discriminated union over per-kind commands

Centralizing on one `cfd_start_job` keeps lifecycle management (event
routing, state tracking, cancellation, rehydration) uniform across study
kinds. The alternative (one command per kind) duplicates lifecycle logic and
forces the frontend to know which command goes with which study type — the
opposite of the extensibility we want.

## Section 3 — The three screens

### ConfigScreen

Layout: header strip (loaded config path + `Open…` / `Load Example ▾` /
`Reveal in Folder`), then a read-only summary grouped into collapsible
sections.

- **Open…** uses `@tauri-apps/plugin-dialog`'s `open({ filters: [{ name: "Engine config", extensions: ["json"] }] })`, then `invoke<LoadedConfig>("cfd_load_config", { path })`. On success → `CfdContext.setLoadedConfig` and persist path to localStorage. On error → inline error banner (no `window.alert`, per the no-browser-dialogs rule).
- **Load Example ▾** is a dropdown driven by `cfd_list_examples`. Each entry has a name + brief description.
- **Empty state** (no config loaded): centered card with the two action buttons.
- **Summary sections** (from `sdm26Schema.ts`, label/value grid with units):
  - Engine: bore, stroke, conrod, CR, n_cylinders, firing_order, firing_interval
  - Combustion: wiebe_a/m, duration, spark advance, ignition delay, η_comb, q_LHV, AFR target
  - Intake: restrictor (Ø, Cd), plenum V, intake valve (Ø, max lift, open/close angles), runner array (length, Ø, n_points, wall_T) — one row per runner
  - Exhaust: exhaust valve, primaries array, secondaries array, collector
  - Ambient & drivetrain: p_amb, T_amb, drivetrain efficiency

Phase 2 swaps each `<ReadOnlyField>` for an editable counterpart; the
schema layer makes that a component-swap, not a screen rewrite.

### StudiesScreen

Layout: header (`New Study…` button, filters) then a table of studies
(newest first), active study highlighted.

- **New Study… kind picker** modal — Phase 1 lists three rows:
  - Single-RPM run (enabled)
  - RPM sweep — *coming in Phase 3* — disabled with explanatory tooltip
  - Optimization study — *coming in Phase 5* — disabled

  Single-RPM opens a params form (RPM, n_cycles_max, junction kind toggle,
  convergence tol, min cycles) with sensible defaults. `Start` calls
  `cfd_start_job` with `kind: "single-rpm"` and navigates to the Results
  screen for that study.

- **Studies table columns:** kind icon, config name, params summary
  ("6000 rpm · stagnation · 25c"), status badge, cycles done / total,
  started, duration, actions (Cancel / Re-run / Delete / View).
- **Cancel** sets the study status to `"cancelling"` immediately and calls
  `cfd_cancel_job`. The runner emits `cfd:job-cancelled` to confirm.
- **Re-run** clones the study's params + config path into a new study
  (preserves the audit trail).
- The studies list persists to localStorage as a bounded ring buffer (cap
  50 study headers). Cycle data is in memory only in Phase 1.

### ResultsScreen

Pure dispatch on `study.kind`:

```tsx
function ResultsScreen() {
  const { activeStudy } = useCfd();
  if (!activeStudy) return <EmptyResults />;
  switch (activeStudy.kind) {
    case "single-rpm": return <SingleRpmResults study={activeStudy} />;
    // case "sweep":        return <SweepResults study={activeStudy} />;         // Phase 3
    // case "optimization": return <OptimizationResults study={activeStudy} />;  // Phase 5
  }
}
```

### SingleRpmResults

Three regions:

1. **Header strip** — study id, config name, params recap, status badge,
   running-cycle counter ("12 / 25 cycles · 4.3s"), inline sparkline of
   IMEP-by-cycle, Cancel button while running.

2. **Charts grid** (2×2, using `<CycleChart>` uPlot wrapper). X axis = cycle
   index for all four:
   - IMEP / BMEP / FMEP — three series, stacked legend
   - VE (%) and indicated power (kW) — dual Y axis
   - EGT (K) — single series
   - Mass diagnostic: `mass_drift` and `nonconservation` — log Y, signals
     "this run is suspect"

3. **Cycle stats table** — every `CycleStats` field, one row per cycle,
   last row pinned + bold, copy-to-clipboard per row. Convergence-flag
   column shows ✓ on the cycle where IMEP settled.

Charts update on every progress event via uPlot's `setData` — append the
new row and call setData, no whole-tree rerender.

Empty state for the screen (no study selected): "Pick a study on the left,
or start a new one" with shortcuts.

## Section 4 — Error handling, validation, edge cases

Per the no-browser-dialogs rule (memory: `feedback_no_browser_dialogs.md`),
everything surfaces in-app, never via `window.alert / confirm`.

### Config load errors

`cfd_load_config` returns `Result<LoadedConfig, String>`:
- File not found / not readable → inline error banner on ConfigScreen.
- JSON parse error → banner with line/column where serde provides them.
- Schema mismatch (missing / wrong type) → banner with field path
  (e.g., `intake_pipes[2].n_points`).
- Schema-OK but physically nonsense (bore ≤ 0, CR < 1, negative pipe
  length) → warning panel; the bad value is highlighted red in the
  read-only summary. We do **not** block running — engine-sim's own
  validation at `SDM26Engine::new` will reject the config and surface as
  a sim runtime error.

### Sim runtime errors

- The cycle loop runs inside `std::panic::catch_unwind`; on panic, emit
  `cfd:job-error` with the formatted panic message + the last cycle index
  reached.
- **Divergence detection**: after each cycle, every numeric field of
  `CycleStats` is checked with `f64::is_finite`. Non-finite → terminate
  the job and emit `cfd:job-error { reason: "solver-diverged",
  partial_cycles, last_cycle }`. Results screen renders the partial cycles
  + a divergence card pointing at the offending cycle.
- **Cancellation is between-cycle.** engine-sim does not expose mid-cycle
  hooks. Worst case the user waits one cycle (a few seconds at typical
  step counts). Per-step cancellation can come with Phase 4 if we expose
  per-step hooks anyway.

### Concurrency

- Phase 1 allows one running job at a time per kind. Starting a new
  single-rpm study while one is `running` shows a **custom in-app
  confirmation modal** ("A study is already running. Cancel it and start a
  new one?"). Not `window.confirm`.
- `CfdState.jobs` is the source of truth; the frontend mirrors it from
  events. On HMR / remount, `cfd_list_jobs` rehydrates the UI from the
  Rust side.

### Tauri event listener lifecycle

`CfdHome` registers listeners on mount via `getCurrentWindow().listen(...)`
and returns the cleanup. One listener per event channel, dispatched to the
right study by `job_id`. The `cfd_list_jobs` rehydration call patches up
any missed events during HMR.

### localStorage hygiene

Single key: `helios.cfd.v1`. Shape:
```json
{ "lastConfigPath": "...", "studies": [{ "id": "...", "kind": "...", "configPath": "...", ... }] }
```

Cycle data is not stored — only study headers. Schema bumps (`v2`, etc.)
get a one-line migration; if migration fails, drop and start fresh.

### File path display

Show basename in headers, full path on hover/copy. Reuse Helios's existing
session path display utilities if one exists; otherwise add
`lib/cfdPath.ts`.

### Bundled config integrity

If `cfd_list_examples` finds the resource dir empty, the Examples dropdown
disables with label "Examples not bundled — file an issue."

## Section 5 — Testing strategy

Heavy use of fakes. engine-sim has its own parity tests (Section 6), so the
desktop tests do not re-test the math.

### Rust — `apps/desktop/src-tauri/src/cfd/`

- `commands.rs` — unit tests on the pure pieces: `StartJobRequest`
  deserialization (each variant), `LoadedConfig` shape, `ExampleConfig`
  resolution. Pure serde round-trips, no Tauri runtime.
- `runner.rs` — `run_single_rpm_job` driven against a `trait JobEmitter`
  test-double (a `Vec<Event>` collector):
  - happy path: 3 cycles requested → exactly one `job-started`, three
    `job-progress`, one `job-done`, in order; payloads carry the right
    cycle indices
  - cancellation: cancel flag set before iter 2 → `job-started`, one
    `job-progress`, one `job-cancelled`; no `job-done`
  - bad config path → `job-started` then `job-error { reason:
    "config-load" }`; no progress
  - divergence: stub a configuration (or inject via a test-only seam)
    producing non-finite IMEP → partial progress + `job-error { reason:
    "solver-diverged" }`
- `state.rs` — concurrent-map semantics: insert/remove/cancel under
  contention with a couple of threads (`std::thread::scope` test).

No Tauri end-to-end test in Phase 1. The `JobEmitter` trait seam exercises
the same logic. The first time we need a real Tauri runtime test (likely
Phase 3 sweeps) we'll add one.

### Frontend — `apps/desktop/src/modules/cfd/__tests__/`

Helios uses vitest + @testing-library/react.

- `CfdContext.test.tsx` — reducer / mutator unit tests on state
  transitions. Pure TS, no React render needed:
  `startStudy → progress → progress → done` advances status; cancel
  mid-run → `cancelling` → `cancelled`; error populates the error field.
- `ConfigScreen.test.tsx` — render with a fake `invoke`: empty state has
  the right CTAs; loaded-config summary renders all sections; parse error
  from `cfd_load_config` shows the banner.
- `StudiesScreen.test.tsx` — kind picker enables only Single-RPM in
  Phase 1 (assert disabled state for Sweep / Optimization rows + their
  tooltips); Start triggers `cfd_start_job` with expected payload;
  Cancel triggers `cfd_cancel_job`.
- `SingleRpmResults.test.tsx` — render with a mid-run study; appending
  progress events updates the cycle counter + appends rows to the table
  without unmounting the chart. We don't pixel-snap uPlot output —
  assert on the `setData` calls via a mock for the chart wrapper.
- `NavRail.test.tsx` — data-driven entries render in order; clicking
  switches active screen.

### Test doubles

- `__tests__/fakes/tauri.ts` — minimal fake for `invoke` + `listen` (event
  emitter). Reused across tests.
- `__tests__/fakes/study.ts` — factories for `Study`, `CycleStats`,
  `LoadedConfig` test fixtures.

### Out of scope for Phase 1 tests

- Visual regression / screenshot testing
- Tauri end-to-end
- Browser-driven testing — manual smoke gate in Section 6 covers it

## Section 6 — Correctness vs. Python: broad parity coverage

The engine-sim crate's existing 18 parity fixtures already prove the math
identical to Python at ≤ 1e-6 rtol / 1e-9 atol on engine-level cycle
stats. Phase 1 broadens the engine-level coverage substantially, holds
tolerance constant, and adds narrow desktop-side guards on the new code
paths.

### What's new in Phase 1's code path

Three risk surfaces beyond the crate's already-proven math:

1. The runner calls `engine.run_single_rpm(rpm, n_cycles=1, ...,
   stop_at_convergence=false)` repeatedly instead of once with
   `n_cycles=N`. This call pattern needs to produce identical results.
2. Convergence detection moved into the runner so the UI can stream
   partial results. Detection must match Python's.
3. Tauri serialization round-trip for `CycleStats`. Numeric values cross
   JSON; field renames or `#[serde(skip)]` could silently corrupt.

### Where the tests live

- `crates/engine-sim/fixtures/parity/` — new engine-level golden fixtures
- `crates/engine-sim/python_ref/scripts/capture_goldens.py` — extended
  with new capture functions
- `crates/engine-sim/tests/parity_engine_matrix.rs` (new) — one
  `#[test]` per matrix fixture
- `crates/engine-sim/tests/parity_engine_convergence.rs` (new) — two
  long-run convergence tests
- `crates/engine-sim/tests/parity_solver_extras.rs` (new) — extra MUSCL
  cases
- `crates/engine-sim/tests/parity_hllc_extras.rs` (new) — extra HLLC
  cases
- `apps/desktop/src-tauri/src/cfd/runner.rs` — three narrow tests
  (runner≡direct, runner≡Python, serde round-trip)

### Engine-level parity matrix (new)

| Axis | Values | Notes |
| --- | --- | --- |
| Config | SDM25, SDM26 | Both bundled examples |
| Junction kind | Stagnation CV, Characteristic | Both supported types |
| RPM | 4000, 6000, 8000, 10000, 12000 | Spans the upstream sweep range |
| Cycle count | 5 | Same per-cycle dump as `engine_5cycle.json` |

→ **20 new engine fixtures**, each storing the full per-cycle stats array.

Tolerance held at `rtol = 1e-6, atol = 1e-9` on every `CycleStats` field.
If the matrix cannot hold that tolerance, the port has a bug we need to
find — we do not loosen the tolerance.

### Convergence fixtures (new)

Two 25-cycle SDM runs (one per config) at 6000 RPM, Stagnation junctions,
with `stop_at_convergence=true`. These verify:
1. Long-run cycle-stats drift (cycle 20 of 25 still matches Python within
   the same tolerance).
2. The convergence detector picks the same cycle as Python's reference
   run.

→ **2 fixtures**: `engine_convergence_sdm25_25cyc.json`,
`engine_convergence_sdm26_25cyc.json`.

### Kernel-level broadening (new, smaller scope)

The thinnest spots in the existing kernel suite:

- `muscl.json` — one Sod-like IC. Add **4 cases**: contact-discontinuity
  IC, left-rarefaction IC, supersonic-shock IC, mixed-gamma IC.
- `hllc.json` — 200 random Riemann problems. Extend to **500 random + 8
  Toro textbook cases** (shock-tubes A–E + low-density + slowly-moving
  contact + near-vacuum).

→ **5 new kernel fixtures**.

### Totals

- 20 engine matrix fixtures
- 2 convergence fixtures
- 5 kernel fixtures
- **27 new parity fixtures + 27 new Rust tests**

### Generation flow

1. Extend `capture_goldens.py` with `capture_engine_matrix()`,
   `capture_engine_convergence()`, `capture_muscl_extras()`,
   `capture_hllc_extras()`.
2. Run once in the existing Python env (already set up for the original
   18 fixtures). Wall time ~30 min for the engine matrix.
3. Commit fixtures + new Rust tests as part of Phase 1.
4. CI runs all parity tests on every push.

### Desktop-side parity tests (narrow, three tests)

These guard the runner wrapper only.

**Test A — Runner loop ≡ direct run (Rust↔Rust, machine precision)**

```rust
#[test]
fn runner_loop_matches_direct_run_sdm26_6000rpm_5cyc() {
    let cfg = load_v1_json("../../crates/engine-sim/python_ref/configs/sdm26.json").unwrap();

    // A: cycle-by-cycle via the runner (no event emission)
    let cycles_runner = drive_runner_no_emit(cfg.clone(), 6000.0, 5);

    // B: the canonical single-shot call
    let mut eng = SDM26Engine::new(cfg, JunctionKind::Stagnation);
    let r = eng.run_single_rpm(6000.0, 5, false, 1e-3, 5, false);

    assert_eq!(cycles_runner.len(), r.cycle_stats.len());
    for (a, b) in cycles_runner.iter().zip(&r.cycle_stats) {
        assert_close!(a.imep_bar, b.imep_bar, rtol=1e-12, atol=1e-14);
        // ...all CycleStats fields at machine-precision tolerance
    }
}
```

Rust↔Rust, so no libm/SIMD drift. If the loop wrapper perturbs anything,
this screams.

**Test B — Phase 1 runner ≡ Python golden**

```rust
#[test]
fn runner_matches_python_golden_sdm26_6000rpm_5cyc() {
    let golden = load_golden("../../crates/engine-sim/fixtures/parity/engine_5cycle.json");
    let cfg = load_v1_json(&golden.inputs.config_path).unwrap();

    let cycles = drive_runner_no_emit(cfg, golden.inputs.rpm, golden.inputs.n_cycles);

    for (got, want) in cycles.iter().zip(&golden.outputs.cycle_stats) {
        assert_close!(got.imep_bar, want.imep_bar, rtol=1e-6, atol=1e-9);
        // ...all CycleStats fields
    }
}
```

Re-anchors Phase 1 directly to Python at the runner entry point.

**Test C — Serde round-trip is lossless**

```rust
#[test]
fn cycle_stats_serde_roundtrip_lossless() {
    let cs = sample_cycle_stats();
    let json = serde_json::to_string(&cs).unwrap();
    let cs2: engine_sim::CycleStats = serde_json::from_str(&json).unwrap();
    assert_close_struct!(cs, cs2, rtol=0.0, atol=0.0);
}
```

`f64` round-trip is exact in serde_json; this guards against accidental
field renames / skips.

### Manual verification gate (ship blocker)

Phase 1 is not done until:

1. `cargo test -p engine-sim` — all 18 + 27 = 45 parity tests pass
2. `cargo test -p helios-desktop cfd::` — Tests A, B, C pass
3. **Smoke 1**: in the running app, load `Example: SDM26`, run 5 cycles
   at 6000 RPM with Stagnation junctions. Last cycle's IMEP / BMEP / VE
   / EGT match the SDM26 6000 fixture's last cycle to displayed precision
   (4 sig figs).
4. **Smoke 2**: load `Example: SDM25`, run 5 cycles at 10000 RPM with
   Characteristic junctions. Last cycle matches its fixture. Off-center
   matrix cell on purpose — proves the UI isn't accidentally hardcoded
   to defaults.

## Cross-cutting decisions / constraints

- **No Python in Helios.** Memory: `feedback_no_python_in_helios.md`. The
  `crates/engine-sim/python_ref/` snapshot is the only Python in-repo; do
  not extend it. The upstream is read-only at a sibling clone outside
  Helios.
- **No browser dialogs.** Memory: `feedback_no_browser_dialogs.md`. All
  prompts and confirmations use custom in-app modals.
- **No backward-compat shims.** Phase 1 is greenfield; nothing to remain
  compatible with. Don't add unused exports / placeholder types
  anticipating Phase 2 — design seams, not unused code.
- **`f64` end-to-end.** Matches engine-sim's port discipline. JSON
  serialization of `f64` is exact in `serde_json`.

## Non-decisions explicitly punted

- Whether the eventual config editor (Phase 2) uses uncontrolled forms or
  a form library. Not a Phase 1 question.
- Whether sweeps (Phase 3) reuse the existing `engine_sim::model::sweep`
  driver or thread per-RPM jobs via the same `cfd_start_job` machinery.
  Phase 3's brainstorm picks.
- Whether streaming pipe-state (Phase 4) flows through Tauri events or
  shared-memory buffers. Phase 4's brainstorm picks.
- Optimization study UX (Phase 5).
