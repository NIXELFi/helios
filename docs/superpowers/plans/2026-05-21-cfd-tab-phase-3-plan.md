# CFD Tab — Phase 3 Implementation Plan

> Executed autonomously by Claude per user instruction. Tasks below are the work items I'm tracking; they may be reshuffled or merged during execution.

**Goal:** Multi-RPM sweeps, per-cylinder P-V + crank-angle traces, end-of-cycle pipe profiles, sweep-vs-sweep compare, and per-step wave-capture writer (data only — viewer is Phase 4).

**Architecture:** see spec `2026-05-21-cfd-tab-phase-3-design.md`. Reuse Phase 1's worker-thread + JobEmitter + 5-event surface, extending `JobProgressPayload` and `JobDoneSummary` to tagged unions. Engine seam = new optional `&mut dyn CycleObserver` arg on `advance_one_cycle`. Capture writes to `<Documents>/Helios/cfd/captures/<job_id>/...`.

**Tech Stack:** Rust 1.x · Tauri 2 · React 18 + TypeScript · uPlot · Vitest · pnpm/Turbo.

---

## Wave 1 — Engine seam + cfd-core capture types

### Task 1: CycleObserver trait + null-callback parity

**Files:**
- Modify `crates/engine-sim/src/model/sdm26.rs`
- Add test `crates/engine-sim/tests/cycle_observer_null_parity.rs`

- [ ] Add `pub trait CycleObserver { fn on_step(&mut self, theta_global_deg: f64, dt: f64, eng: &SDM26Engine); }`
- [ ] Extend `advance_one_cycle` signature with `observer: Option<&mut dyn CycleObserver>` (4th arg). Call `observer.on_step(...)` after each step if `Some`.
- [ ] Update existing callers in this crate (`run_single_rpm`) to pass `None`.
- [ ] Update existing callers in `cfd-core` runner to pass `None` (will be replaced in Wave 2).
- [ ] Update the 2 callers in tests (drive_runner_no_emit, etc.) to pass `None`.
- [ ] New test: 5-cycle SDM26 at 8000 RPM, capture CycleStats both with `None` and with a counting no-op observer; assert bitwise equal.
- [ ] Run full engine-sim test suite — all 45 parity tests + new one must pass.

### Task 2: cfd-core capture module skeleton

**Files:**
- Create `crates/cfd-core/src/capture/mod.rs`
- Create `crates/cfd-core/src/capture/pv.rs`
- Create `crates/cfd-core/src/capture/profiles.rs`
- Create `crates/cfd-core/src/capture/waves.rs`
- Modify `crates/cfd-core/src/lib.rs` to expose `pub mod capture;`

- [ ] `PvLoopRecorder { samples: Vec<Vec<PvSample>> }` (per-cylinder), `impl CycleObserver`.
  - `PvSample { theta_local_deg: f64, volume: f64, pressure: f64, temperature: f64, x_b: f64 }`
  - Sample per `on_step` call (no extra downsampling — ~10k pts/cycle is fine for one cycle).
- [ ] `PipeProfileRecorder { profiles: Vec<PipeProfile> }`, captures at FIRST `on_step` and overwrites each call (so when cycle ends we have the latest state). Easier alternative: snapshot once via a public method called by the runner after `advance_one_cycle` returns — pick this; observer is unused for profiles. So `PipeProfileRecorder::snapshot_from(eng)`. Don't make it a `CycleObserver`.
- [ ] `WaveFrameWriter` — owns a `BufWriter<File>` + `step_stride: u64` + step counter; emits a frame every `step_stride` steps. `impl CycleObserver` (writes via `on_step`). Owns its `JsonLineFormatter` to keep allocations bounded; serialize via `serde_json::to_writer` per frame followed by `\n`.
- [ ] `WaveFrameManifest` serializable struct matching spec §1.3. Method `WaveFrameWriter::finalize(self, frame_count, captured_cycle) -> io::Result<WaveFrameManifest>` flushes file and writes manifest.json sibling.
- [ ] Helper `compose2(Option<&mut A>, Option<&mut B>) -> Option<...>` is overkill; instead the runner manually drives both observers. Skip a generic composer.

### Task 3: cfd-core::capture unit tests

**Files:**
- Add tests in each `capture/*.rs` file under `#[cfg(test)]`

- [ ] `PvLoopRecorder`: run a 1-cycle SDM26, attach recorder, assert ≥100 samples per cylinder and theta values are monotonically wrapping in [0, 720).
- [ ] `PipeProfileRecorder`: snapshot from engine, assert n_pipes matches engine.pipes.len(), each profile length == real n_cells.
- [ ] `WaveFrameWriter`: write to a `tempfile::tempdir`, run 1 cycle with stride 100, assert manifest.json parses back, frame_count matches the JSONL line count.

---

## Wave 2 — Sweep runner + DTO surface

### Task 4: Extend DTOs

**Files:**
- Modify `crates/cfd-core/src/dto.rs`
- Mirror in `apps/desktop/src/modules/cfd/state/types.ts`

- [ ] Add `SweepParams`, `SweepPoint`, `SweepDoneSummary` Rust structs.
- [ ] Add `Sweep` variant to `StartJobRequest`.
- [ ] Add `Sweep` variant to `StudyKind`.
- [ ] Convert `JobProgressEvent.payload` from concrete `JobProgressSingleRpm` to `JobProgressPayload` tagged enum (variants per spec §2.2).
- [ ] Convert `JobDoneEvent.payload` to `JobDoneSummary` enum.
- [ ] Add `capture_waves`, `capture_pv_loops`, `capture_pipe_profiles` to `SingleRpmParams` (defaults: `false`, `true`, `true`).
- [ ] Update existing serde-roundtrip tests; add new tests for `Sweep` variant + `JobProgressPayload` tagged dispatch.
- [ ] Mirror everything in `types.ts`. Add `SweepStudy` interface to `Study` union. Add `JobProgressEvent.payload.kind` discriminator type.

### Task 5: Sweep job runner

**Files:**
- Modify `crates/cfd-core/src/runner.rs`

- [ ] New fn `run_sweep_job(emitter, probe, job_id, config_path, params: SweepParams, cancel, started_at, capture_root: PathBuf) -> RunOutcome`.
- [ ] Sequential per-RPM loop; build a fresh `SDM26Engine` per RPM (matches `engine_sim::model::sweep::run_sweep` semantics).
- [ ] Emit `SweepRpmStarted`, `SweepCycle`, `SweepRpmDone` events per spec §2.2.
- [ ] After convergence/exhaustion of cycles, run ONE additional capture cycle with `PvLoopRecorder` + `WaveFrameWriter` attached (if requested), then snapshot pipe profiles. This extra cycle does NOT emit a `SweepCycle` event and does NOT count in `n_cycles_run` — it's bookkeeping.
- [ ] Persist captures: `<capture_root>/<job_id>/sweep/<rpm_int>/{pv.json, profiles.json, waves.jsonl, manifest.json}`.
- [ ] Track cumulative step_count and wall_time for the SweepDoneSummary.
- [ ] Cancellation between RPMs → `JobCancelledEvent` with `partial_points` array.
- [ ] Cancellation mid-RPM → no `SweepRpmDone` for that RPM; still emit `JobCancelledEvent`.
- [ ] First-RPM-failure → emit `JobErrorEvent`; subsequent RPMs are skipped.

### Task 6: Update single-RPM runner for capture flags

**Files:**
- Modify `crates/cfd-core/src/runner.rs`
- Modify `apps/desktop/src-tauri/src/cfd/commands.rs`

- [ ] Apply the same "extra capture cycle" approach as sweep when `capture_pv_loops || capture_pipe_profiles || capture_waves`.
- [ ] Capture root for single-RPM: `<capture_root>/<job_id>/single-rpm/<rpm_int>/`.
- [ ] Add `capture_dir: Option<String>` to `SingleRpmDoneSummary` so the frontend knows where to fetch artifacts.

### Task 7: Tauri command wiring

**Files:**
- Modify `apps/desktop/src-tauri/src/cfd/commands.rs`
- Modify `apps/desktop/src-tauri/src/lib.rs`

- [ ] Pass `capture_root: <Documents>/Helios/cfd/captures` (computed via existing `cfd_default_save_dir` pattern) into both runner functions.
- [ ] `cfd_start_job` dispatch on `StartJobRequest::Sweep` to `run_sweep_job`.
- [ ] New command `cfd_load_capture(job_id: String, study_kind: StudyKind, rpm_int: u32, file: String) -> Result<serde_json::Value, String>` that reads `<capture_root>/<job_id>/<kind>/<rpm_int>/<file>` and returns parsed JSON. File whitelist: `pv.json`, `profiles.json`, `manifest.json`. (Not `waves.jsonl` — that's Phase 4.)
- [ ] Path-safety: reject any `..` in `file` argument.
- [ ] Register the new command in `invoke_handler!`.

### Task 8: Runner tests

**Files:**
- Modify `crates/cfd-core/src/runner.rs` (under `#[cfg(test)]`)

- [ ] Sweep happy path (3 RPMs × 2 cycles, captures off): assert event sequence, point count, `n_completed == 3`.
- [ ] Sweep cancellation between RPMs: assert `partial_points.len() == 1`, no `SweepRpmDone` for incomplete.
- [ ] Sweep cancellation mid-RPM: assert `JobCancelledEvent` came after some `SweepCycle` events but no `SweepRpmDone`.
- [ ] Sweep parity vs `engine_sim::model::sweep::run_sweep`: 3 RPMs, capture off, last `CycleStats` per RPM must match runner's last sweep_cycle event's stats within 1e-12 rel.
- [ ] Single-RPM with `capture_pv_loops=true`: assert pv.json appears in `<tempdir>/<job_id>/single-rpm/<rpm_int>/`, contents are an array of 4 cylinders each with ≥100 samples.

---

## Wave 3 — Frontend state + bridge

### Task 9: Frontend types + bridge

**Files:**
- Modify `apps/desktop/src/modules/cfd/state/types.ts`
- Modify `apps/desktop/src/modules/cfd/lib/tauriBridge.ts`

- [ ] Mirror Rust DTO changes from Task 4. Add `SweepStudy`, `SweepPoint`, `SweepParams`, `JobProgressPayload` discriminated union, `JobDoneSummary`.
- [ ] Bridge: add `loadCapture(jobId, studyKind, rpmInt, file)` calling `cfd_load_capture`.

### Task 10: Reducer updates

**Files:**
- Modify `apps/desktop/src/modules/cfd/state/CfdContext.tsx`
- Add `__tests__/cfd-context.sweep.test.tsx`

- [ ] Update `applyEventAction` to dispatch on `event.payload.kind`.
- [ ] New action handlers: `sweepRpmStarted`, `sweepCycle`, `sweepRpmDone`.
- [ ] `addStudy` overload for sweep.
- [ ] `startSweep(configPath, params)` on context value.
- [ ] Test: dispatch synthetic event sequence, assert resulting `SweepStudy.points` shape.

### Task 11: rpm-list parser

**Files:**
- Add `apps/desktop/src/modules/cfd/lib/rpmList.ts`
- Add `apps/desktop/src/modules/cfd/__tests__/rpmList.test.ts`

- [ ] `parseRpmList(input: string): { ok: true; rpms: number[] } | { ok: false; error: string }`.
- [ ] Support comma list, `a:b:step`, mixed; sort + dedupe; validate per-rpm range + total count.
- [ ] Round-trip helper `formatRpmList(rpms)` for default modal value.
- [ ] Tests: each input form, edge cases (negative step, step=0, count overflow, out-of-range RPM).

---

## Wave 4 — Studies screen + Sweep modal

### Task 12: StudiesScreen enables sweep

**Files:**
- Modify `apps/desktop/src/modules/cfd/screens/StudiesScreen.tsx`
- Add `apps/desktop/src/modules/cfd/__tests__/StudiesScreen.sweep.test.tsx`

- [ ] Replace disabled "RPM sweep (Phase 3)" card with enabled card → opens `SweepParamsModal`.
- [ ] New component `SweepParamsModal` inside StudiesScreen.tsx (or sibling file).
- [ ] Modal layout per spec §4.1, with RPM-list textarea + the three capture checkboxes.
- [ ] Live validation: show parser error inline below textarea; disable Start when invalid.
- [ ] Wire `startSweep` from context.
- [ ] Test: fill modal, start, assert `bridge.startJob` called with parsed rpm_list.

### Task 13: StudiesScreen row supports sweep kind

**Files:**
- Modify `apps/desktop/src/modules/cfd/screens/StudiesScreen.tsx`

- [ ] `StudyRow` dispatches on `study.kind`. Sweep row: "Sweep" tag, `${nRpms}rpm · ${junctionKind} · ${nCyclesMax}c/rpm` in params column, `cycles` column shows `nCompleted/nRpms`.
- [ ] Existing single-rpm path unchanged.

---

## Wave 5 — Results screens

### Task 14: ResultsScreen kind dispatch

**Files:**
- Modify `apps/desktop/src/modules/cfd/screens/ResultsScreen.tsx`
- Add `apps/desktop/src/modules/cfd/results/SweepResults.tsx`

- [ ] Add `case "sweep": return <SweepResults study={s} />`.
- [ ] `SweepResults` header strip (matching SingleRpmResults density), cancel button while running, displays counts (n_completed/n_rpms, total wall time, capture badges).

### Task 15: Sweep curves grid

**Files:**
- Modify `apps/desktop/src/modules/cfd/results/SweepResults.tsx`
- Reuse `apps/desktop/src/modules/cfd/components/charts/CycleChart.tsx` if it can be parameterized; else add `SweepChart.tsx`.

- [ ] Inspect CycleChart — if it's general enough (yLabel + series mapping), parameterize it to accept arbitrary x-axis (cycle or rpm). If not, copy as `SweepChart.tsx`.
- [ ] Four charts: IMEP/BMEP/FMEP vs RPM, VE vs RPM, EGT vs RPM, P_ind & P_brake vs RPM (dual axis).
- [ ] Inject the active study's points as the data source. Compare overlay (Task 17) uses the same chart with a second series spec.

### Task 16: Sweep per-RPM table + expansion

**Files:**
- Modify `apps/desktop/src/modules/cfd/results/SweepResults.tsx`

- [ ] Per-RPM table below the curves: rpm, converged_cycle, last_imep, last_ve, last_egt, last_p_ind, wall_time, capture badge.
- [ ] Row click expands inline: shows that RPM's cycle table (same shape as `SingleRpmResults` table) + buttons "Open P-V" and "Open profiles" if captures present.
- [ ] Cycle data per RPM is taken from `study.points[i].cycles` (populated as `SweepCycle` events arrive).

### Task 17: Sweep-vs-sweep compare

**Files:**
- Modify `apps/desktop/src/modules/cfd/results/SweepResults.tsx`

- [ ] Compare dropdown: list completed sweeps from `state.studies`, excluding self.
- [ ] On change, dispatch `setCompare`. Reducer stores `compareWithStudyId`.
- [ ] Charts overlay the comparison sweep's curves in muted `#5A5F66`. Legend shows both.
- [ ] Test: render with two sweeps, set compare, assert both series appear in DOM.

### Task 18: P-V loop + crank-angle traces view

**Files:**
- Add `apps/desktop/src/modules/cfd/results/PvLoopView.tsx`
- Add `apps/desktop/src/modules/cfd/__tests__/PvLoopView.test.tsx`

- [ ] Component takes `jobId`, `studyKind`, `rpmInt` props; calls `bridge.loadCapture(..., "pv.json")` on mount.
- [ ] Cylinder picker (radio chips 1..N).
- [ ] Two side-by-side panels: P-V loop and stacked (p(θ), T(θ), x_b(θ)) traces.
- [ ] Log/linear toggle for P axis.
- [ ] Inline button in `SingleRpmResults` and the SweepResults per-RPM expansion to open.
- [ ] Test: stub bridge to return a 4-cylinder pv.json, render, assert canvases mount and cylinder switching works.

### Task 19: End-of-cycle pipe profile view

**Files:**
- Add `apps/desktop/src/modules/cfd/results/PipeProfileView.tsx`
- Add `apps/desktop/src/modules/cfd/__tests__/PipeProfileView.test.tsx`

- [ ] Component takes the same `jobId/studyKind/rpmInt` props; loads `profiles.json`.
- [ ] One panel per pipe: 4 series (ρ, u, p, T) on left axis where compatible, p on right axis. Or 4 tiny stacked panels — pick simpler.
- [ ] Pipe role colored by role family (plenum=cyan, runner=yellow-ish, primary/secondary/collector=red-ish).
- [ ] Compare overlay (Phase 3.b nice-to-have): another sweep's nearest-RPM profile in muted color. Skip if time-pressed.
- [ ] Test: stub bridge with synthetic profiles.json (3 pipes × 10 cells), assert all panels render.

### Task 20: Single-RPM results gets P-V + profile buttons

**Files:**
- Modify `apps/desktop/src/modules/cfd/results/SingleRpmResults.tsx`

- [ ] When `study.summary?.captureDir` present, show "Open P-V" + "Open profiles" buttons.
- [ ] Clicking opens a panel below the cycles table (or a tab; keep it inline for simplicity).
- [ ] Don't refetch on every render — cache the parsed JSON in a `useState` once loaded.

---

## Wave 6 — Polish + change log

### Task 21: Wire `cfd_load_capture` capability

**Files:**
- Modify `apps/desktop/src-tauri/capabilities/default.json` if needed

- [ ] Verify `cfd_load_capture` doesn't need an additional capability (existing fs scope `**` covers it as a Rust-side filesystem read; the command is whitelisted in the invoke handler).
- [ ] Sanity: confirm command shows up in the auto-generated allowlist by running dev once.

### Task 22: dev smoke + parity check

- [ ] `pnpm --filter @helios/desktop typecheck`
- [ ] `pnpm --filter @helios/desktop test`
- [ ] `cargo test -p cfd-core`
- [ ] `cargo test -p engine-sim` (45 parity + 1 new observer parity test)
- [ ] Dev server + manual smoke: open SDM26 example → Studies → New Sweep → fill `6000:9000:1000` → start with all captures on → wait for completion → SweepResults shows curves, table, captures.

### Task 23: Change log entry

**Files:**
- Add `v2_changes/36-cfd-phase-3-sweeps-postcycle-viz.md`
- Update `v2_changes/README.md` index

- [ ] Document: what was added, the new event-payload shape (incl. wire-format change), capture file layout, deferred items (wave viewer = Phase 4).
- [ ] List the 7 new screens/components + the new Tauri command.

---

## Cuts (out of MVP unless time remains)

- Compare-overlay on PipeProfileView (Task 19 mentions but optional)
- Live status indicator showing how many wave frames have been written so far
- Re-running a single RPM from a completed sweep with different params

## Frequent commits

After each Wave (1–6), or after each pair of related tasks within a wave, commit with a brief message. Don't squash; the change log entry (Task 23) summarizes the whole phase.
