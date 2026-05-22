# 37 — CFD Phase 5: Optimization Runs (v3.4.0)

DOE-based optimization for the CFD tab. Every numeric leaf in `SDM26Config` is
opt-in tunable with min/max/step bounds; the objective is fully flexible
(any `CycleStats` metric × any aggregator × any RPM list × maximize|minimize);
trials run in parallel via Latin Hypercube Sampling; results are dominated by
a brushable parallel-coordinates plot with click-to-drill-in trial inspection.

## Backend (cfd-core)

**New DTO surface** (`crates/cfd-core/src/dto.rs`)
- `ObjectiveAggregator` — tagged enum: `Max`, `Min`, `Mean`, `Auc` (trapezoidal),
  `Sum`, `AtRpm { rpm_int }`.
- `ObjectiveDirection` — `Maximize` | `Minimize`.
- `ObjectiveSpec { metric, aggregator, rpm_list, direction }`.
- `ParameterBounds { path, min, max, step }` — step `None` = continuous.
- `SamplerKind` — `Lhs` | `Random`.
- `OptimizationParams { tunables, objective, n_trials, sampler, seed,
  n_cycles_max, junction_kind, convergence_tol_imep, convergence_min_cycles }`.
- `StartJobRequest::Optimization { config_path, params }`.
- `StudyKind::Optimization`.
- `JobProgressPayload::OptimizationTrialStarted { job_id, trial_idx,
  parameter_values: BTreeMap<String, f64> }`.
- `JobProgressPayload::OptimizationTrialDone { job_id, trial_idx,
  objective_value, sweep_points, wall_time_s }`.
- `JobDoneSummary::Optimization(OptimizationDoneSummary { n_trials_requested,
  n_trials_run, best_trial_idx, best_objective_value, parameter_paths,
  objective_direction, total_wall_time_s })`.

**New modules**
- `crates/cfd-core/src/params.rs` — `ParameterMeta` (path, kind, array_len, unit,
  default, suggested_min/max, group); `enumerate_schema(cfg)` returns the full
  tunable surface for SDM26 (~50 entries across 9 groups: Geometry, Intake,
  Restrictor, Exhaust, Ambient, Combustion, Valves, Drivetrain, Numerics);
  `apply_override(cfg, path, value)` with `[N]` suffix for per-element targeting,
  uniform broadcast for arrays, integer rounding for `usize` leaves, and lazy
  `Option<Vec<_>>` materialization.
- `crates/cfd-core/src/optimization/sampler.rs` — Latin Hypercube + uniform
  random sampling, deterministic seeded `StdRng`.
- `crates/cfd-core/src/optimization/bounds.rs` — `map_to_physical(b, normalized)`
  with step-snap clamping.
- `crates/cfd-core/src/optimization/objective.rs` — `evaluate(spec, &points)`
  extracting any of the 22 `CycleStats` fields and folding via the chosen
  aggregator.

**Runner** (`crates/cfd-core/src/runner.rs`)
- `run_single_rpm_inline` — per-RPM helper that returns a `SweepPoint` without
  emit events or disk captures (factored out of `run_sweep_job`).
- `run_optimization_job` — Latin Hypercube samples N trials, maps to physical
  bounds, applies overrides per trial, runs `objective.rpm_list` through
  `run_single_rpm_inline`, evaluates the aggregator, and picks the best trial
  by direction. Trials parallelize via `rayon::par_iter`; cancel-token short-
  circuits at every cycle inside `run_single_rpm_inline`.

**Tauri commands** (`apps/desktop/src-tauri/src/cfd/commands.rs`)
- `cfd_start_job` extended with the `Optimization` arm — spawns the runner on
  a worker thread, emits `started` / `progress` / `done` events.
- `cfd_get_parameter_schema(config_path)` — returns `Vec<ParameterMeta>` for
  the frontend's parameter tree.

## Frontend (apps/desktop)

**Types** (`src/modules/cfd/state/types.ts`)
- `StudyKind` gains `"optimization"`.
- `ParameterMeta`, `ParameterBoundsUI`, `ObjectiveSpec`, `ObjectiveAggregator`,
  `OptimizationParams`, `OptimizationTrial`, `OptimizationStudy`.

**State** (`src/modules/cfd/state/CfdContext.tsx`)
- 3 new reducer actions: `addStudy` for the optimization variant, plus
  `optimizationTrialStarted`, `optimizationTrialDone`, `optimizationFinished`.
- Subscribes to `optimization-trial-started` and `optimization-trial-done`
  payload variants on the existing `cfd:job-progress` channel.
- `startOptimization(configPath, params)` public method on the context.

**Bridge** (`src/modules/cfd/lib/tauriBridge.ts`)
- `getParameterSchema(configPath)` and `startOptimization(configPath, params)`.

**UI** (`src/modules/cfd/components/optimization/`)
- `ParameterRow` — single config-leaf row: enable toggle, min, max, step,
  uniform-vs-per-element scope selector for array leaves.
- `ParameterPanel` — grouped tables (Geometry, Intake, Exhaust, …) seeded
  from `suggestedMin`/`suggestedMax` per leaf.
- `ObjectiveBuilder` — metric dropdown (15 curated `CycleStats` fields),
  aggregator picker, RPM-list text input with the existing `parseRpmList`,
  maximize/minimize toggle.
- `OptimizationParamsModal` — three-section modal: parameters → objective →
  sampling (trials, sampler, seed, n_cycles_max). Live validation with
  "min < max", RPM list parseability, at-rpm membership in RPM list,
  `n_trials ∈ [2,500]`. CTA shows `K params × N trials × M RPMs` summary.

**Results** (`src/modules/cfd/results/`)
- `OptimizationResults` — 2-column layout: parallel-coords + trial table on
  the left, `TrialInspector` on the right. Best trial highlighted amber.
- `TrialInspector` — selected trial's parameter values, plus per-RPM brake
  torque / brake power / IMEP curves via the existing `LinePlot`.
- `components/charts/ParallelCoordsPlot.tsx` — hand-rolled SVG primitive
  (no D3 dep): one polyline per trial, viridis-ish color by objective,
  click handler for selection, best-trial overlay.

**Studies entry point** (`screens/StudiesScreen.tsx`)
- The disabled "Optimization (Phase 5)" placeholder in the kind picker is
  replaced with an active option that opens `OptimizationParamsModal`.

**Storage** (`lib/cfdStorage.ts`)
- Quota-degradation chain extended for optimization studies: first drops
  per-trial sweep cycles, then sweep points, then trials, before failing.

## Tests

- **cfd-core unit**: 36 new tests (params: 10, sampler: 8, bounds: 6,
  objective: 12).
- **cfd-core e2e**: 4 new tests in `crates/cfd-core/tests/optimization_e2e.rs`
  exercising 4-trial optimization on bundled SDM26 with restrictor.cd as
  the tunable + cancel-propagation.
- **Frontend Vitest**: 14 new tests across `CfdContext` (4),
  `ParameterPanel` (3), `ObjectiveBuilder` (3), `ParallelCoordsPlot` (4).
- Full workspace: **252 Rust tests, 387 frontend tests passing.**

## Deferred (Phase 6)

- Bayesian / surrogate-driven optimization (current is LHS only).
- Multi-objective Pareto frontier (data shape leaves the door open).
- Live parameter heatmap from a fitted surrogate.
- Per-trial disk captures (currently in-memory `SweepPoint` only).
- Resume-from-trial-N after cancel.
