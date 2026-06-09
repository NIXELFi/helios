# CFD Competition-Events — Session Handoff (2026-06-08)

State snapshot for resuming work on the Helios CFD FSAE competition-scoring
feature. Companion to the design spec in this folder
(`2026-06-08-cfd-competition-events-design.md`).

## TL;DR

- **Branch:** `feat/cfd-competition-events`, pushed to `origin`
  (`github.com/NIXELFi/helios`). Latest commit **`f404276`**. `main` untouched —
  open a PR when ready to merge.
- **Everything this session is committed + pushed.** Working tree clean except
  the intentionally-excluded stale `worktrees/cfd-analytics/`.
- **354+ CFD tests green, `tsc` clean.** Pre-commit hook runs the full Rust
  physics-parity suite (~3 min) — never skip it.

## What shipped this session

1. **Event metric as an optimization objective** (commits `e821456`, `762604b`).
   FSAE event metrics are a first-class ranking dimension at BOTH setup (modal
   "Rank results by") and on results (a single "Rank by" control). One source of
   truth: `OptimizationResults` feeds `useOptimizationLive` a `viewStudy` whose
   `objectiveValue` is remapped to the chosen metric, so podium + all charts +
   table + the dimension-aware `TrialInspector` can never disagree. The backend
   sampler can't compute event metrics, so `CfdContext.startOptimization` strips
   `rankBy` before `startJob` but keeps it on the study as the results default.
2. **Real 2026 tracks** (commit `be2ee06`). Vendored the traced courses and made
   them the lap-sim defaults (replacing rules-synthesized placeholders).
3. **SDM26 / field calibration** (commit `be2ee06`). See "Model facts" below.
4. **Total points sums scorable events** (commit `f404276`) so "rank by total
   pts" works without a field accel Tmin.

## Model facts (calibration) — LOAD-BEARING

All scoring is **frontend**, in `apps/desktop/src/modules/cfd/lib/performance/`.
The optimizer sampler is space-filling (LHS/random) and every trial carries its
`sweepPoints`, so a TS re-rank picks the same winner a backend objective would.

- **Autocross = flat-out.** `muLat` 1.5 → **1.8** (in `SDM26_VEHICLE`) lands
  SDM26's real 42.922 s → ~90 pts (real 90.39). Accel stays ~4.2 s (`muLong` 1.5).
- **Endurance = managed race pace, NOT flat-out.** New `LapOpts.pace` (0..1)
  scales the whole speed envelope (corner ceilings + top-speed cap).
  `ENDURANCE_PACE = 0.71` (in `events.ts`) lands the Mines reference
  (159.6 s/lap). Rationale: even the fastest 2026 lap (142 s) was ~20 s off the
  flat-out physics — endurance is tire/fuel/cone-limited over 22 km.
- **Fuel:** `fuels.ts` defines Sunoco 93 / 100 / E85 (§D.13.4.1 CO₂ factors
  2.31 / 2.31 / 1.65). `ENDURANCE_THERMAL_EFF = 0.13` is a *lumped* tank-to-
  propulsive-work efficiency (engine BSFC × part-load/idle losses, intentionally
  below peak BSFC), calibrated to Mines' 0.9786 kg CO₂/lap on E85.
- **Efficiency score** uses real field EF anchors when present
  (`REFERENCE_2026.effMin 0.308 / effMax 0.839`) — reproduces Mines'
  FEF 0.536 → 43 pts exactly. `ReferenceBaseline` gained `effMin`/`effMax`.
- **Default baseline** = `REFERENCE_2026` (real field anchors). A
  "Load 2026 reference" button is on the Performance tab. `accelTMin` is `null`
  (no field accel data), so **total pts = autocross + endurance + efficiency**.

## Real 2026 reference data (for any re-calibration)

- **SDM26 autocross:** 42.922 s → 90.39 pts (19th). Flat-out, good data.
- **SDM26 endurance 152.441 s = OUT LAP + DNF → DISCARDED** (not representative).
- **Field autocross Tmin ≈ 39.04 s** (back-solved from 42.922 → 90.39).
- **Field endurance Tmin = 142.085 s** (= efficiency "Minimum" time;
  "Maximum" 206.024 s = 1.45 × Tmin = the eligibility cap, which confirms it).
- **Efficiency Minimum row:** 142.085 s / 0.5893 kg CO₂ / EF 0.308.
  **Maximum row:** 206.024 s / 1.3214 kg / EF 0.839.
- **Mines (calibration anchor):** Colorado School of Mines, CBR600RR on **E85**,
  closest competitor. ~159.6 s/lap (FEF-derived), 0.9786 kg CO₂/lap, FEF 0.536,
  efficiency score 43.
- **SDM26 uncalibrated torque curve fixture** (used to calibrate / for the
  calibration test): `crates/engine-sim/tests/fixtures/sweep_python_v1/
  sdm26_characteristic_4k_to_15k.csv` (brake_torque_Nm; peak ~62.6 Nm @ 8000,
  redline 14500).

## Key files

- `lib/performance/`: `vehicle.ts` (`SDM26_VEHICLE` muLat 1.8, `REFERENCE_2026`,
  `EMPTY_BASELINE`, gearing helpers), `track.ts` (`parseTrack`, `Track`,
  `RawTrack`, `synthesize*` fallbacks), `tracks2026.ts` + `tracks/*.json`
  (+ README provenance), `lapSim.ts` (`LapOpts.pace`), `events.ts`
  (`ENDURANCE_PACE`, `ENDURANCE_THERMAL_EFF`, `computeEvents`,
  `EVENT_RANK_METRICS`, `POINTS_METRIC_KEYS`), `fuels.ts`, `points.ts`,
  `accel.ts`, `tractive.ts`, `skidpad.ts`, `torqueCurve.ts`, `index.ts`.
- `results/OptimizationResults.tsx` (rank-by + viewStudy single source of truth),
  `results/TrialInspector.tsx` (dimension-aware `InspectorDim`).
- `components/optimization/OptimizationParamsModal.tsx` ("Rank results by"),
  `ObjectiveBuilder.tsx`, `ParameterPanel.tsx`.
- `screens/PerformanceScreen.tsx` (vehicle editor + "Reset to SDM26", baseline
  editor + "Load 2026 reference" + EF min/max fields, FSAE events table).
- `state/CfdContext.tsx` (default baseline `REFERENCE_2026`; `startOptimization`
  strips `rankBy`), `state/types.ts` (`OptimizationParams.rankBy`),
  `state/useOptimizationLive.ts` (unchanged ranking hook).

## How to RUN the optimization (Nick's immediate next goal)

The optimizer/parameter UI already exists; the optimization is a backend job
started from the app.

1. **Performance tab** — apply calibration to persisted state (localStorage
   overrides new presets): if **μ lat == 1.5**, click **"Reset to SDM26"**
   (→ 1.8). Click **"Load 2026 reference"** (→ real field anchors).
2. **New Optimization** on `sdm26.json` → pick tunables (e.g. runner length,
   plenum volume, restrictor) → **Rank results by → FSAE event · total pts**.
3. **Start.** Podium / charts / table rank by total FSAE points. Compare a
   trial's projected total vs the calibrated SDM26 baseline
   (≈ AX 90 + endurance ~185 + efficiency ~43).

## Gotchas

- **Persisted state overrides presets.** `vehicleConfig` rehydrate merges
  `{ ...SDM26_VEHICLE, ...persisted }` → an old persisted `muLat 1.5` wins until
  "Reset to SDM26". Default baseline only applies to fresh state → use
  "Load 2026 reference" on persisted state.
- **Pre-commit hook** runs the full Rust parity suite (~3 min). Don't skip.
- **Exclude `worktrees/cfd-analytics/`** from commits (stale worktree dir).
- **PowerShell here-strings mangle `git commit -m`** → write a message file and
  `git commit -F`.
- Optimizer scores **gasoline (Sunoco 93)** by default (SDM26's fuel); E85 is
  only used for the Mines calibration. Wiring a fuel selector is P3.

## Session 2 (2026-06-09) — P3/P4/P5 + import + track overview ALL SHIPPED

Branch `feat/cfd-competition-events`, all committed + pushed to origin.

- **P4 sensitivity tornado** (`819c03b`). `optimizationStats.ts` gains
  `spearman()` (avg-tie ranks) + `sensitivityTornado()`; `TornadoChart.tsx`
  (diverging SVG, favorability-colored); wired into `OptimizationResults` off
  the SAME view-remapped trials so "Rank by" re-derives sensitivity in that
  dimension; clicking a bar drives the scatter. Validated on Nick's real
  128-trial run: runner_length ρ −0.80 dominates.
- **Import study (JSON)** (`67d74be`). Export was one-way; added the inverse.
  `io.openTextFile()`, `lib/import/importStudy.ts` (`parseStudyImport` — pure,
  round-trips a bundle / `{studies:[]}` dump / bare array; fresh ids; skip-bad-
  keep-good), `CfdContext.importStudies()`, "Import (JSON)" button on Studies.
  Imported optimization trials keep sweepPoints → event ranking + tornado work.
- **Track overview** (`9ecec5c`). `trackGeometry.ts` `trackPlan()` (heading
  walk, "steer-to-straight" direction heuristic — SCHEMATIC, model is
  direction-agnostic) + `tightnessOf`/`TIGHTNESS_COLOR`; `TrackOverview.tsx`
  (plan view + faithful 1/R-vs-distance strip) on the Performance screen with
  an Autocross/Endurance toggle.
- **P5 light-mode export** (`cd3fee7`). `lib/export/designReport.ts`
  `buildDesignReportHtml()` — self-contained light HTML one-pager (inline CSS +
  SVG: vehicle, FSAE points, tractive chart, both track plans), prints to PDF.
  "Export report" button on the Performance screen.
- **P3 fuel switching** (`064d656`). Rust: `WiebeParams`/`SDM26Config` gain
  `afr_stoich` (default 14.7 → **parity byte-identical**; afr_eta_factor reads
  it for φ instead of a literal 14.7); loader reads it optional; params.rs
  meta + override. Frontend: `fuels.ts` gains `qLhvJkg`/`afrTarget`; a "Fuel
  preset" dropdown in the Combustion group sets q_lhv/afr_stoich/afr_target.
  Full parity suite green.

## Pending / next steps

1. Optional accuracy: real GPS curvature (replace traced segment tracks) — would
   also let the track overview show a TRUE layout (it's schematic today because
   the segment data carries radius magnitude but no turn direction); a field
   accel Tmin if obtained (folds accel into total pts automatically).
2. Optional: wire `octane` through the loader so a fuel's knock margin shows in
   the per-cycle knock integral (currently octane defaults to 95, no torque
   effect by design).
3. Optional: a P4 detail view / CSV export of the full Spearman table.

## Verify

```
cd apps/desktop
pnpm typecheck
pnpm exec vitest run src/modules/cfd        # 354+ tests
```
Calibration is pinned in `lib/performance/__tests__/calibration.test.ts`
(loose tolerances — conditions/driver/tire temps move the real numbers).
