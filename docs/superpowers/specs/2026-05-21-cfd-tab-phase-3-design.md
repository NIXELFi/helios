# CFD Tab — Phase 3 Design (Sweeps, Post-Cycle Visualization, Wave-Capture Plumbing)

**Status:** approved (autonomous)
**Authors:** Claude (autonomous mode per user instruction)
**Tracks against:** branch `feat/engine-sim-rust-port` (v3.2.2), ships as 3.3.0

## Goal

Phase 3 turns Helios's CFD tab from a single-RPM monitor into a real exploration surface:

1. **Multi-RPM sweeps** — sweep a config across an RPM list, stream per-RPM per-cycle progress, plot curves of IMEP/BMEP/VE/EGT/power vs RPM.
2. **Per-cylinder P-V loops** + crank-angle traces — capture last-cycle (V, p, T, x_b) per cylinder and render P-V loops + p(θ), T(θ), x_b(θ) traces.
3. **End-of-cycle pipe profiles** — at the end of the last cycle, snapshot every pipe's (ρ, u, p, T) along x and render per-pipe profile plots.
4. **Sweep-vs-sweep comparison** — overlay two completed sweeps for IMEP/VE/power curves.
5. **Per-step wave-capture writer (infrastructure only, no viewer this phase)** — engine-sim seam to emit downsampled per-step pipe primitives + cylinder state to a JSONL file. Gated by a "record waves" checkbox. Phase 4 builds the viewer.

The wave-capture viewer (animated engine schematic with cells colored by field and sized by pressure) is deferred to Phase 4 pending recovery of the lost HTML reference. Phase 3 lands the data pipeline so Phase 4 has frames to consume on day 1.

## Non-Goals

- The engine-schematic animated cell viewer (Phase 4).
- Optimization studies (Phase 5).
- Sensitivity studies (Phase 5).
- Streaming wave data over Tauri events. Wave capture is file-based; events are cycle-level only.
- New config schema fields. The capture toggle lives on the Run-study modal, not the config.

## Architecture (high level)

```
+--------------------+              +--------------------+
|  StudiesScreen     |              |  Tauri command:    |
|  picks "Sweep…"    |---startJob-->|  cfd_start_job     |
+--------------------+              +---------+----------+
                                              |
                                    spawn worker thread
                                              |
                              +---------------+----------------+
                              |  cfd-core::runner::run_sweep   |
                              |   for rpm in rpm_list:         |
                              |     emit progress(rpm started) |
                              |     advance_one_cycle loop:    |
                              |       capture P-V + traces last cycle
                              |       capture end-of-cycle pipe profiles
                              |       if record_waves: write JSONL frame every Nth step
                              |       emit progress(per-cycle stats)
                              |     emit progress(rpm done)    |
                              |   emit done(SweepDoneSummary)  |
                              +--------------------------------+
                                              |
                                  Tauri events (5 names, + 2 new payload variants)
                                              |
                              +--------------------+
                              |  CfdContext reducer|
                              |  builds SweepStudy |
                              +--------------------+
                                              |
                              +--------------------+
                              |  SweepResults view |
                              |  + PvLoopView      |
                              |  + ProfilesView    |
                              +--------------------+
```

## Section 1 — Engine-sim capture hooks

### 1.1 Snapshot callback on `advance_one_cycle`

`advance_one_cycle` already takes `theta_limit: Option<f64>` as a third arg. We add a **fourth optional callback** that the runner can pass to capture per-step or end-of-cycle snapshots. Parity-preservation rule: when callback is `None`, behavior is bit-identical to today.

```rust
// engine-sim::model::sdm26

pub trait CycleObserver {
    /// Called once after every internal step. The default no-op makes the
    /// optimizer fold this away when None. Inputs:
    ///   theta_global_deg: current crank angle in degrees (post-step)
    ///   dt:               solver dt taken on this step
    fn on_step(&mut self, theta_global_deg: f64, dt: f64, eng: &SDM26Engine);
}

impl SDM26Engine {
    pub fn advance_one_cycle(
        &mut self,
        rpm: f64,
        state: &mut CycleLoopState,
        theta_limit: Option<f64>,
        observer: Option<&mut dyn CycleObserver>,   // NEW
    ) -> CycleOutcome { ... }
}
```

The existing `run_single_rpm` keeps its current signature; it calls `advance_one_cycle(..., None)` internally. The 45 parity tests stay green because:
- A `None` observer is a single `if let Some(..)` branch per step; the optimizer elides it.
- We never read or mutate engine state from the observer; it's a read-only viewer.

### 1.2 Built-in observers

In `cfd-core::capture`:

```rust
pub struct PvLoopRecorder { /* per-cylinder (theta_local, V, p, T, x_b) ring */ }
pub struct PipeProfileRecorder { /* end-of-cycle (rho, u, p, T) per pipe */ }
pub struct WaveFrameWriter { /* JSONL writer, downsamples to every Nth step */ }
```

Each implements `CycleObserver`. The runner instantiates them per-RPM and tears them down at end of last cycle.

### 1.3 Disk format

Wave frames write to:

```
<DocumentsDir>/Helios/cfd/captures/<job_id>/<rpm_int>/waves.jsonl
<DocumentsDir>/Helios/cfd/captures/<job_id>/<rpm_int>/manifest.json
```

`manifest.json`:
```json
{
  "job_id": "01HX...",
  "rpm": 8000,
  "n_pipes": 11,
  "pipes": [
    {"role":"plenum","label":"plenum","n_cells":20,"length_m":0.2,"index":0},
    {"role":"runner","label":"runner_1","n_cells":30,"length_m":0.25,"index":1},
    ...
  ],
  "n_cylinders": 4,
  "step_stride": 50,
  "fields": ["rho","u","p","T"],
  "frame_count": 837,
  "theta_start_deg": 0.0,
  "theta_end_deg": 720.0,
  "captured_cycle": 17
}
```

`waves.jsonl` — one JSON object per frame:
```json
{"theta":12.34,"t_ms":0.123,"pipes":[[rho_arr,u_arr,p_arr,T_arr],...],"cyl":[{"V":...,"p":...,"T":...,"x_b":...},...]}
```

`step_stride` defaults to a value chosen so that captured frame count is ~600 per cycle (≈ 1.2 frames per crank degree), independent of CFL. Computed at the start of the captured cycle from the step rate observed during the previous cycle.

Files are written incrementally (BufWriter) so a cancelled job still leaves a readable prefix. On error / cancel, the manifest is rewritten with the actual `frame_count`. Cancelled or errored captures stay on disk for inspection.

### 1.4 Why disk, not events

Per-step data volume at SDM26 8000 RPM ≈ 10,000 steps × 11 pipes × 30 cells × 4 fields × 8 bytes ≈ 100 MB per cycle if undecimated. Even at stride 50 that's 2 MB/cycle JSON, which is fine on disk but would saturate the Tauri event channel and the React reducer. The viewer (Phase 4) reads files via a Tauri command that streams parsed frames on demand.

## Section 2 — Sweep job

### 2.1 DTO additions (`cfd-core::dto`)

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SweepParams {
    pub rpm_list: Vec<f64>,                        // ascending; deduped
    pub n_cycles_max: u32,
    pub junction_kind: JunctionKindDto,
    pub convergence_tol_imep: f64,
    pub convergence_min_cycles: u32,
    pub capture_waves: bool,                       // default false
    pub capture_pv_loops: bool,                    // default true
    pub capture_pipe_profiles: bool,               // default true
}

// StartJobRequest gains a Sweep variant
pub enum StartJobRequest {
    SingleRpm { config_path: String, params: SingleRpmParams },
    Sweep    { config_path: String, params: SweepParams },
}

// StudyKind gains a Sweep variant
pub enum StudyKind { SingleRpm, Sweep }
```

`SingleRpmParams` also gains the same three `capture_*` flags (defaults `false`, `true`, `true` respectively).

### 2.2 New event payload variants

```rust
// cfd:job-progress payload becomes a kind-tagged union
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum JobProgressPayload {
    SingleRpm(JobProgressSingleRpm),
    SweepRpmStarted { rpm_idx: u32, total_rpms: u32, rpm: f64 },
    SweepCycle      { rpm_idx: u32, rpm: f64, cycle: u32, total: u32, cycle_stats: CycleStats },
    SweepRpmDone    { rpm_idx: u32, rpm: f64, point: SweepPoint, capture_dir: Option<String> },
}

// cfd:job-done payload becomes a kind-tagged union too
pub enum JobDoneSummary {
    SingleRpm(SingleRpmDoneSummary),
    Sweep(SweepDoneSummary),
}

pub struct SweepDoneSummary {
    pub n_rpms: u32,
    pub n_completed: u32,                // less if cancelled mid-sweep
    pub total_step_count: u64,
    pub total_wall_time_s: f64,
}

pub struct SweepPoint {                  // shared between event + final summary
    pub rpm: f64,
    pub converged_cycle: i64,
    pub n_cycles_run: u32,
    pub last_cycle: CycleStats,
    pub nonconservation_max: f64,
    pub wall_time_s: f64,
    pub step_count: u64,
}
```

This change is **backwards-compatible-with-Phase-1** at the wire level because the new top-level tag (`kind`) reuses the existing discriminator pattern. Phase 1 frontend reads `payload.cycle` directly; Phase 3 frontend keys on `payload.kind`. We update both ends together.

### 2.3 Runner (`cfd-core::runner::run_sweep_job`)

Mirrors `run_single_rpm_job` but loops over `rpm_list`:

```
emit_started(StudyKind::Sweep)
for (i, rpm) in rpm_list.iter().enumerate():
    if cancel.set: emit_cancelled with partial points; return
    emit_progress(SweepRpmStarted { rpm_idx: i, total_rpms, rpm })
    eng = SDM26Engine::new(cfg, junction_kind)
    loop_state = CycleLoopState::new(&mut eng)
    accumulated = []
    profile_recorder = PipeProfileRecorder::new()  // captures end-of-last-cycle
    for cycle_i in 0..n_cycles_max:
        if cancel.set: emit_cancelled; return
        observer = compose(
            (capture_pv_loops && is_last_cycle).then(|| pv_recorder),
            (capture_pipe_profiles && is_last_cycle).then(|| profile_recorder),
            capture_waves.then(|| wave_writer),
        )
        outcome = eng.advance_one_cycle(rpm, &mut loop_state, None, observer)
        match outcome: ...
        emit_progress(SweepCycle { rpm_idx: i, rpm, cycle, total, cycle_stats })
        if check_converged(...): break
    point = SweepPoint { rpm, ... }
    persist captured artifacts to <job_dir>/<rpm_int>/
    emit_progress(SweepRpmDone { rpm_idx, rpm, point, capture_dir })
emit_done(JobDoneSummary::Sweep(...))
```

"Compose" wraps multiple observers into one. Detecting `is_last_cycle` is the trick — we don't know the last cycle index in advance because of convergence early-stop. The implementation:

1. Run the sweep RPM with NO last-cycle observers first (just the wave writer if requested).
2. Detect convergence cycle index.
3. Run ONE MORE cycle with `last-cycle` observers attached, starting from the post-converged state. This adds ≤1 cycle of wall time per RPM but is the simplest way to keep the math identical and only capture the converged cycle.

Alternative considered but rejected: keep rolling P-V buffers for the last cycle in a circular fashion. Rejected because: cancellation mid-cycle leaves the buffer in an ambiguous state, and "the last cycle ran" semantics are clearer when capture is its own deterministic pass.

### 2.4 One-job-per-kind gate

`CfdState::register` already enforces one-running-job-per-kind. Sweep is its own kind, so a sweep and a single-RPM can coexist. We keep that.

## Section 3 — Frontend state

### 3.1 Type additions

```ts
// state/types.ts
export type StudyKind = "single-rpm" | "sweep";

export interface SweepParams {
  rpmList: number[];
  nCyclesMax: number;
  junctionKind: JunctionKind;
  convergenceTolImep: number;
  convergenceMinCycles: number;
  captureWaves: boolean;
  capturePvLoops: boolean;
  capturePipeProfiles: boolean;
}

export interface SweepPoint {
  rpm: number;
  convergedCycle: number;
  nCyclesRun: number;
  lastCycle: CycleStats;
  nonconservationMax: number;
  wallTimeS: number;
  stepCount: number;
  // Filled by the frontend when SweepRpmDone arrives:
  cycles: CycleStats[];           // every cycle's stats for this RPM
  captureDir?: string;            // present iff at least one capture wrote to disk
}

export interface SweepDoneSummary {
  nRpms: number;
  nCompleted: number;
  totalStepCount: number;
  totalWallTimeS: number;
}

export interface SweepStudy extends StudyBase {
  kind: "sweep";
  params: SweepParams;
  points: SweepPoint[];           // grows as RPMs complete; empty before first done
  currentRpm?: { idx: number; rpm: number; cycles: CycleStats[] };  // in-flight buffer
  summary?: SweepDoneSummary;
  compareWithStudyId?: string;    // optional overlay
}

export type Study = SingleRpmStudy | SweepStudy;
```

### 3.2 Reducer

`appendCycle` becomes a no-op shim that dispatches to a kind-aware handler. New actions:

- `sweepRpmStarted { id, rpmIdx, rpm }`
- `sweepCycle { id, rpmIdx, rpm, cycleStats }`
- `sweepRpmDone { id, point }`
- `setCompare { id, compareWithStudyId }`

### 3.3 New nav item: `"sweeps"`

`NavId` becomes `"config" | "studies" | "results" | "sweeps"`. The `sweeps` screen lists completed sweeps and lets you pick one to compare against the active. (Most of the time users will just go through Studies → New study → Sweep → view in Results.)

Actually, for simplicity Phase 3 puts sweep results under the same Results screen, dispatching on `study.kind`. The compare UI lives at the top of `SweepResults`. We don't add a new nav item this phase.

### 3.4 Persistence

Sweep `points[]` is too large to keep in localStorage. Persistence headers omit `points`, just like `cycles[]` was omitted in Phase 1. On re-open, sweeps re-materialize as empty-`points` shells; user re-runs to see data.

## Section 4 — Screens

### 4.1 Studies screen — Sweep modal

`StudiesScreen.tsx` already has a "RPM sweep (Phase 3)" disabled card. We enable it, give it its own params modal:

```
+ Config: <basename>                     [defaultPath, immutable]
+ RPM list:                              [text input — comma-separated or "start:stop:step"]
+ Max cycles per RPM:    [input]
+ Junction kind:         [select]
+ Convergence tol IMEP:  [input]
+ Min cycles before conv:[input]
+ [ ] Capture wave frames (disk-heavy)
+ [x] Capture P-V loops
+ [x] Capture pipe profiles
[Cancel] [Start]
```

RPM-list parser accepts:
- `4000, 5000, 6000, 7000, 8000`
- `4000:12000:1000` → `[4000, 5000, …, 12000]`
- mixed

Validation: 1 ≤ count ≤ 50, each rpm in [500, 20000], sorted ascending, deduped.

### 4.2 SweepResults view

`results/SweepResults.tsx`:

- **Header**: kind=Sweep · N rpms · status badge · cancel button (if running)
- **Curves grid** (2 cols on xl, 1 col below): IMEP/BMEP/FMEP vs RPM, VE vs RPM, EGT vs RPM, P_ind & P_brake vs RPM (dual axis). Each is a uPlot line plot. Points are drawn for completed RPMs only.
- **Compare overlay**: dropdown picker "Compare to: (none) / <other sweep>". When selected, overlay the other sweep's curves in a muted color.
- **Per-RPM table** below the curves: every row a SweepPoint; click to expand into a `SingleRpmResults`-style mini view of that RPM's cycles + P-V + profiles (uses the same components from §4.3 / §4.4).
- **Sweep convergence table**: per-RPM converged-at-cycle, nonconservation-max, wall time.

### 4.3 P-V loop + crank-angle traces

`results/PvLoopView.tsx`:
- Per-cylinder P-V loop (log-log toggle: linear by default)
- p(θ_local), T(θ_local), x_b(θ_local) traces in a stacked panel
- Cylinder picker (1..N)
- Available when `study.kind === "single-rpm"` AND `study.pvLoops != null`, or for any RPM in a SweepStudy with capture_pv_loops enabled (loaded on demand from `<captureDir>/pv.json`).

### 4.4 End-of-cycle pipe profile view

`results/PipeProfileView.tsx`:
- Per-pipe panel showing ρ(x), u(x), p(x), T(x) along the pipe's centerline (mm)
- Pipe role labels (plenum, runner_1..4, primary_1..4, secondary_1..2, collector)
- Optional overlay: same RPM at a different junction kind, OR the comparison sweep at the closest RPM
- Available iff `capture_pipe_profiles` was on for that RPM

### 4.5 Capture artifact paths

Single-RPM run captures at:
```
<DocumentsDir>/Helios/cfd/captures/<job_id>/single-rpm/<rpm_int>/
    pv.json
    profiles.json
    waves.jsonl (if capture_waves)
    manifest.json
```

Sweep captures at:
```
<DocumentsDir>/Helios/cfd/captures/<job_id>/sweep/<rpm_int>/
    pv.json
    profiles.json
    waves.jsonl (if capture_waves)
    manifest.json
```

A new Tauri command `cfd_load_capture(job_id, rpm_int, file)` reads & parses the JSON. The frontend loads on-demand when a user expands a row or opens the per-RPM mini view, NOT eagerly.

## Section 5 — Error handling

- Sweep stops on the **first per-RPM error**; emits `JobErrorEvent` with `partial_points` (analogous to `partial_cycles`).
- A failed RPM doesn't roll back already-completed RPMs; they remain in `points[]`.
- Capture writes are best-effort. A failed JSONL write emits a warning to stderr but doesn't kill the job. The capture manifest records `incomplete: true` in that case.
- Disk full → capture writer disables itself for the rest of the run, manifest marked incomplete.
- Cancel mid-sweep → emit `JobCancelledEvent { partial_points }`, leaving completed RPMs visible.

## Section 6 — Testing

### 6.1 Rust (`crates/cfd-core/src/runner.rs`)

- **Sweep happy path**: 3-RPM sweep, 2 cycles each — assert event sequence is `started → rpm_started(0) → cycle(0,1) → cycle(0,2) → rpm_done(0) → rpm_started(1) → ... → done`.
- **Sweep cancellation between RPMs**: cancel after 1st RPM done — assert `JobCancelledEvent.partial_points.len() == 1`.
- **Sweep cancellation mid-RPM**: cancel mid-cycle — assert no `rpm_done` for that RPM.
- **Sweep parity vs direct call**: 3-RPM sweep results compare to `engine_sim::model::sweep::run_sweep` per-RPM, asserting every CycleStats field within 1e-12 rel.
- **CycleObserver no-op parity**: assert `advance_one_cycle(..., None)` produces bit-identical CycleStats to `advance_one_cycle(..., Some(no_op_observer))` over 5 cycles.
- **PvLoopRecorder**: assert (V, p, T, x_b) sampled monotonically by theta, captures > 100 points per cycle, V matches geometric cylinder_volume to 1e-12.
- **PipeProfileRecorder**: assert profiles match the engine's real-cell primitives_array at the cycle boundary cell-for-cell.
- **WaveFrameWriter**: write to tempdir, parse back manifest.json, assert frame_count, fields, n_pipes consistent. Run mini sim (2 cycles, capture on, stride 50) and assert ~12-24 frames written.

### 6.2 Engine-sim parity

Add **one** new test confirming `advance_one_cycle(..., Some(observer))` produces identical CycleStats to `advance_one_cycle(..., None)` for a 5-cycle SDM26 run at 8000 RPM. The other 45 existing tests guard the underlying math.

### 6.3 Frontend (Vitest)

- `rpmListParser.test.ts`: cover comma list, `start:stop:step`, validation errors.
- `cfdContext.sweep.test.ts`: dispatch synthetic events `sweepRpmStarted/sweepCycle/sweepRpmDone/done`, assert reducer builds the right `SweepStudy` shape.
- `SweepResults.test.tsx`: render a fake sweep with 3 points, assert curves are drawn (chart container present per metric) and the per-RPM table has 3 rows.
- `PvLoopView.test.tsx`: render with a synthetic pv.json blob, assert canvas mounts and cylinder picker switches between 4 cylinders.
- `PipeProfileView.test.tsx`: render with synthetic profiles.json (3 pipes), assert per-pipe panels render.
- `StudiesScreen.sweep.test.tsx`: pick Sweep card → fill RPM list `4000:6000:1000` → start → assert `bridge.startJob` called with parsed `[4000,5000,6000]`.

## Section 7 — Style + UX rules

- Follow the same dark-mode Logs-style chrome as Phase 1/2 (`#0E0E10`, `#0B0B0D`, `#2A2C32`, `#FFC627`, `#D8DCE2`, `#9097A0`, 10/11px caps tracking-wider headers).
- Charts use uPlot, same yellow accent for primary series.
- Compare-overlay series rendered in muted `#5A5F66` to keep the active series readable.
- Capture-on icon: small yellow disk badge in the sweep header when any capture was enabled for the run.
- No browser dialogs (per `feedback_no_browser_dialogs`).
- All change records logged in `v2_changes/NN-cfd-phase-3-...md`.

## Section 8 — Tradeoffs / known sharp edges

- **Capture writes block the worker thread.** Acceptable for an MVP — the WaveFrameWriter only writes at stride boundaries, so write amplification is bounded. If it becomes painful we can move to a bounded `mpsc::channel` + dedicated writer thread in Phase 4.
- **Re-running the converged cycle for capture costs ~1 extra cycle of compute.** Worth it for code clarity; can be optimized later by making the capture observer attach on the cycle BEFORE convergence is checked.
- **rpm_list is closed-form, not a range that grows during the run.** Sensitivity studies (Phase 5) will need a growing list; Phase 3 keeps it simple.
- **Disk capture paths assume `Documents` exists.** Existing `cfd_default_save_dir` already creates `Helios/cfd/configs`; we add `Helios/cfd/captures/<job_id>/...` the same way.
- **Sweep persistence is intentionally lossy.** Reload shows the headers; user has to re-run if they want data back. Long term we'd persist `points[]` to disk too, but that's Phase 5 scope.
- **Wave-capture JSONL is plain text, not msgpack.** For Phase 3 viewer-less plumbing this is fine. Phase 4 will revisit if frame parsing in JS is a bottleneck.

## Section 9 — Out-of-scope reminder

- The animated engine-schematic wave viewer (lost reference) — Phase 4.
- A binary wave-frame format — defer.
- Per-cell colormap selection — defer.
- Sensitivity / optimization — Phase 5.
- Sweep persistence to disk beyond the capture-artifact files — defer.
- Multi-config sweeps (e.g., overlay SDM25 vs SDM26 in one job) — defer; covered by the manual sweep-vs-sweep compare UI.
