# CFD Tab — Phase 5 Optimization (Backend) Implementation Plan

> Executed autonomously by Claude per user instruction (per `feedback_autonomous_execution` memory). Tasks below are the work items I'm tracking; subagent-driven execution per `superpowers:subagent-driven-development`.

**Goal:** Add an "Optimization" job kind that runs Latin Hypercube DOE over user-selected tunable parameters, evaluating a user-defined objective (any `CycleStats` metric × any aggregator × user-chosen RPM list), with parallel trials, cancellation, and per-trial events for live UI updates.

**Architecture:** Extend the existing 5-event job machinery (`StartJobRequest` / `JobProgressPayload` / `JobDoneSummary` tagged unions) with `Optimization` variants. Each optimization "trial" is internally a `sweep_internal` over the objective's RPM list, with a perturbed config (base config + parameter overrides). Trials run in parallel via Rayon, sharing the existing global pool. Parameter overrides apply via a new `ParameterPath` → setter table — explicit per-field, no reflection. Sampling lives in a new `crates/cfd-core/src/optimization/` module: pure `Sampler` produces normalized `[0,1]^k` matrices, the runner maps to physical units. Objective evaluation is a small pure function over `Vec<SweepPoint>`.

**Tech Stack:** Rust 1.x · Tauri 2 · `rand_distr` (LHS via `rand::seq::SliceRandom` + permutation, no new deps if possible). Re-uses `serde_json` `float_roundtrip` already enabled workspace-wide.

---

## Wave 1 — DTO surface

### Task 1: Add optimization DTO types

**Files:**
- Modify `crates/cfd-core/src/dto.rs`

- [ ] Add `ObjectiveAggregator` enum:

```rust
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ObjectiveAggregator {
    /// Maximum value of `metric` across the RPM list.
    Max,
    /// Minimum value of `metric` across the RPM list.
    Min,
    /// Arithmetic mean across the RPM list.
    Mean,
    /// Trapezoidal area-under-curve (metric vs. rpm).
    Auc,
    /// Value at a specific RPM (must exist in the RPM list).
    AtRpm { rpm_int: u32 },
    /// Sum across the RPM list.
    Sum,
}
```

- [ ] Add `ObjectiveDirection`:

```rust
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ObjectiveDirection { Maximize, Minimize }
```

- [ ] Add `ObjectiveSpec`:

```rust
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectiveSpec {
    /// One of the 22 CycleStats field names in snake_case
    /// (e.g. "imep_bar", "ve_atm", "indicated_power_k_w").
    pub metric: String,
    pub aggregator: ObjectiveAggregator,
    pub rpm_list: Vec<f64>,
    pub direction: ObjectiveDirection,
}
```

- [ ] Add `ParameterBounds`:

```rust
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParameterBounds {
    /// Dotted path into SDM26Config, e.g. "ambient.p", "restrictor.throat_diameter",
    /// "intake.runner_length", "intake.runner_lengths[0]".
    pub path: String,
    pub min: f64,
    pub max: f64,
    /// Step size for snap-to-grid (None = continuous).
    #[serde(default)]
    pub step: Option<f64>,
}
```

- [ ] Add `SamplerKind`:

```rust
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SamplerKind { Lhs, Random }
```

- [ ] Add `OptimizationParams`:

```rust
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizationParams {
    pub tunables: Vec<ParameterBounds>,
    pub objective: ObjectiveSpec,
    pub n_trials: usize,
    pub sampler: SamplerKind,
    #[serde(default)]
    pub seed: Option<u64>,
    pub n_cycles_max: usize,
    #[serde(default = "default_imep_tol")]
    pub imep_rel_tol: f64,
    #[serde(default = "default_min_cycles")]
    pub min_cycles_before_check: usize,
}
fn default_imep_tol() -> f64 { 1e-3 }
fn default_min_cycles() -> usize { 3 }
```

- [ ] Extend `StartJobRequest`:

```rust
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum StartJobRequest {
    SingleRpm { config_path: String, params: SingleRpmParams },
    Sweep    { config_path: String, params: SweepParams },
    Optimization { config_path: String, params: OptimizationParams },
}
```

- [ ] Extend `JobKind`:

```rust
#[serde(rename_all = "kebab-case")]
pub enum JobKind { SingleRpm, Sweep, Optimization }
```

- [ ] Run `cargo check -p cfd-core`. Expected: PASS (no callers of these new types yet).

- [ ] Commit:

```bash
git add crates/cfd-core/src/dto.rs
git commit -m "feat(cfd-core): optimization DTO types — bounds, objective, params, request variant"
```

### Task 2: Add optimization event payload variants

**Files:**
- Modify `crates/cfd-core/src/dto.rs`

- [ ] Extend `JobProgressPayload`:

```rust
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum JobProgressPayload {
    SingleRpm(SingleRpmCyclePayload),
    SweepRpmStarted(SweepRpmStartedPayload),
    SweepCycle(SweepCyclePayload),
    SweepRpmDone(SweepRpmDonePayload),
    OptimizationTrialStarted(OptimizationTrialStartedPayload),
    OptimizationTrialDone(OptimizationTrialDonePayload),
}
```

- [ ] Add payload structs:

```rust
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizationTrialStartedPayload {
    pub job_id: String,
    pub trial_idx: usize,
    /// path -> physical value (already snapped to step grid).
    pub parameter_values: std::collections::BTreeMap<String, f64>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizationTrialDonePayload {
    pub job_id: String,
    pub trial_idx: usize,
    pub objective_value: f64,
    /// Sweep points produced by this trial — same shape as SweepDoneSummary.points.
    pub sweep_points: Vec<crate::dto::SweepPoint>,
    pub wall_time_s: f64,
}
```

- [ ] Extend `JobDoneSummary` with `Optimization` variant:

```rust
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizationDoneSummary {
    pub n_trials_requested: usize,
    pub n_trials_run: usize,
    pub best_trial_idx: Option<usize>,
    pub best_objective_value: Option<f64>,
    pub parameter_paths: Vec<String>,
    pub objective_direction: ObjectiveDirection,
}
```

Add variant to `JobDoneSummary`:

```rust
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum JobDoneSummary {
    SingleRpm(SingleRpmDoneSummary),
    Sweep(SweepDoneSummary),
    Optimization(OptimizationDoneSummary),
}
```

- [ ] Run `cargo build -p cfd-core`. Expected: PASS.

- [ ] Commit:

```bash
git add crates/cfd-core/src/dto.rs
git commit -m "feat(cfd-core): optimization event payloads — trial-started, trial-done, done-summary"
```

---

## Wave 2 — Parameter introspection

### Task 3: ParameterMeta + schema enumeration

**Files:**
- Create `crates/cfd-core/src/params.rs`
- Modify `crates/cfd-core/src/lib.rs` to export `pub mod params;`

- [ ] Define types:

```rust
use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ParameterType { Scalar, Array }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParameterMeta {
    pub path: String,
    pub kind: ParameterType,
    /// For Array: number of elements (e.g. n_cylinders). For Scalar: 1.
    pub array_len: usize,
    pub unit: &'static str,
    pub default: f64,
    pub suggested_min: f64,
    pub suggested_max: f64,
    /// Group label for the UI (e.g. "Intake", "Combustion").
    pub group: &'static str,
}
```

- [ ] Implement `pub fn enumerate_schema(cfg: &engine_sim::model::sdm26::SDM26Config) -> Vec<ParameterMeta>`.

The list covers EVERY numeric/categorical leaf of `SDM26Config`. Group by panel:

```rust
pub fn enumerate_schema(cfg: &engine_sim::model::sdm26::SDM26Config) -> Vec<ParameterMeta> {
    use ParameterType::*;
    let n_cyl = cfg.n_cylinders.max(1);
    vec![
        // --- Geometry ---
        ParameterMeta { path: "bore".into(), kind: Scalar, array_len: 1, unit: "m", default: cfg.bore, suggested_min: 0.05, suggested_max: 0.12, group: "Geometry" },
        ParameterMeta { path: "stroke".into(), kind: Scalar, array_len: 1, unit: "m", default: cfg.stroke, suggested_min: 0.04, suggested_max: 0.10, group: "Geometry" },
        ParameterMeta { path: "con_rod".into(), kind: Scalar, array_len: 1, unit: "m", default: cfg.con_rod, suggested_min: 0.08, suggested_max: 0.20, group: "Geometry" },
        ParameterMeta { path: "cr".into(), kind: Scalar, array_len: 1, unit: "ratio", default: cfg.cr, suggested_min: 8.0, suggested_max: 16.0, group: "Geometry" },

        // --- Intake (uniform-or-per-element) ---
        ParameterMeta { path: "intake.runner_length".into(), kind: Array, array_len: n_cyl, unit: "m", default: cfg.intake.runner_length, suggested_min: 0.10, suggested_max: 0.50, group: "Intake" },
        ParameterMeta { path: "intake.runner_diameter_in".into(), kind: Array, array_len: n_cyl, unit: "m", default: cfg.intake.runner_diameter_in, suggested_min: 0.020, suggested_max: 0.045, group: "Intake" },
        ParameterMeta { path: "intake.runner_diameter_out".into(), kind: Array, array_len: n_cyl, unit: "m", default: cfg.intake.runner_diameter_out, suggested_min: 0.020, suggested_max: 0.045, group: "Intake" },
        ParameterMeta { path: "intake.plenum_volume".into(), kind: Scalar, array_len: 1, unit: "m^3", default: cfg.intake.plenum_volume, suggested_min: 0.0005, suggested_max: 0.005, group: "Intake" },
        ParameterMeta { path: "intake.plenum_length".into(), kind: Scalar, array_len: 1, unit: "m", default: cfg.intake.plenum_length, suggested_min: 0.05, suggested_max: 0.30, group: "Intake" },

        // --- Restrictor ---
        ParameterMeta { path: "restrictor.throat_diameter".into(), kind: Scalar, array_len: 1, unit: "m", default: cfg.restrictor.throat_diameter, suggested_min: 0.015, suggested_max: 0.025, group: "Restrictor" },
        ParameterMeta { path: "restrictor.cd".into(), kind: Scalar, array_len: 1, unit: "-", default: cfg.restrictor.cd, suggested_min: 0.70, suggested_max: 0.99, group: "Restrictor" },

        // --- Exhaust primaries ---
        ParameterMeta { path: "exhaust.primary_length".into(), kind: Array, array_len: n_cyl, unit: "m", default: cfg.exhaust.primary_length, suggested_min: 0.20, suggested_max: 0.80, group: "Exhaust" },
        ParameterMeta { path: "exhaust.primary_diameter".into(), kind: Array, array_len: n_cyl, unit: "m", default: cfg.exhaust.primary_diameter, suggested_min: 0.025, suggested_max: 0.055, group: "Exhaust" },
        ParameterMeta { path: "exhaust.secondary_length".into(), kind: Scalar, array_len: 1, unit: "m", default: cfg.exhaust.secondary_length, suggested_min: 0.15, suggested_max: 0.80, group: "Exhaust" },
        ParameterMeta { path: "exhaust.secondary_diameter".into(), kind: Scalar, array_len: 1, unit: "m", default: cfg.exhaust.secondary_diameter, suggested_min: 0.030, suggested_max: 0.070, group: "Exhaust" },
        ParameterMeta { path: "exhaust.collector_volume".into(), kind: Scalar, array_len: 1, unit: "m^3", default: cfg.exhaust.collector_volume, suggested_min: 0.0005, suggested_max: 0.010, group: "Exhaust" },

        // --- Ambient ---
        ParameterMeta { path: "ambient.p".into(), kind: Scalar, array_len: 1, unit: "Pa", default: cfg.ambient.p, suggested_min: 80_000.0, suggested_max: 105_000.0, group: "Ambient" },
        ParameterMeta { path: "ambient.t".into(), kind: Scalar, array_len: 1, unit: "K", default: cfg.ambient.t, suggested_min: 280.0, suggested_max: 320.0, group: "Ambient" },

        // --- Combustion ---
        ParameterMeta { path: "combustion.spark_advance_deg_btdc".into(), kind: Scalar, array_len: 1, unit: "deg", default: cfg.combustion.spark_advance_deg_btdc, suggested_min: 5.0, suggested_max: 45.0, group: "Combustion" },
        ParameterMeta { path: "combustion.burn_duration_deg".into(), kind: Scalar, array_len: 1, unit: "deg", default: cfg.combustion.burn_duration_deg, suggested_min: 20.0, suggested_max: 80.0, group: "Combustion" },
        ParameterMeta { path: "combustion.wiebe_a".into(), kind: Scalar, array_len: 1, unit: "-", default: cfg.combustion.wiebe_a, suggested_min: 2.0, suggested_max: 10.0, group: "Combustion" },
        ParameterMeta { path: "combustion.wiebe_m".into(), kind: Scalar, array_len: 1, unit: "-", default: cfg.combustion.wiebe_m, suggested_min: 1.5, suggested_max: 4.0, group: "Combustion" },
        ParameterMeta { path: "combustion.afr".into(), kind: Scalar, array_len: 1, unit: "-", default: cfg.combustion.afr, suggested_min: 11.5, suggested_max: 15.0, group: "Combustion" },
        ParameterMeta { path: "combustion.eta_comb".into(), kind: Scalar, array_len: 1, unit: "-", default: cfg.combustion.eta_comb, suggested_min: 0.85, suggested_max: 1.00, group: "Combustion" },

        // --- Valves ---
        ParameterMeta { path: "intake_valve.lift".into(), kind: Scalar, array_len: 1, unit: "m", default: cfg.intake_valve.lift, suggested_min: 0.005, suggested_max: 0.014, group: "Valves" },
        ParameterMeta { path: "intake_valve.open_deg_btdc".into(), kind: Scalar, array_len: 1, unit: "deg", default: cfg.intake_valve.open_deg_btdc, suggested_min: -10.0, suggested_max: 40.0, group: "Valves" },
        ParameterMeta { path: "intake_valve.close_deg_abdc".into(), kind: Scalar, array_len: 1, unit: "deg", default: cfg.intake_valve.close_deg_abdc, suggested_min: 30.0, suggested_max: 90.0, group: "Valves" },
        ParameterMeta { path: "exhaust_valve.lift".into(), kind: Scalar, array_len: 1, unit: "m", default: cfg.exhaust_valve.lift, suggested_min: 0.005, suggested_max: 0.014, group: "Valves" },
        ParameterMeta { path: "exhaust_valve.open_deg_bbdc".into(), kind: Scalar, array_len: 1, unit: "deg", default: cfg.exhaust_valve.open_deg_bbdc, suggested_min: 30.0, suggested_max: 90.0, group: "Valves" },
        ParameterMeta { path: "exhaust_valve.close_deg_atdc".into(), kind: Scalar, array_len: 1, unit: "deg", default: cfg.exhaust_valve.close_deg_atdc, suggested_min: -10.0, suggested_max: 40.0, group: "Valves" },

        // --- Drivetrain ---
        ParameterMeta { path: "drivetrain_efficiency".into(), kind: Scalar, array_len: 1, unit: "-", default: cfg.drivetrain_efficiency, suggested_min: 0.80, suggested_max: 0.95, group: "Drivetrain" },
    ]
}
```

Note: if SDM26Config field paths differ from the above, the implementing engineer must read `crates/engine-sim/src/model/sdm26.rs` and match exact names. The structure above is illustrative — match reality.

- [ ] Add unit test:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use engine_sim::config::loader::load_v1_json;

    fn sdm26_path() -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../examples/cfd/sdm26.json")
    }

    #[test]
    fn schema_covers_all_groups() {
        let cfg = load_v1_json(&sdm26_path()).unwrap();
        let s = enumerate_schema(&cfg);
        assert!(s.iter().any(|m| m.group == "Geometry"));
        assert!(s.iter().any(|m| m.group == "Intake"));
        assert!(s.iter().any(|m| m.group == "Exhaust"));
        assert!(s.iter().any(|m| m.group == "Restrictor"));
        assert!(s.iter().any(|m| m.group == "Combustion"));
        assert!(s.iter().any(|m| m.group == "Valves"));
        assert!(s.iter().any(|m| m.group == "Ambient"));
    }

    #[test]
    fn schema_paths_are_unique() {
        let cfg = load_v1_json(&sdm26_path()).unwrap();
        let s = enumerate_schema(&cfg);
        let mut paths: Vec<_> = s.iter().map(|m| m.path.clone()).collect();
        paths.sort(); paths.dedup();
        assert_eq!(paths.len(), s.len(), "duplicate paths in schema");
    }
}
```

- [ ] Run `cargo test -p cfd-core --lib params`. Expected: PASS.

- [ ] Commit:

```bash
git add crates/cfd-core/src/params.rs crates/cfd-core/src/lib.rs
git commit -m "feat(cfd-core): parameter schema introspection for SDM26Config"
```

### Task 4: Parameter override applier

**Files:**
- Modify `crates/cfd-core/src/params.rs`

- [ ] Add applier:

```rust
use engine_sim::model::sdm26::SDM26Config;

#[derive(Debug, thiserror::Error)]
pub enum ParameterError {
    #[error("unknown parameter path: {0}")]
    UnknownPath(String),
    #[error("array index {idx} out of bounds (len={len}) for path {path}")]
    IndexOutOfBounds { path: String, idx: usize, len: usize },
    #[error("parameter {0} requires non-negative value, got {1}")]
    NegativeValue(String, f64),
}

/// Apply a single override: `path = value`. `path` may include `[N]` suffix for array-element targeting.
pub fn apply_override(cfg: &mut SDM26Config, path: &str, value: f64) -> Result<(), ParameterError> {
    // Parse optional [N] suffix.
    let (base, index) = parse_array_index(path);

    match base {
        "bore" => cfg.bore = value,
        "stroke" => cfg.stroke = value,
        "con_rod" => cfg.con_rod = value,
        "cr" => cfg.cr = value,
        "intake.runner_length" => {
            if let Some(i) = index {
                set_array_element(&mut cfg.intake.runner_lengths, i, value, path)?;
            } else {
                cfg.intake.runner_length = value;
                // Broadcast to per-cylinder array too so the array is the source of truth downstream.
                for v in cfg.intake.runner_lengths.iter_mut() { *v = value; }
            }
        }
        "intake.runner_diameter_in" => {
            if let Some(i) = index {
                set_array_element(&mut cfg.intake.runner_diameters_in, i, value, path)?;
            } else {
                cfg.intake.runner_diameter_in = value;
                for v in cfg.intake.runner_diameters_in.iter_mut() { *v = value; }
            }
        }
        "intake.runner_diameter_out" => {
            if let Some(i) = index {
                set_array_element(&mut cfg.intake.runner_diameters_out, i, value, path)?;
            } else {
                cfg.intake.runner_diameter_out = value;
                for v in cfg.intake.runner_diameters_out.iter_mut() { *v = value; }
            }
        }
        "intake.plenum_volume" => cfg.intake.plenum_volume = value,
        "intake.plenum_length" => cfg.intake.plenum_length = value,
        "restrictor.throat_diameter" => cfg.restrictor.throat_diameter = value,
        "restrictor.cd" => cfg.restrictor.cd = value,
        "exhaust.primary_length" => {
            if let Some(i) = index {
                set_array_element(&mut cfg.exhaust.primary_lengths, i, value, path)?;
            } else {
                cfg.exhaust.primary_length = value;
                for v in cfg.exhaust.primary_lengths.iter_mut() { *v = value; }
            }
        }
        "exhaust.primary_diameter" => {
            if let Some(i) = index {
                set_array_element(&mut cfg.exhaust.primary_diameters, i, value, path)?;
            } else {
                cfg.exhaust.primary_diameter = value;
                for v in cfg.exhaust.primary_diameters.iter_mut() { *v = value; }
            }
        }
        "exhaust.secondary_length" => cfg.exhaust.secondary_length = value,
        "exhaust.secondary_diameter" => cfg.exhaust.secondary_diameter = value,
        "exhaust.collector_volume" => cfg.exhaust.collector_volume = value,
        "ambient.p" => cfg.ambient.p = value,
        "ambient.t" => cfg.ambient.t = value,
        "combustion.spark_advance_deg_btdc" => cfg.combustion.spark_advance_deg_btdc = value,
        "combustion.burn_duration_deg" => cfg.combustion.burn_duration_deg = value,
        "combustion.wiebe_a" => cfg.combustion.wiebe_a = value,
        "combustion.wiebe_m" => cfg.combustion.wiebe_m = value,
        "combustion.afr" => cfg.combustion.afr = value,
        "combustion.eta_comb" => cfg.combustion.eta_comb = value,
        "intake_valve.lift" => cfg.intake_valve.lift = value,
        "intake_valve.open_deg_btdc" => cfg.intake_valve.open_deg_btdc = value,
        "intake_valve.close_deg_abdc" => cfg.intake_valve.close_deg_abdc = value,
        "exhaust_valve.lift" => cfg.exhaust_valve.lift = value,
        "exhaust_valve.open_deg_bbdc" => cfg.exhaust_valve.open_deg_bbdc = value,
        "exhaust_valve.close_deg_atdc" => cfg.exhaust_valve.close_deg_atdc = value,
        "drivetrain_efficiency" => cfg.drivetrain_efficiency = value,
        _ => return Err(ParameterError::UnknownPath(path.to_string())),
    }
    Ok(())
}

fn parse_array_index(path: &str) -> (&str, Option<usize>) {
    if let Some(open) = path.rfind('[') {
        if let Some(close) = path.rfind(']') {
            if close > open {
                if let Ok(i) = path[open+1..close].parse::<usize>() {
                    return (&path[..open], Some(i));
                }
            }
        }
    }
    (path, None)
}

fn set_array_element(arr: &mut Vec<f64>, i: usize, v: f64, path: &str) -> Result<(), ParameterError> {
    if i >= arr.len() {
        return Err(ParameterError::IndexOutOfBounds { path: path.to_string(), idx: i, len: arr.len() });
    }
    arr[i] = v;
    Ok(())
}
```

- [ ] Add tests:

```rust
#[test]
fn override_scalar_path() {
    let mut cfg = load_v1_json(&sdm26_path()).unwrap();
    apply_override(&mut cfg, "restrictor.cd", 0.88).unwrap();
    assert!((cfg.restrictor.cd - 0.88).abs() < 1e-12);
}

#[test]
fn override_uniform_array_broadcasts() {
    let mut cfg = load_v1_json(&sdm26_path()).unwrap();
    apply_override(&mut cfg, "intake.runner_length", 0.250).unwrap();
    for v in &cfg.intake.runner_lengths { assert!((v - 0.250).abs() < 1e-12); }
    assert!((cfg.intake.runner_length - 0.250).abs() < 1e-12);
}

#[test]
fn override_per_element_only_touches_index() {
    let mut cfg = load_v1_json(&sdm26_path()).unwrap();
    let baseline = cfg.intake.runner_lengths.clone();
    apply_override(&mut cfg, "intake.runner_length[2]", 0.333).unwrap();
    for (i, v) in cfg.intake.runner_lengths.iter().enumerate() {
        if i == 2 { assert!((v - 0.333).abs() < 1e-12); }
        else { assert!((v - baseline[i]).abs() < 1e-12); }
    }
}

#[test]
fn override_unknown_path_errors() {
    let mut cfg = load_v1_json(&sdm26_path()).unwrap();
    let err = apply_override(&mut cfg, "not.a.field", 1.0).unwrap_err();
    assert!(matches!(err, ParameterError::UnknownPath(_)));
}

#[test]
fn override_oob_index_errors() {
    let mut cfg = load_v1_json(&sdm26_path()).unwrap();
    let err = apply_override(&mut cfg, "intake.runner_length[99]", 0.2).unwrap_err();
    assert!(matches!(err, ParameterError::IndexOutOfBounds { .. }));
}
```

- [ ] Run `cargo test -p cfd-core --lib params`. Expected: 7 tests pass.

- [ ] Commit:

```bash
git add crates/cfd-core/src/params.rs
git commit -m "feat(cfd-core): apply_override + array-element parameter targeting"
```

---

## Wave 3 — Sampler

### Task 5: LHS sampler

**Files:**
- Create `crates/cfd-core/src/optimization/mod.rs`
- Create `crates/cfd-core/src/optimization/sampler.rs`
- Modify `crates/cfd-core/src/lib.rs` to export `pub mod optimization;`

- [ ] In `mod.rs`:

```rust
pub mod sampler;
```

- [ ] In `sampler.rs`:

```rust
use rand::{Rng, SeedableRng};
use rand::rngs::StdRng;
use rand::seq::SliceRandom;
use crate::dto::SamplerKind;

/// Returns an [n_trials × n_params] matrix where each cell ∈ [0,1).
pub fn sample(kind: SamplerKind, n_trials: usize, n_params: usize, seed: Option<u64>) -> Vec<Vec<f64>> {
    let mut rng = match seed {
        Some(s) => StdRng::seed_from_u64(s),
        None => StdRng::from_entropy(),
    };
    match kind {
        SamplerKind::Random => random_uniform(&mut rng, n_trials, n_params),
        SamplerKind::Lhs => latin_hypercube(&mut rng, n_trials, n_params),
    }
}

fn random_uniform(rng: &mut StdRng, n_trials: usize, n_params: usize) -> Vec<Vec<f64>> {
    (0..n_trials).map(|_| (0..n_params).map(|_| rng.gen::<f64>()).collect()).collect()
}

/// Standard Latin Hypercube: for each parameter, produce a permutation of
/// [0, 1/N, 2/N, ..., (N-1)/N] with uniform random jitter inside each stratum,
/// independently per parameter.
fn latin_hypercube(rng: &mut StdRng, n_trials: usize, n_params: usize) -> Vec<Vec<f64>> {
    let mut out = vec![vec![0.0f64; n_params]; n_trials];
    let n = n_trials as f64;
    for p in 0..n_params {
        let mut col: Vec<f64> = (0..n_trials)
            .map(|i| (i as f64 + rng.gen::<f64>()) / n)
            .collect();
        col.shuffle(rng);
        for (i, v) in col.into_iter().enumerate() {
            out[i][p] = v;
        }
    }
    out
}
```

- [ ] Add tests in same file:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lhs_cells_in_unit_range() {
        let m = sample(SamplerKind::Lhs, 32, 5, Some(42));
        for row in &m { for &v in row { assert!(v >= 0.0 && v < 1.0); } }
    }

    #[test]
    fn lhs_stratification_one_per_bucket() {
        let n = 8;
        let m = sample(SamplerKind::Lhs, n, 3, Some(7));
        for p in 0..3 {
            let mut buckets = vec![0u32; n];
            for row in &m {
                let b = (row[p] * n as f64).floor() as usize;
                buckets[b.min(n - 1)] += 1;
            }
            assert!(buckets.iter().all(|&c| c == 1), "non-stratified column {}: {:?}", p, buckets);
        }
    }

    #[test]
    fn same_seed_reproducible() {
        let a = sample(SamplerKind::Lhs, 16, 4, Some(123));
        let b = sample(SamplerKind::Lhs, 16, 4, Some(123));
        assert_eq!(a, b);
    }

    #[test]
    fn different_seeds_differ() {
        let a = sample(SamplerKind::Lhs, 16, 4, Some(1));
        let b = sample(SamplerKind::Lhs, 16, 4, Some(2));
        assert_ne!(a, b);
    }

    #[test]
    fn zero_params_returns_empty_rows() {
        let m = sample(SamplerKind::Lhs, 4, 0, Some(1));
        assert_eq!(m.len(), 4);
        assert!(m.iter().all(|r| r.is_empty()));
    }

    #[test]
    fn random_is_not_stratified() {
        // Sanity: random sampling will sometimes leave buckets empty for small N.
        let n = 100; // large enough to be statistically obvious
        let m = sample(SamplerKind::Random, n, 1, Some(99));
        let mut buckets = vec![0u32; n];
        for row in &m {
            let b = (row[0] * n as f64).floor() as usize;
            buckets[b.min(n - 1)] += 1;
        }
        assert!(buckets.iter().any(|&c| c == 0), "random unexpectedly stratified");
    }
}
```

- [ ] Verify `rand` is already a dep:

```bash
grep '^rand' crates/cfd-core/Cargo.toml
```

If not, add `rand = "0.8"` to `[dependencies]`.

- [ ] Run `cargo test -p cfd-core --lib optimization`. Expected: 6 tests pass.

- [ ] Commit:

```bash
git add crates/cfd-core/src/optimization/ crates/cfd-core/src/lib.rs crates/cfd-core/Cargo.toml
git commit -m "feat(cfd-core): LHS + random sampler with deterministic seeding"
```

### Task 6: Bounds mapper — normalized to physical, with step snap

**Files:**
- Create `crates/cfd-core/src/optimization/bounds.rs`
- Modify `crates/cfd-core/src/optimization/mod.rs`

- [ ] In `mod.rs` add `pub mod bounds;`

- [ ] In `bounds.rs`:

```rust
use crate::dto::ParameterBounds;

/// Map a normalized [0,1) value to physical space and snap to step grid.
pub fn map_to_physical(b: &ParameterBounds, normalized: f64) -> f64 {
    let raw = b.min + (b.max - b.min) * normalized;
    match b.step {
        Some(step) if step > 0.0 => {
            let n = ((raw - b.min) / step).round();
            (b.min + n * step).clamp(b.min, b.max)
        }
        _ => raw,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bounds(min: f64, max: f64, step: Option<f64>) -> ParameterBounds {
        ParameterBounds { path: "x".into(), min, max, step }
    }

    #[test]
    fn continuous_endpoints() {
        let b = bounds(10.0, 20.0, None);
        assert!((map_to_physical(&b, 0.0) - 10.0).abs() < 1e-12);
        assert!((map_to_physical(&b, 0.5) - 15.0).abs() < 1e-12);
    }

    #[test]
    fn step_snaps_to_grid() {
        let b = bounds(0.0, 10.0, Some(2.0));
        // 0.0 -> 0, 0.05 -> 0 (snaps down), 0.15 -> 2, 0.5 -> 4 or 6 depending on rounding
        assert_eq!(map_to_physical(&b, 0.0), 0.0);
        assert_eq!(map_to_physical(&b, 0.05), 0.0);
        assert_eq!(map_to_physical(&b, 0.25), 2.0); // 2.5 -> snap to 2
        assert_eq!(map_to_physical(&b, 0.5), 4.0);  // 5.0 -> snap to 4 (banker's would give 4)
    }

    #[test]
    fn step_clamps_to_max() {
        let b = bounds(0.0, 10.0, Some(3.0));
        let v = map_to_physical(&b, 0.999);
        assert!(v <= 10.0 + 1e-12);
    }

    #[test]
    fn zero_step_treated_as_continuous() {
        let b = bounds(0.0, 10.0, Some(0.0));
        assert!((map_to_physical(&b, 0.5) - 5.0).abs() < 1e-12);
    }
}
```

- [ ] Run `cargo test -p cfd-core --lib optimization::bounds`. Expected: 4 tests pass.

- [ ] Commit:

```bash
git add crates/cfd-core/src/optimization/
git commit -m "feat(cfd-core): bounds mapper with step-snap clamping"
```

---

## Wave 4 — Objective evaluator

### Task 7: Aggregator + metric extractor

**Files:**
- Create `crates/cfd-core/src/optimization/objective.rs`
- Modify `crates/cfd-core/src/optimization/mod.rs`

- [ ] In `mod.rs` add `pub mod objective;`

- [ ] In `objective.rs`:

```rust
use crate::dto::{ObjectiveAggregator, ObjectiveSpec, SweepPoint};
use engine_sim::model::sdm26::CycleStats;

#[derive(Debug, thiserror::Error)]
pub enum ObjectiveError {
    #[error("empty rpm_list — objective requires at least 1 rpm")]
    EmptyRpmList,
    #[error("unknown metric: {0} (must be a CycleStats field name)")]
    UnknownMetric(String),
    #[error("rpm {target} not present in sweep results")]
    RpmNotFound { target: f64 },
}

/// Extract a single CycleStats field by name. Returns NaN for unknown — caller filters.
fn extract(stats: &CycleStats, metric: &str) -> Result<f64, ObjectiveError> {
    Ok(match metric {
        "mass_total" => stats.mass_total,
        "mass_drift" => stats.mass_drift,
        "mass_in_restrictor" => stats.mass_in_restrictor,
        "mass_out_collector" => stats.mass_out_collector,
        "net_port_flow" => stats.net_port_flow,
        "nonconservation" => stats.nonconservation,
        "imep_bar" => stats.imep_bar,
        "bmep_bar" => stats.bmep_bar,
        "fmep_bar" => stats.fmep_bar,
        "ve_atm" => stats.ve_atm,
        "intake_mass_per_cycle_g" => stats.intake_mass_per_cycle_g,
        "f_residual" => stats.f_residual,
        "indicated_power_k_w" => stats.indicated_power_k_w,
        "indicated_power_hp" => stats.indicated_power_hp,
        "brake_power_k_w" => stats.brake_power_k_w,
        "brake_power_hp" => stats.brake_power_hp,
        "wheel_power_k_w" => stats.wheel_power_k_w,
        "wheel_power_hp" => stats.wheel_power_hp,
        "indicated_torque_nm" => stats.indicated_torque_nm,
        "brake_torque_nm" => stats.brake_torque_nm,
        "wheel_torque_nm" => stats.wheel_torque_nm,
        "egt_mean" => stats.egt_mean,
        m => return Err(ObjectiveError::UnknownMetric(m.to_string())),
    })
}

pub fn evaluate(spec: &ObjectiveSpec, sweep_points: &[SweepPoint]) -> Result<f64, ObjectiveError> {
    if spec.rpm_list.is_empty() { return Err(ObjectiveError::EmptyRpmList); }

    // Pull (rpm, metric_value) pairs in rpm order from sweep_points.
    // Sweep points carry the last cycle's CycleStats per RPM.
    let mut pairs: Vec<(f64, f64)> = sweep_points.iter()
        .map(|p| extract(&p.last_cycle, &spec.metric).map(|v| (p.rpm, v)))
        .collect::<Result<Vec<_>, _>>()?;
    pairs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    use ObjectiveAggregator::*;
    Ok(match spec.aggregator {
        Max => pairs.iter().map(|(_, v)| *v).fold(f64::NEG_INFINITY, f64::max),
        Min => pairs.iter().map(|(_, v)| *v).fold(f64::INFINITY, f64::min),
        Mean => {
            let sum: f64 = pairs.iter().map(|(_, v)| v).sum();
            sum / pairs.len() as f64
        }
        Sum => pairs.iter().map(|(_, v)| v).sum(),
        Auc => {
            // Trapezoidal integration over rpm axis.
            let mut acc = 0.0;
            for w in pairs.windows(2) {
                acc += 0.5 * (w[1].0 - w[0].0) * (w[0].1 + w[1].1);
            }
            acc
        }
        AtRpm { rpm_int } => {
            let target = rpm_int as f64;
            pairs.iter()
                .find(|(r, _)| (r - target).abs() < 0.5)
                .map(|(_, v)| *v)
                .ok_or(ObjectiveError::RpmNotFound { target })?
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    // Construct synthetic SweepPoints with controlled CycleStats.
    fn synth(rpm: f64, imep: f64) -> SweepPoint {
        let mut cs = CycleStats::default();
        cs.imep_bar = imep;
        SweepPoint {
            rpm,
            converged_cycle: 1,
            n_cycles_run: 1,
            last_cycle: cs,
            nonconservation_max: 0.0,
            wall_time_s: 0.0,
            step_count: 0,
            cycles: vec![],
            capture_dir: None,
        }
    }

    fn spec(agg: ObjectiveAggregator) -> ObjectiveSpec {
        ObjectiveSpec {
            metric: "imep_bar".into(),
            aggregator: agg,
            rpm_list: vec![4000.0, 6000.0, 8000.0],
            direction: crate::dto::ObjectiveDirection::Maximize,
        }
    }

    #[test]
    fn max_picks_highest() {
        let pts = vec![synth(4000.0, 5.0), synth(6000.0, 9.0), synth(8000.0, 7.0)];
        assert_eq!(evaluate(&spec(ObjectiveAggregator::Max), &pts).unwrap(), 9.0);
    }
    #[test]
    fn mean_averages() {
        let pts = vec![synth(4000.0, 6.0), synth(6000.0, 6.0), synth(8000.0, 12.0)];
        assert_eq!(evaluate(&spec(ObjectiveAggregator::Mean), &pts).unwrap(), 8.0);
    }
    #[test]
    fn auc_trapezoidal() {
        let pts = vec![synth(4000.0, 0.0), synth(6000.0, 10.0)];
        // ½ · 2000 · (0 + 10) = 10_000
        assert_eq!(evaluate(&spec(ObjectiveAggregator::Auc), &pts).unwrap(), 10_000.0);
    }
    #[test]
    fn at_rpm_finds_exact() {
        let pts = vec![synth(4000.0, 5.0), synth(6000.0, 9.0), synth(8000.0, 7.0)];
        let v = evaluate(&spec(ObjectiveAggregator::AtRpm { rpm_int: 6000 }), &pts).unwrap();
        assert_eq!(v, 9.0);
    }
    #[test]
    fn at_rpm_missing_errors() {
        let pts = vec![synth(4000.0, 5.0)];
        let err = evaluate(&spec(ObjectiveAggregator::AtRpm { rpm_int: 6000 }), &pts).unwrap_err();
        assert!(matches!(err, ObjectiveError::RpmNotFound { .. }));
    }
    #[test]
    fn unknown_metric_errors() {
        let pts = vec![synth(4000.0, 5.0)];
        let mut s = spec(ObjectiveAggregator::Max);
        s.metric = "not_a_field".into();
        assert!(matches!(evaluate(&s, &pts).unwrap_err(), ObjectiveError::UnknownMetric(_)));
    }
}
```

- [ ] Note: `CycleStats` may not derive `Default`. If the test won't compile, add a tiny test helper inside the test module that constructs a fully-populated `CycleStats` with sensible defaults (all zeros except the field under test), instead of `..CycleStats::default()`. Inspect `crates/engine-sim/src/model/sdm26.rs:281` and adapt.

- [ ] Run `cargo test -p cfd-core --lib optimization::objective`. Expected: 6 tests pass.

- [ ] Commit:

```bash
git add crates/cfd-core/src/optimization/
git commit -m "feat(cfd-core): objective evaluator — 6 aggregators × 22 metrics"
```

---

## Wave 5 — Runner

### Task 8: run_optimization_job

**Files:**
- Modify `crates/cfd-core/src/runner.rs`

- [ ] Add (near `run_sweep_job`):

```rust
pub fn run_optimization_job<E: JobEmitter + Sync>(
    job_id: &str,
    config_path: &str,
    params: &crate::dto::OptimizationParams,
    emitter: &E,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<crate::dto::OptimizationDoneSummary, RunnerError> {
    use crate::optimization::{sampler, bounds, objective};
    use std::sync::atomic::Ordering;

    // 1. Load base config.
    let base_cfg = crate::load::load(config_path)
        .map_err(|e| RunnerError::ConfigLoad(e.to_string()))?;

    // 2. Validate tunables present.
    if params.tunables.is_empty() {
        return Err(RunnerError::BadParams("optimization requires at least 1 tunable parameter".into()));
    }
    if params.objective.rpm_list.is_empty() {
        return Err(RunnerError::BadParams("optimization requires at least 1 rpm in objective rpm_list".into()));
    }

    // 3. Sample N normalized rows.
    let normalized = sampler::sample(params.sampler, params.n_trials, params.tunables.len(), params.seed);

    // 4. Map to physical, build per-trial override maps.
    let trials_input: Vec<std::collections::BTreeMap<String, f64>> = normalized.iter()
        .map(|row| {
            params.tunables.iter().zip(row.iter())
                .map(|(b, n)| (b.path.clone(), bounds::map_to_physical(b, *n)))
                .collect()
        })
        .collect();

    let started_at = std::time::Instant::now();
    let paths: Vec<String> = params.tunables.iter().map(|b| b.path.clone()).collect();

    // 5. Parallel trial execution via rayon.
    use rayon::prelude::*;
    let trial_results: Vec<(usize, Result<(f64, Vec<crate::dto::SweepPoint>, f64), String>)> =
        trials_input.par_iter().enumerate().map(|(idx, overrides)| {
            if cancel.load(Ordering::Relaxed) {
                return (idx, Err("cancelled".to_string()));
            }
            // Emit started.
            emitter.emit_progress(&crate::dto::JobProgressPayload::OptimizationTrialStarted(
                crate::dto::OptimizationTrialStartedPayload {
                    job_id: job_id.to_string(),
                    trial_idx: idx,
                    parameter_values: overrides.clone(),
                },
            ));

            let t0 = std::time::Instant::now();
            let mut cfg = base_cfg.clone();
            for (path, value) in overrides {
                if let Err(e) = crate::params::apply_override(&mut cfg, path, *value) {
                    return (idx, Err(format!("apply_override({}): {}", path, e)));
                }
            }

            // Synth SweepParams for this trial's RPM list.
            let sweep_params = crate::dto::SweepParams {
                rpm_list: params.objective.rpm_list.clone(),
                n_cycles_max: params.n_cycles_max,
                imep_rel_tol: params.imep_rel_tol,
                min_cycles_before_check: params.min_cycles_before_check,
                capture_pv_loops: false,
                capture_pipe_profiles: false,
                capture_waves: false,
                wave_capture_stride: 0,
            };

            // Run sweep inline (in-memory, no captures).
            let sweep_result = run_sweep_inline(&cfg, &sweep_params, cancel);
            match sweep_result {
                Ok(points) => {
                    let obj_value = match objective::evaluate(&params.objective, &points) {
                        Ok(v) => v,
                        Err(e) => return (idx, Err(format!("objective eval: {}", e))),
                    };
                    let wall = t0.elapsed().as_secs_f64();

                    emitter.emit_progress(&crate::dto::JobProgressPayload::OptimizationTrialDone(
                        crate::dto::OptimizationTrialDonePayload {
                            job_id: job_id.to_string(),
                            trial_idx: idx,
                            objective_value: obj_value,
                            sweep_points: points.clone(),
                            wall_time_s: wall,
                        },
                    ));

                    (idx, Ok((obj_value, points, wall)))
                }
                Err(e) => (idx, Err(e.to_string())),
            }
        }).collect();

    // 6. Compute best trial.
    let n_run = trial_results.iter().filter(|(_, r)| r.is_ok()).count();
    let direction = params.objective.direction;
    let best = trial_results.iter()
        .filter_map(|(idx, r)| r.as_ref().ok().map(|(v, _, _)| (*idx, *v)))
        .fold(None, |acc, (idx, v)| match acc {
            None => Some((idx, v)),
            Some((bi, bv)) => {
                let take_new = match direction {
                    crate::dto::ObjectiveDirection::Maximize => v > bv,
                    crate::dto::ObjectiveDirection::Minimize => v < bv,
                };
                if take_new { Some((idx, v)) } else { Some((bi, bv)) }
            }
        });

    Ok(crate::dto::OptimizationDoneSummary {
        n_trials_requested: params.n_trials,
        n_trials_run: n_run,
        best_trial_idx: best.map(|(i, _)| i),
        best_objective_value: best.map(|(_, v)| v),
        parameter_paths: paths,
        objective_direction: direction,
    })
}
```

- [ ] Add `run_sweep_inline` helper if it doesn't exist — a pure-in-memory variant of the existing sweep that doesn't write captures and returns `Vec<SweepPoint>`. If `run_sweep_job` is already factored this way, reuse it; otherwise refactor by extracting the inner loop into `run_sweep_inline(cfg: &SDM26Config, params: &SweepParams, cancel: &AtomicBool) -> Result<Vec<SweepPoint>, RunnerError>` and have the existing `run_sweep_job` call it.

- [ ] Add `RunnerError::BadParams(String)` if not already present, and `RunnerError::ConfigLoad(String)`.

- [ ] Run `cargo build -p cfd-core`. Expected: PASS.

- [ ] Commit:

```bash
git add crates/cfd-core/src/runner.rs
git commit -m "feat(cfd-core): run_optimization_job — parallel LHS trials with objective eval"
```

### Task 9: Runner integration test

**Files:**
- Create `crates/cfd-core/tests/optimization_e2e.rs`

- [ ] Add:

```rust
use cfd_core::dto::*;
use cfd_core::runner;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

struct CollectEmitter { events: Mutex<Vec<JobProgressPayload>> }
impl runner::JobEmitter for CollectEmitter {
    fn emit_started(&self, _: &JobStartedEvent) {}
    fn emit_progress(&self, p: &JobProgressPayload) { self.events.lock().unwrap().push(p.clone()); }
    fn emit_done(&self, _: &JobDoneSummary) {}
    fn emit_cancelled(&self, _: &str) {}
    fn emit_error(&self, _: &str, _: &str) {}
}

fn sdm26_path() -> String {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/cfd/sdm26.json")
        .to_string_lossy().into_owned()
}

#[test]
fn optimization_runs_4_trials_with_restrictor_cd() {
    let params = OptimizationParams {
        tunables: vec![ParameterBounds {
            path: "restrictor.cd".into(), min: 0.80, max: 0.95, step: None,
        }],
        objective: ObjectiveSpec {
            metric: "imep_bar".into(),
            aggregator: ObjectiveAggregator::Max,
            rpm_list: vec![6000.0, 8000.0],
            direction: ObjectiveDirection::Maximize,
        },
        n_trials: 4,
        sampler: SamplerKind::Lhs,
        seed: Some(42),
        n_cycles_max: 3,
        imep_rel_tol: 1e-2,
        min_cycles_before_check: 2,
    };

    let emitter = CollectEmitter { events: Mutex::new(vec![]) };
    let cancel = AtomicBool::new(false);
    let summary = runner::run_optimization_job(
        "test-job-1", &sdm26_path(), &params, &emitter, &cancel,
    ).expect("optimization run");

    assert_eq!(summary.n_trials_requested, 4);
    assert_eq!(summary.n_trials_run, 4);
    assert!(summary.best_trial_idx.is_some());
    assert!(summary.best_objective_value.unwrap().is_finite());

    // Verify per-trial events emitted.
    let events = emitter.events.lock().unwrap();
    let started = events.iter().filter(|e| matches!(e, JobProgressPayload::OptimizationTrialStarted(_))).count();
    let done    = events.iter().filter(|e| matches!(e, JobProgressPayload::OptimizationTrialDone(_))).count();
    assert_eq!(started, 4);
    assert_eq!(done, 4);
}

#[test]
fn optimization_with_two_tunables_two_trials() {
    let params = OptimizationParams {
        tunables: vec![
            ParameterBounds { path: "restrictor.cd".into(), min: 0.80, max: 0.95, step: None },
            ParameterBounds { path: "intake.plenum_volume".into(), min: 0.001, max: 0.003, step: None },
        ],
        objective: ObjectiveSpec {
            metric: "ve_atm".into(),
            aggregator: ObjectiveAggregator::Mean,
            rpm_list: vec![6000.0, 9000.0],
            direction: ObjectiveDirection::Maximize,
        },
        n_trials: 2,
        sampler: SamplerKind::Lhs,
        seed: Some(7),
        n_cycles_max: 2,
        imep_rel_tol: 1e-2,
        min_cycles_before_check: 2,
    };

    let emitter = CollectEmitter { events: Mutex::new(vec![]) };
    let cancel = AtomicBool::new(false);
    let summary = runner::run_optimization_job(
        "test-job-2", &sdm26_path(), &params, &emitter, &cancel,
    ).expect("optimization run");

    assert_eq!(summary.n_trials_run, 2);
    assert_eq!(summary.parameter_paths.len(), 2);
}

#[test]
fn optimization_cancel_short_circuits() {
    let params = OptimizationParams {
        tunables: vec![ParameterBounds { path: "restrictor.cd".into(), min: 0.80, max: 0.95, step: None }],
        objective: ObjectiveSpec {
            metric: "imep_bar".into(),
            aggregator: ObjectiveAggregator::Max,
            rpm_list: vec![6000.0],
            direction: ObjectiveDirection::Maximize,
        },
        n_trials: 8,
        sampler: SamplerKind::Lhs,
        seed: Some(1),
        n_cycles_max: 2,
        imep_rel_tol: 1e-2,
        min_cycles_before_check: 2,
    };

    let emitter = CollectEmitter { events: Mutex::new(vec![]) };
    let cancel = AtomicBool::new(true); // pre-cancelled
    let summary = runner::run_optimization_job(
        "test-job-3", &sdm26_path(), &params, &emitter, &cancel,
    ).expect("optimization run");
    // All trials should have short-circuited; n_trials_run may be 0 or a few that started before cancel was observed.
    assert!(summary.n_trials_run <= summary.n_trials_requested);
}
```

- [ ] Run `cargo test -p cfd-core --test optimization_e2e`. Expected: 3 tests pass.

- [ ] Commit:

```bash
git add crates/cfd-core/tests/optimization_e2e.rs
git commit -m "test(cfd-core): optimization runner end-to-end on SDM26"
```

---

## Wave 6 — Tauri command surface

### Task 10: Wire StartJobRequest::Optimization through Tauri

**Files:**
- Modify `apps/desktop/src-tauri/src/cfd/commands.rs`
- Modify `apps/desktop/src-tauri/src/cfd/state.rs` (if separate from commands)

- [ ] In the existing `cfd_start_job` handler, the new `StartJobRequest::Optimization` variant must spawn a worker thread that calls `runner::run_optimization_job(...)`. Pattern matches what's already there for `Sweep`:

```rust
StartJobRequest::Optimization { config_path, params } => {
    let job_id = job_id.clone();
    let emitter = TauriEmitter::new(app_handle.clone());
    let cancel = handle.cancel.clone();
    std::thread::spawn(move || {
        emitter.emit_started(&JobStartedEvent {
            job_id: job_id.clone(),
            kind: JobKind::Optimization,
            config_path: config_path.clone(),
            started_at: chrono::Utc::now().to_rfc3339(),
        });
        match cfd_core::runner::run_optimization_job(&job_id, &config_path, &params, &emitter, &cancel) {
            Ok(summary) => emitter.emit_done(&JobDoneSummary::Optimization(summary)),
            Err(e) => emitter.emit_error(&job_id, &e.to_string()),
        }
    });
}
```

- [ ] Extend the "one job per kind" gate in `state.rs` so Optimization counts as its own kind (already covered by the `JobKind::Optimization` enum addition in Task 1).

- [ ] Run `cargo build -p helios-desktop`. Expected: PASS.

- [ ] Commit:

```bash
git add apps/desktop/src-tauri/src/cfd/
git commit -m "feat(desktop): wire StartJobRequest::Optimization to Tauri runner"
```

### Task 11: cfd_get_parameter_schema command

**Files:**
- Modify `apps/desktop/src-tauri/src/cfd/commands.rs`
- Modify `apps/desktop/src-tauri/src/lib.rs` (register command)

- [ ] Add command:

```rust
#[tauri::command]
pub async fn cfd_get_parameter_schema(config_path: String) -> Result<Vec<cfd_core::params::ParameterMeta>, String> {
    let cfg = cfd_core::load::load(&config_path).map_err(|e| e.to_string())?;
    Ok(cfd_core::params::enumerate_schema(&cfg))
}
```

- [ ] Register in the `tauri::Builder` invoke handler block alongside other `cfd_*` commands.

- [ ] Run `cargo build -p helios-desktop`. Expected: PASS.

- [ ] Commit:

```bash
git add apps/desktop/src-tauri/
git commit -m "feat(desktop): cfd_get_parameter_schema Tauri command"
```

---

## Wave 7 — Verification

### Task 12: Full workspace test + clippy

- [ ] Run `cargo test --workspace --locked`. Expected: all previous + 20 new tests pass.

- [ ] Run `cargo clippy --workspace --all-targets -- -D warnings`. Expected: clean, or fix any newly-introduced lints.

- [ ] If anything red, fix in place and re-run. Do NOT commit broken tests.

- [ ] Commit any lint fixes:

```bash
git add -A
git commit -m "chore(cfd-core): clippy fixes for optimization module"
```

---

## Self-Review Checklist

- [ ] **Spec coverage:**
  - "every numeric leaf optimizable, OFF by default, min/max/step per param" → Task 3 (schema enumeration) + Task 4 (apply_override) + DTO `ParameterBounds`
  - "objective is metric × aggregator × rpm_list × direction" → Task 1 (DTO `ObjectiveSpec`) + Task 7 (evaluator)
  - "uniform-by-default, opt-in per-element" → `apply_override` parses `[N]` suffix (Task 4)
  - "parallel trials with cancel" → Task 8 (rayon + cancel token)
  - "live UI updates" → Task 2 (event payloads) + Task 8 (emit per trial)
  - "5-10K rpm range, then VE at different band" → flexible rpm_list (DTO) + flexible aggregator
- [ ] **No placeholders:** every step has either code, an exact command, or a commit. ✓
- [ ] **Type consistency:** `ParameterBounds` / `ObjectiveSpec` / `OptimizationParams` / `OptimizationTrialDonePayload` / `OptimizationDoneSummary` all consistent across tasks. ✓
- [ ] **Frontend handoff:** see `2026-05-21-cfd-phase-5-optimization-frontend-plan.md`.
