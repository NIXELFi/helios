# 36 — CFD tab Phase 3: sweeps, post-cycle viz, wave-capture plumbing

Phase 3 of the CFD tab build-out. Phase 1 was the tab scaffold + single-RPM driver. Phase 2 was the full SDM26 config editor. Phase 3 turns the tab into a real exploration surface by adding:

1. **Multi-RPM sweeps** — sweep a config across an arbitrary RPM list, streamed per-RPM per-cycle with curve plots of IMEP / VE / EGT / P_ind / P_brake vs RPM.
2. **Per-cylinder P-V loops + crank-angle traces** captured on the last cycle.
3. **End-of-cycle pipe profiles** — ρ, u, p, T along x for every pipe (plenum, runners, primaries, secondaries, collector).
4. **Sweep-vs-sweep comparison** — overlay a completed sweep on the active one in muted gray.
5. **Per-step wave-capture writer** — engine-sim seam + JSONL frame writer + manifest. **Writer-only this phase** — the engine-schematic animated viewer is Phase 4 pending recovery of the lost reference HTML viewer.

## Architecture changes

- `engine_sim::SDM26Engine::advance_one_cycle` now takes an optional `&mut dyn CycleObserver` fourth argument. A parity test ([`crates/engine-sim/tests/cycle_observer_null_parity.rs`](../crates/engine-sim/tests/cycle_observer_null_parity.rs)) guards that `None` and a no-op observer produce bit-identical CycleStats over 5 SDM26 cycles. The 45 existing parity tests still pass.
- New `cfd-core::capture` module:
  - `PvLoopRecorder` — implements `CycleObserver`, accumulates per-cylinder (θ_local, V, p, T, x_b) per step.
  - `PipeProfileRecorder` — pull-based; snapshots every pipe's real-cell primitives (ρ, u, p, T).
  - `WaveFrameWriter` — implements `CycleObserver`, streams downsampled per-step pipe+cylinder snapshots to JSONL with a sibling `manifest.json`. Stride is auto-picked from the previous cycle's step count for ~600 frames per captured cycle.
- New `cfd-core::runner::run_sweep_job` — sequential per-RPM driver. Emits five new event payload variants: `sweep-rpm-started`, `sweep-cycle`, `sweep-rpm-done`, plus `SweepDoneSummary` / `SweepPoint`.
- Event payloads are now tagged unions: `JobProgressEvent.payload` and `JobDoneEvent.payload` carry a `kind` discriminator. Backward-incompatible at the wire level; frontend updated in lockstep.
- `JobCancelledEvent` / `JobErrorEvent` carry both `partial_cycles` (single-RPM) and `partial_points` (sweep), plus a `kind` field.
- New Tauri command `cfd_load_capture(job_id, study_kind, rpm_int, file)` — whitelisted to `pv.json`, `profiles.json`, `manifest.json`. Reads from `<Documents>/Helios/cfd/captures/<job_id>/<kind>/<rpm_int>/`.
- `StartJobRequest::Sweep` and `StudyKind::Sweep` variants added.
- `SingleRpmParams` and `SweepParams` both carry `captureWaves`, `capturePvLoops`, `capturePipeProfiles` flags.

## Frontend changes

- `types.ts` — `SweepStudy` interface, `SweepParams`, `SweepPoint`, `JobProgressPayload` discriminated union, `JobDoneSummary` tagged union, `PvLoopArtifact`, `PipeProfileArtifact`, `PipeRole`.
- `state/CfdContext.tsx` — new actions for `sweepRpmStarted`, `sweepCycle`, `sweepRpmDone`, `setSweepCompare`. New `startSweep(configPath, params)` on the context. Reducer dispatches on `event.payload.kind`.
- `lib/rpmList.ts` — accepts comma-separated lists and `start:stop:step` ranges, mixed. Validates [500, 20000] per RPM, total count ≤ 50, sorted + deduped. 11 vitest cases.
- `lib/tauriBridge.ts` — `loadCapture` method.
- `screens/StudiesScreen.tsx` — enabled the previously disabled "RPM sweep" card. New `SweepParamsModal` with RPM-list textarea (live parser feedback), capture checkboxes, validation gate on Start. `StudyRow` renders both kinds.
- `screens/ResultsScreen.tsx` — dispatches `study.kind === "sweep"` to `SweepResults`.
- `results/SweepResults.tsx` — header with capture badge, compare dropdown, four curves (IMEP/BMEP/FMEP, VE, EGT, P_ind/P_brake) with comparison overlay in muted gray, per-RPM table with inline expand to P-V + profiles.
- `results/PvLoopView.tsx` — P-V loop + p(θ)/T(θ)/x_b(θ) panel with cylinder picker and log-P toggle. Loads `pv.json` via `cfd_load_capture`.
- `results/PipeProfileView.tsx` — per-pipe panel with ρ/u/p/T traces along the pipe axis. Role-colored.
- `components/charts/LinePlot.tsx` — generic uPlot XY line plot used by sweep curves, P-V loops, profiles. Supports per-series x arrays so compare-overlay sweeps with different RPM grids align via union x-axis.
- `results/SingleRpmResults.tsx` — "Show P-V" / "Show profiles" toggle buttons appear when captures are present in `study.summary.captureDir`.

## Capture file layout

```
<Documents>/Helios/cfd/captures/<job_id>/single-rpm/<rpm_int>/
    pv.json
    profiles.json
    waves.jsonl     (if captureWaves)
    manifest.json   (if captureWaves)

<Documents>/Helios/cfd/captures/<job_id>/sweep/<rpm_int>/
    ... same shape ...
```

## Tests

- **Rust:** engine-sim parity (45 existing + 1 new no-op-observer parity) all green. cfd-core 35 tests including 3 new capture tests (`PvLoopRecorder`, `PipeProfileRecorder`, `WaveFrameWriter`) and 3 new sweep runner tests (happy path event sequence, cancellation between RPMs with partial_points, sweep with capture writes to disk).
- **Frontend:** 377 vitest tests pass including 11 new rpm-list parser cases and the existing CfdContext / editor / ConfigScreen suites updated for the new event-payload shape.

## Deferred / not in this phase

- The animated engine-schematic wave viewer (cells colored by field, sized by pressure, scrub through theta) — Phase 4, gated on the user recovering the lost reference HTML viewer. The capture writer is here so when the viewer ships it has data on day 1.
- Optimization / sensitivity studies — Phase 5.
- Persistence of `points[]` arrays across reloads — sweep headers persist; bulk per-RPM data does not (matches Phase 1 behavior for `cycles[]`).
- Binary wave-frame format (msgpack) — JSON is fine for the writer-only phase; revisit when Phase 4 viewer reads them in JS.
