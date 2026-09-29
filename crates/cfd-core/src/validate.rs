//! Boundary validation for CFD job requests and engine configs.
//!
//! The runners preallocate and loop straight off the run-sizing numbers
//! (`n_cycles_max`, rpm list length, `n_trials`) and the solver builds
//! grids from the pipe geometry, so an unchecked value typed in the UI
//! (1e9 cycles, rpm = 0, NaN diameter, 1e6 cells) can abort the whole
//! app on an allocation failure or spin forever — neither is catchable
//! by `catch_unwind`. `cfd_start_job` calls [`validate_start_request`]
//! before spawning, and every runner calls [`validate_engine_config`]
//! after overrides are applied, before `SDM26Engine::new`.
//!
//! Bounds mirror the frontend inputs (StudiesScreen / SweepParamsModal /
//! OptimizationParamsModal / lib/rpmList.ts / lib/sdm26Schema.ts).

use engine_sim::model::sdm26::SDM26Config;

use crate::dto::{
    OptimizationParams, ParameterBounds, ParameterOverride, SingleRpmParams, StartJobRequest,
    SweepParams,
};

/// RPM bounds (lib/rpmList.ts RPM_MIN / RPM_MAX).
pub const RPM_MIN: f64 = 500.0;
pub const RPM_MAX: f64 = 20_000.0;
/// Max RPM-list length (lib/rpmList.ts MAX_COUNT).
pub const RPM_LIST_MAX: usize = 2000;
/// "Max cycles" input max on the single-RPM and sweep modals.
pub const N_CYCLES_MAX: u32 = 200;
/// "Max cycles per RPM" input max on the optimization modal.
pub const OPT_N_CYCLES_MAX: u32 = 50;
/// "Min cycles before conv." input max.
pub const MIN_CYCLES_MAX: u32 = 50;
/// "Trials" input max on the optimization modal.
pub const N_TRIALS_MAX: u32 = 500;
/// Pipe `n_points` bounds (sdm26Schema.ts PIPE_FIELDS).
pub const N_CELLS_MIN: usize = 5;
pub const N_CELLS_MAX: usize = 200;
/// `n_cylinders` bounds (sdm26Schema.ts).
pub const N_CYLINDERS_MAX: usize = 16;

/// Upper bound for `Vec::with_capacity` hints derived from request
/// numbers. The Vec still grows past this if needed; this only keeps a
/// bad number from turning into a multi-GB up-front allocation.
pub const CAPACITY_HINT_MAX: usize = 256;

/// Clamp a request-derived count to a safe `with_capacity` hint.
pub fn capacity_hint(n: usize) -> usize {
    n.min(CAPACITY_HINT_MAX)
}

fn check_rpm(label: &str, rpm: f64) -> Result<(), String> {
    if !rpm.is_finite() || !(RPM_MIN..=RPM_MAX).contains(&rpm) {
        return Err(format!("{label} must be a number in [{RPM_MIN}, {RPM_MAX}] (got {rpm})."));
    }
    Ok(())
}

fn check_rpm_list(label: &str, rpms: &[f64]) -> Result<(), String> {
    if rpms.is_empty() || rpms.len() > RPM_LIST_MAX {
        return Err(format!(
            "{label} must have 1 to {RPM_LIST_MAX} entries (got {}).",
            rpms.len()
        ));
    }
    for &r in rpms {
        check_rpm(&format!("{label} entry"), r)?;
    }
    Ok(())
}

fn check_range_u32(label: &str, v: u32, lo: u32, hi: u32) -> Result<(), String> {
    if v < lo || v > hi {
        return Err(format!("{label} must be an integer in [{lo}, {hi}] (got {v})."));
    }
    Ok(())
}

fn check_tol(tol: f64) -> Result<(), String> {
    if !tol.is_finite() || !(0.0..=1.0).contains(&tol) {
        return Err(format!("Convergence tol must be a number in [0, 1] (got {tol})."));
    }
    Ok(())
}

fn check_overrides(overrides: &[ParameterOverride]) -> Result<(), String> {
    for ov in overrides {
        if !ov.value.is_finite() {
            return Err(format!("Override {} must be a finite number (got {}).", ov.path, ov.value));
        }
    }
    Ok(())
}

fn check_run_sizing(
    n_cycles_max: u32,
    n_cycles_hi: u32,
    tol: f64,
    min_cycles: u32,
) -> Result<(), String> {
    check_range_u32("Max cycles", n_cycles_max, 1, n_cycles_hi)?;
    check_tol(tol)?;
    check_range_u32("Min cycles before convergence", min_cycles, 0, MIN_CYCLES_MAX)
}

pub fn validate_single_rpm(p: &SingleRpmParams) -> Result<(), String> {
    check_rpm("RPM", p.rpm)?;
    check_run_sizing(p.n_cycles_max, N_CYCLES_MAX, p.convergence_tol_imep, p.convergence_min_cycles)?;
    check_overrides(&p.overrides)
}

pub fn validate_sweep(p: &SweepParams) -> Result<(), String> {
    check_rpm_list("RPM list", &p.rpm_list)?;
    check_run_sizing(p.n_cycles_max, N_CYCLES_MAX, p.convergence_tol_imep, p.convergence_min_cycles)?;
    check_overrides(&p.overrides)
}

fn check_tunable(b: &ParameterBounds) -> Result<(), String> {
    if !b.min.is_finite() || !b.max.is_finite() || b.min >= b.max {
        return Err(format!(
            "{}: min and max must be finite with min < max (got {}..{}).",
            b.path, b.min, b.max
        ));
    }
    if let Some(step) = b.step {
        if !step.is_finite() {
            return Err(format!("{}: step must be a finite number (got {step}).", b.path));
        }
    }
    Ok(())
}

pub fn validate_optimization(p: &OptimizationParams) -> Result<(), String> {
    check_range_u32("Trials", p.n_trials, 1, N_TRIALS_MAX)?;
    check_rpm_list("Objective RPM list", &p.objective.rpm_list)?;
    check_run_sizing(p.n_cycles_max, OPT_N_CYCLES_MAX, p.convergence_tol_imep, p.convergence_min_cycles)?;
    for b in &p.tunables {
        check_tunable(b)?;
    }
    Ok(())
}

/// Validate a job request at the command boundary, before anything is
/// allocated or spawned. Returns a user-facing error string.
pub fn validate_start_request(req: &StartJobRequest) -> Result<(), String> {
    match req {
        StartJobRequest::SingleRpm { params, .. } => validate_single_rpm(params),
        StartJobRequest::Sweep { params, .. } => validate_sweep(params),
        StartJobRequest::Optimization { params, .. } => validate_optimization(params),
    }
}

fn check_positive(label: &str, v: f64) -> Result<(), String> {
    if !v.is_finite() || v <= 0.0 {
        return Err(format!("{label} must be a finite number > 0 (got {v})."));
    }
    Ok(())
}

fn check_positive_all(label: &str, vs: Option<&Vec<f64>>) -> Result<(), String> {
    for (i, &v) in vs.into_iter().flatten().enumerate() {
        check_positive(&format!("{label}[{i}]"), v)?;
    }
    Ok(())
}

fn check_positive_opt_all(label: &str, vs: Option<&Vec<Option<f64>>>) -> Result<(), String> {
    for (i, v) in vs.into_iter().flatten().enumerate() {
        if let Some(v) = v {
            check_positive(&format!("{label}[{i}]"), *v)?;
        }
    }
    Ok(())
}

fn check_cells(label: &str, n: usize) -> Result<(), String> {
    if !(N_CELLS_MIN..=N_CELLS_MAX).contains(&n) {
        return Err(format!(
            "{label} must be an integer in [{N_CELLS_MIN}, {N_CELLS_MAX}] (got {n})."
        ));
    }
    Ok(())
}

/// Validate the solver-sizing and geometry fields of an engine config
/// (after overrides): cylinder count, per-pipe cell counts, and every
/// length / diameter / volume the solver divides by or builds grids from.
pub fn validate_engine_config(cfg: &SDM26Config) -> Result<(), String> {
    if cfg.n_cylinders < 1 || cfg.n_cylinders > N_CYLINDERS_MAX {
        return Err(format!(
            "n_cylinders must be an integer in [1, {N_CYLINDERS_MAX}] (got {}).",
            cfg.n_cylinders
        ));
    }
    check_cells("runner n_points", cfg.runner_n_cells)?;
    check_cells("primary n_points", cfg.primary_n_cells)?;
    check_cells("secondary n_points", cfg.secondary_n_cells)?;
    check_cells("collector n_points", cfg.collector_n_cells)?;
    check_cells("plenum n_points", cfg.plenum_n_cells)?;

    for (label, v) in [
        ("bore", cfg.bore),
        ("stroke", cfg.stroke),
        ("con_rod", cfg.con_rod),
        ("cr", cfg.cr),
        ("runner_length", cfg.runner_length),
        ("runner_diameter_in", cfg.runner_diameter_in),
        ("primary_length", cfg.primary_length),
        ("primary_diameter_in", cfg.primary_diameter_in),
        ("secondary_length", cfg.secondary_length),
        ("secondary_diameter_in", cfg.secondary_diameter_in),
        ("collector_length", cfg.collector_length),
        ("collector_diameter_in", cfg.collector_diameter_in),
        ("plenum_volume", cfg.plenum_volume),
        ("plenum_length", cfg.plenum_length),
        ("restrictor_throat_diameter", cfg.restrictor_throat_diameter),
    ] {
        check_positive(label, v)?;
    }
    for (label, v) in [
        ("runner_diameter_out", cfg.runner_diameter_out),
        ("primary_diameter_out", cfg.primary_diameter_out),
        ("secondary_diameter_out", cfg.secondary_diameter_out),
        ("collector_diameter_out", cfg.collector_diameter_out),
    ] {
        if let Some(v) = v {
            check_positive(label, v)?;
        }
    }
    check_positive_all("runner_length", cfg.runner_lengths.as_ref())?;
    check_positive_all("runner_diameter_in", cfg.runner_diameters_in.as_ref())?;
    check_positive_opt_all("runner_diameter_out", cfg.runner_diameters_out.as_ref())?;
    check_positive_all("primary_length", cfg.primary_lengths.as_ref())?;
    check_positive_all("primary_diameter_in", cfg.primary_diameters_in.as_ref())?;
    check_positive_opt_all("primary_diameter_out", cfg.primary_diameters_out.as_ref())?;
    check_positive_all("secondary_length", cfg.secondary_lengths.as_ref())?;
    check_positive_all("secondary_diameter_in", cfg.secondary_diameters_in.as_ref())?;
    check_positive_opt_all("secondary_diameter_out", cfg.secondary_diameters_out.as_ref())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::{
        JunctionKindDto, ObjectiveAggregator, ObjectiveDirection, ObjectiveSpec, SamplerKind,
    };
    use std::path::PathBuf;

    fn single(rpm: f64, n: u32) -> SingleRpmParams {
        SingleRpmParams {
            rpm,
            n_cycles_max: n,
            junction_kind: JunctionKindDto::Characteristic,
            convergence_tol_imep: 5e-3,
            convergence_min_cycles: 30,
            capture_waves: false,
            capture_pv_loops: true,
            capture_pipe_profiles: true,
            overrides: vec![],
        }
    }

    fn sweep(rpms: Vec<f64>, n: u32) -> SweepParams {
        SweepParams {
            rpm_list: rpms,
            n_cycles_max: n,
            junction_kind: JunctionKindDto::Characteristic,
            convergence_tol_imep: 5e-3,
            convergence_min_cycles: 30,
            capture_waves: false,
            capture_pv_loops: true,
            capture_pipe_profiles: true,
            overrides: vec![],
        }
    }

    fn opt(n_trials: u32, n_cycles: u32) -> OptimizationParams {
        OptimizationParams {
            tunables: vec![ParameterBounds {
                path: "runner_length".into(),
                min: 0.2,
                max: 0.3,
                step: None,
            }],
            objective: ObjectiveSpec {
                metric: "imep_bar".into(),
                aggregator: ObjectiveAggregator::Max,
                rpm_list: vec![6000.0, 8000.0],
                direction: ObjectiveDirection::Maximize,
            },
            n_trials,
            sampler: SamplerKind::Lhs,
            seed: None,
            n_cycles_max: n_cycles,
            junction_kind: JunctionKindDto::Characteristic,
            convergence_tol_imep: 5e-3,
            convergence_min_cycles: 3,
            locked_pairs: vec![],
        }
    }

    #[test]
    fn single_rpm_defaults_pass() {
        assert!(validate_single_rpm(&single(8000.0, 40)).is_ok());
        assert!(validate_single_rpm(&single(RPM_MIN, 1)).is_ok());
        assert!(validate_single_rpm(&single(RPM_MAX, N_CYCLES_MAX)).is_ok());
    }

    #[test]
    fn huge_n_cycles_rejected() {
        let e = validate_single_rpm(&single(8000.0, 1_000_000_000)).unwrap_err();
        assert!(e.contains("Max cycles"), "{e}");
        assert!(validate_single_rpm(&single(8000.0, 0)).is_err());
        assert!(validate_single_rpm(&single(8000.0, N_CYCLES_MAX + 1)).is_err());
    }

    #[test]
    fn bad_rpm_rejected() {
        for rpm in [0.0, -1.0, f64::NAN, f64::INFINITY, 499.0, 20_001.0] {
            assert!(validate_single_rpm(&single(rpm, 40)).is_err(), "rpm {rpm}");
        }
    }

    #[test]
    fn bad_tol_and_min_cycles_rejected() {
        let mut p = single(8000.0, 40);
        p.convergence_tol_imep = f64::NAN;
        assert!(validate_single_rpm(&p).is_err());
        p.convergence_tol_imep = -0.1;
        assert!(validate_single_rpm(&p).is_err());
        p.convergence_tol_imep = 0.0;
        assert!(validate_single_rpm(&p).is_ok());
        p.convergence_min_cycles = MIN_CYCLES_MAX + 1;
        assert!(validate_single_rpm(&p).is_err());
    }

    #[test]
    fn non_finite_override_rejected() {
        let mut p = single(8000.0, 40);
        p.overrides.push(ParameterOverride { path: "fmep_c".into(), value: f64::NAN });
        assert!(validate_single_rpm(&p).is_err());
    }

    #[test]
    fn sweep_list_bounds() {
        assert!(validate_sweep(&sweep(vec![4000.0, 6000.0], 40)).is_ok());
        assert!(validate_sweep(&sweep(vec![], 40)).is_err());
        assert!(validate_sweep(&sweep(vec![4000.0; RPM_LIST_MAX + 1], 40)).is_err());
        assert!(validate_sweep(&sweep(vec![4000.0, 0.0], 40)).is_err());
        assert!(validate_sweep(&sweep(vec![4000.0], u32::MAX)).is_err());
    }

    #[test]
    fn optimization_bounds() {
        assert!(validate_optimization(&opt(32, 8)).is_ok());
        assert!(validate_optimization(&opt(0, 8)).is_err());
        assert!(validate_optimization(&opt(N_TRIALS_MAX + 1, 8)).is_err());
        // Optimization caps cycles tighter than single/sweep (UI max=50).
        assert!(validate_optimization(&opt(32, OPT_N_CYCLES_MAX + 1)).is_err());
        let mut p = opt(32, 8);
        p.objective.rpm_list.push(f64::NAN);
        assert!(validate_optimization(&p).is_err());
        let mut p = opt(32, 8);
        p.tunables[0].max = f64::NAN;
        assert!(validate_optimization(&p).is_err());
        let mut p = opt(32, 8);
        p.tunables[0].min = 0.3;
        assert!(validate_optimization(&p).is_err());
        let mut p = opt(32, 8);
        p.tunables[0].step = Some(f64::INFINITY);
        assert!(validate_optimization(&p).is_err());
    }

    #[test]
    fn start_request_dispatches() {
        let req = StartJobRequest::Sweep {
            config_path: "x.json".into(),
            params: sweep(vec![6000.0], 1_000_000_000),
        };
        assert!(validate_start_request(&req).is_err());
    }

    #[test]
    fn capacity_hint_is_clamped() {
        assert_eq!(capacity_hint(40), 40);
        assert_eq!(capacity_hint(1_000_000_000), CAPACITY_HINT_MAX);
    }

    fn fixture(rel: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel)
    }

    #[test]
    fn bundled_configs_pass_engine_validation() {
        for rel in [
            "../engine-sim/python_ref/configs/sdm26.json",
            "../engine-sim/python_ref/configs/sdm25.json",
            "../../apps/desktop/src-tauri/resources/cfd/configs/sdm26.json",
            "../../apps/desktop/src-tauri/resources/cfd/configs/sdm25.json",
        ] {
            let p = fixture(rel);
            if !p.exists() {
                continue;
            }
            let cfg = engine_sim::config::loader::load_v1_json(&p).unwrap();
            validate_engine_config(&cfg).unwrap_or_else(|e| panic!("{rel}: {e}"));
        }
        assert!(validate_engine_config(&SDM26Config::default()).is_ok());
    }

    #[test]
    fn bad_engine_geometry_rejected() {
        let mut c = SDM26Config::default();
        c.runner_n_cells = 1_000_000;
        assert!(validate_engine_config(&c).is_err());

        let mut c = SDM26Config::default();
        c.primary_n_cells = 0;
        assert!(validate_engine_config(&c).is_err());

        let mut c = SDM26Config::default();
        c.collector_diameter_in = f64::NAN;
        assert!(validate_engine_config(&c).is_err());

        let mut c = SDM26Config::default();
        c.runner_lengths = Some(vec![0.2, 0.0, 0.2, 0.2]);
        assert!(validate_engine_config(&c).is_err());

        let mut c = SDM26Config::default();
        c.primary_diameters_out = Some(vec![None, Some(-0.03), None, None]);
        assert!(validate_engine_config(&c).is_err());

        let mut c = SDM26Config::default();
        c.n_cylinders = 0;
        assert!(validate_engine_config(&c).is_err());
    }
}
