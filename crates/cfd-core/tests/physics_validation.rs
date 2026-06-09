//! SDM26 physics validation: drive every tunable parameter from the
//! schema across its [suggestedMin, suggestedMax] range at 3 RPMs and
//! check that the simulator's response matches first-principles physical
//! expectations.
//!
//! This is a single mega-test, gated by `#[ignore]` so CI never runs it.
//! Invocation:
//!     cargo test --release -p cfd-core --test physics_validation \
//!         -- --ignored --nocapture
//!
//! Outputs (written to the repo root, i.e. CARGO_MANIFEST_DIR/../..):
//!   - physics_validation_data.csv  — raw (param, value, rpm, metric) rows
//!   - physics_validation_report.md — human-readable per-param verdicts
//!
//! Methodology:
//!   For each parameter:
//!     1. Pick 7 evenly-spaced values across [suggested_min, suggested_max].
//!     2. For each value, run the SDM26 engine at {6000, 9000, 12000} RPM
//!        for 6 cycles (no convergence short-circuit — we always burn 6).
//!     3. Capture the LAST cycle's CycleStats.
//!     4. Score the parameter against a hand-coded physical expectation:
//!        monotone-up / monotone-down / peaked / linear-up / saturating /
//!        scale-invariant / weakly-sensitive. Compute simple metrics
//!        (Spearman-like rank-correlation, peakedness, magnitude of effect).
//!     5. Emit a verdict line: SANE / SUSPICIOUS / BROKEN / SKIP, with a
//!        one-line hypothesis when non-SANE.
//!
//! Runs are parallelized across the (param, value, rpm) triple via rayon.
//! Cycle-step parallelism is left to the inner solver (single-threaded).
//!
//! Time budget on an M-series mac: ~3-5 minutes total.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

use cfd_core::params::{apply_override, enumerate_schema, ParameterMeta};
use engine_sim::config::loader::load_v1_json;
use engine_sim::model::sdm26::{CycleStats, JunctionKind, SDM26Engine};
use rayon::prelude::*;

// ---------------- Config + paths ----------------

const N_VALUES: usize = 7;
const N_CYCLES: usize = 6;
const RPMS: &[f64] = &[6000.0, 9000.0, 12000.0];

fn sdm26_config_path() -> PathBuf {
    let candidates = [
        // python_ref FIRST: these tests pin LEGACY-physics expectations, and the
        // bundled app config now ships with the validated physics section ON.
        "../engine-sim/python_ref/configs/sdm26.json",
        "../../apps/desktop/src-tauri/resources/cfd/configs/sdm26.json",
    ];
    for c in candidates {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(c);
        if p.exists() {
            return p;
        }
    }
    panic!("no sdm26.json found");
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("canon repo root")
}

// ---------------- Physical expectations ----------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Expectation {
    /// Larger -> larger primary metric (monotone increasing).
    MonoUp,
    /// Larger -> smaller primary metric (monotone decreasing).
    MonoDown,
    /// Should have an interior peak (e.g. spark advance MBT).
    Peaked,
    /// Should be roughly linear with a known slope (we just check rank-correlation).
    Linear,
    /// Should saturate (monotone with diminishing returns at large value).
    Saturating,
    /// Effect on primary metric should be small (< ~3% across the range).
    Weak,
    /// Numerical / purely-discrete knob — IMEP should NOT change appreciably.
    ScaleInvariant,
    /// Tuned response: peak location should shift with RPM (acoustic).
    TunedAcoustic,
    /// Skip — not testable in this rig.
    Skip,
}

/// One physical-expectation row per param path.
fn expectation_for(path: &str) -> (Expectation, &'static str, &'static str) {
    // (expectation, primary_metric, hypothesis_text)
    match path {
        // --- Geometry ---
        // Bore: V_d scales with bore^2; brake_torque should scale roughly
        // with V_d at constant BMEP. We use brake_torque_nm as primary.
        "bore" => (Expectation::MonoUp, "brake_torque_nm",
                   "torque ~ V_d ~ bore^2; at near-constant BMEP, torque rises with bore"),
        "stroke" => (Expectation::MonoUp, "brake_torque_nm",
                     "V_d ~ stroke; torque rises with stroke, BMEP may drop slightly from FMEP"),
        "con_rod" => (Expectation::Weak, "imep_bar",
                      "longer rod has minor effect on geometric piston motion; IMEP ~constant"),
        "cr" => (Expectation::MonoUp, "imep_bar",
                 "Otto efficiency rises with CR (eta = 1 - 1/cr^(gamma-1))"),
        // --- Intake runners ---
        "runner_length" => (Expectation::TunedAcoustic, "ve_atm",
                            "quarter-wave / Helmholtz tuned; VE-peak RPM shifts with length"),
        "runner_diameter_in" => (Expectation::MonoUp, "ve_atm",
                                 "larger flow area -> better filling, especially at high RPM"),
        "runner_diameter_out" => (Expectation::MonoUp, "ve_atm",
                                  "larger port-side diameter -> better filling"),
        "runner_n_cells" => (Expectation::ScaleInvariant, "imep_bar",
                             "numerical grid resolution; physics should not change"),
        "runner_wall_t" => (Expectation::Weak, "ve_atm",
                            "wall T affects intake heating slightly"),
        // --- Plenum ---
        "plenum_volume" => (Expectation::MonoUp, "ve_atm",
                            "larger plenum smooths pulses; saturates"),
        "plenum_length" => (Expectation::Weak, "imep_bar",
                            "plenum geometry is mostly volumetric; length is small effect"),
        "plenum_n_cells" => (Expectation::ScaleInvariant, "imep_bar",
                             "numerical resolution"),
        "plenum_wall_t" => (Expectation::Weak, "ve_atm", "minor heating effect"),
        "intake_junction_loss_coef" => (Expectation::MonoDown, "ve_atm",
                                        "extra loss reduces filling"),
        // --- Restrictor ---
        "restrictor_throat_diameter" => (Expectation::MonoUp, "brake_power_k_w",
                                         "FSAE 20mm constraint; larger throat -> more mass flow"),
        "restrictor_cd" => (Expectation::MonoUp, "brake_power_k_w",
                            "higher Cd -> more mass flow through choke"),
        "restrictor_loss_coef" => (Expectation::MonoDown, "brake_power_k_w",
                                   "extra loss reduces flow"),
        // --- Exhaust primaries ---
        "primary_length" => (Expectation::TunedAcoustic, "ve_atm",
                             "scavenging tuned; effect shifts with RPM"),
        "primary_diameter_in" => (Expectation::Peaked, "brake_power_k_w",
                                  "too small -> backpressure; too large -> low velocity"),
        "primary_diameter_out" => (Expectation::Peaked, "brake_power_k_w",
                                   "similar to inlet; tapered design has sweet spot"),
        "primary_n_cells" => (Expectation::ScaleInvariant, "imep_bar", "numerical grid"),
        "primary_wall_t" => (Expectation::Weak, "egt_mean",
                             "wall T affects EGT directly"),
        // --- Exhaust secondaries ---
        "secondary_length" => (Expectation::TunedAcoustic, "ve_atm",
                               "secondary tuning, smaller effect"),
        "secondary_diameter_in" => (Expectation::Weak, "brake_power_k_w",
                                    "secondary, modest"),
        "secondary_diameter_out" => (Expectation::Weak, "brake_power_k_w",
                                     "secondary outlet, modest"),
        "secondary_n_cells" => (Expectation::ScaleInvariant, "imep_bar", "numerical"),
        "secondary_wall_t" => (Expectation::Weak, "egt_mean", "wall T"),
        // --- Collector ---
        "collector_length" => (Expectation::Weak, "ve_atm", "downstream of secondaries"),
        "collector_diameter_in" => (Expectation::Weak, "brake_power_k_w", "downstream"),
        "collector_diameter_out" => (Expectation::Weak, "brake_power_k_w", "outlet"),
        "collector_n_cells" => (Expectation::ScaleInvariant, "imep_bar", "numerical"),
        "collector_wall_t" => (Expectation::Weak, "egt_mean", "downstream wall"),
        // --- Ambient ---
        "p_ambient" => (Expectation::Linear, "imep_bar", "IMEP ~ p_ambient"),
        "t_ambient" => (Expectation::MonoDown, "imep_bar",
                        "IMEP ~ 1/T (density-limited charge)"),
        // --- Combustion ---
        "wiebe_a" => (Expectation::Weak, "imep_bar",
                      "a sets burn-completeness asymptote; tiny effect at typical a"),
        "wiebe_m" => (Expectation::Weak, "imep_bar",
                      "form factor; modest shape effect"),
        "combustion_duration" => (Expectation::MonoDown, "imep_bar",
                                  "shorter burn -> closer to const-volume -> higher IMEP"),
        "spark_advance" => (Expectation::Peaked, "imep_bar",
                            "classic MBT — interior maximum 15-35 deg BTDC"),
        "ignition_delay" => (Expectation::MonoDown, "imep_bar",
                             "delay pushes effective burn later, reducing work"),
        "eta_comb" => (Expectation::Linear, "imep_bar",
                       "heat release scalar — IMEP roughly linear"),
        "q_lhv" => (Expectation::Linear, "imep_bar",
                    "fuel LHV scalar — IMEP roughly linear"),
        "afr_target" => (Expectation::Peaked, "brake_power_k_w",
                         "rich-power peak near 12-13"),
        "t_wall_cylinder" => (Expectation::MonoUp, "imep_bar",
                              "hotter walls -> less heat loss -> higher IMEP"),
        "woschni_c1_gas_exchange" => (Expectation::Weak, "imep_bar",
                                      "heat-transfer coeff during gas exchange"),
        "woschni_c1_compression" => (Expectation::MonoDown, "imep_bar",
                                     "more compression heat loss -> lower IMEP"),
        "woschni_c1_combustion" => (Expectation::MonoDown, "imep_bar",
                                    "more combustion heat loss -> lower IMEP"),
        "woschni_c2_combustion" => (Expectation::MonoDown, "imep_bar",
                                    "combustion-driven HT term -> lower IMEP at high cylinder p"),
        // --- Valves ---
        "intake_valve_diameter" => (Expectation::MonoUp, "ve_atm",
                                    "larger curtain -> better filling"),
        "intake_valve_max_lift" => (Expectation::Saturating, "ve_atm",
                                    "more lift -> more area; saturates"),
        "intake_valve_open_angle" => (Expectation::Peaked, "ve_atm",
                                      "cam timing has an optimum"),
        "intake_valve_close_angle" => (Expectation::Peaked, "ve_atm",
                                       "IVC has clear optimum (later = more ram, but blowback)"),
        "intake_valve_seat_angle" => (Expectation::Weak, "ve_atm",
                                      "seat angle is geometric correction"),
        "exhaust_valve_diameter" => (Expectation::MonoUp, "ve_atm",
                                     "larger exhaust valve -> better scavenging"),
        "exhaust_valve_max_lift" => (Expectation::Saturating, "ve_atm",
                                     "more lift -> more area; saturates"),
        "exhaust_valve_open_angle" => (Expectation::Peaked, "imep_bar",
                                       "EVO too early loses work; too late hurts scavenging"),
        "exhaust_valve_close_angle" => (Expectation::Peaked, "ve_atm",
                                        "EVC has an optimum near TDC"),
        "exhaust_valve_seat_angle" => (Expectation::Weak, "ve_atm", "geometric"),
        // --- Drivetrain ---
        "drivetrain_efficiency" => (Expectation::Linear, "wheel_power_k_w",
                                    "wheel_power = brake_power * eta"),
        // --- Numerics ---
        "cfl" => (Expectation::ScaleInvariant, "imep_bar",
                  "smaller CFL = finer dt; physics should be invariant"),
        _ => (Expectation::Skip, "imep_bar", "no expectation defined"),
    }
}

// ---------------- Result row ----------------

#[derive(Clone, Debug)]
struct Row {
    path: String,
    value: f64,
    rpm: f64,
    cs: CycleStats,
    n_cycles_run: usize,
    walltime_s: f64,
}

fn metric_of(cs: &CycleStats, name: &str) -> f64 {
    match name {
        "imep_bar" => cs.imep_bar,
        "bmep_bar" => cs.bmep_bar,
        "fmep_bar" => cs.fmep_bar,
        "ve_atm" => cs.ve_atm,
        "intake_mass_per_cycle_g" => cs.intake_mass_per_cycle_g,
        "f_residual" => cs.f_residual,
        "indicated_power_k_w" => cs.indicated_power_k_w,
        "brake_power_k_w" => cs.brake_power_k_w,
        "wheel_power_k_w" => cs.wheel_power_k_w,
        "indicated_torque_nm" => cs.indicated_torque_nm,
        "brake_torque_nm" => cs.brake_torque_nm,
        "wheel_torque_nm" => cs.wheel_torque_nm,
        "egt_mean" => cs.egt_mean,
        "nonconservation" => cs.nonconservation,
        "mass_total" => cs.mass_total,
        _ => f64::NAN,
    }
}

// ---------------- Verdict scoring ----------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Verdict {
    Sane,
    Suspicious,
    Broken,
    Skipped,
}

fn linspace(a: f64, b: f64, n: usize) -> Vec<f64> {
    if n == 0 {
        return vec![];
    }
    if n == 1 {
        return vec![0.5 * (a + b)];
    }
    (0..n)
        .map(|i| a + (b - a) * (i as f64) / ((n - 1) as f64))
        .collect()
}

/// Spearman rank correlation between value and metric (Pearson on ranks).
fn rank_corr(values: &[f64], metrics: &[f64]) -> f64 {
    let n = values.len();
    if n < 2 {
        return 0.0;
    }
    fn ranks(xs: &[f64]) -> Vec<f64> {
        let mut idx: Vec<usize> = (0..xs.len()).collect();
        idx.sort_by(|&a, &b| xs[a].partial_cmp(&xs[b]).unwrap_or(std::cmp::Ordering::Equal));
        let mut r = vec![0.0; xs.len()];
        for (rank, &i) in idx.iter().enumerate() {
            r[i] = rank as f64;
        }
        r
    }
    let rv = ranks(values);
    let rm = ranks(metrics);
    let mv = rv.iter().sum::<f64>() / n as f64;
    let mm = rm.iter().sum::<f64>() / n as f64;
    let mut num = 0.0;
    let mut dv = 0.0;
    let mut dm = 0.0;
    for i in 0..n {
        num += (rv[i] - mv) * (rm[i] - mm);
        dv += (rv[i] - mv).powi(2);
        dm += (rm[i] - mm).powi(2);
    }
    if dv == 0.0 || dm == 0.0 {
        return 0.0;
    }
    num / (dv * dm).sqrt()
}

/// Returns (peak_idx, peak_pronounced) — peak is "real" if the max-value index
/// is strictly interior AND its margin over the endpoints is at least 1% of
/// the metric magnitude.
fn detect_peak(metrics: &[f64]) -> Option<usize> {
    if metrics.len() < 3 {
        return None;
    }
    let max_i = metrics
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(i, _)| i)?;
    if max_i == 0 || max_i == metrics.len() - 1 {
        return None;
    }
    let peak = metrics[max_i];
    let margin = peak - metrics[0].max(metrics[metrics.len() - 1]);
    let scale = peak.abs().max(1e-9);
    if margin / scale > 0.005 {
        Some(max_i)
    } else {
        None
    }
}

fn frac_range(metrics: &[f64]) -> f64 {
    if metrics.is_empty() {
        return 0.0;
    }
    let lo = metrics.iter().cloned().fold(f64::INFINITY, f64::min);
    let hi = metrics.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let mean = metrics.iter().sum::<f64>() / metrics.len() as f64;
    if mean.abs() < 1e-12 {
        return (hi - lo).abs();
    }
    (hi - lo) / mean.abs()
}

/// Score a single (param, rpm) curve given the expectation. Returns a
/// per-rpm verdict + diagnostic string.
fn score_curve(exp: Expectation, values: &[f64], metrics: &[f64]) -> (Verdict, String) {
    if !metrics.iter().all(|x| x.is_finite()) {
        return (Verdict::Broken, "non-finite metric".into());
    }
    let r = rank_corr(values, metrics);
    let fr = frac_range(metrics);
    match exp {
        Expectation::MonoUp => {
            if r > 0.8 {
                (Verdict::Sane, format!("rho={r:+.2}  frac_range={fr:.3}"))
            } else if r > 0.4 {
                (Verdict::Suspicious, format!("rho={r:+.2} (weak monotone); frac_range={fr:.3}"))
            } else {
                (Verdict::Broken, format!("rho={r:+.2} (expected MonoUp); frac_range={fr:.3}"))
            }
        }
        Expectation::MonoDown => {
            if r < -0.8 {
                (Verdict::Sane, format!("rho={r:+.2}  frac_range={fr:.3}"))
            } else if r < -0.4 {
                (Verdict::Suspicious, format!("rho={r:+.2} (weak monotone); frac_range={fr:.3}"))
            } else {
                (Verdict::Broken, format!("rho={r:+.2} (expected MonoDown); frac_range={fr:.3}"))
            }
        }
        Expectation::Linear => {
            if r.abs() > 0.9 {
                (Verdict::Sane, format!("rho={r:+.2}  frac_range={fr:.3}"))
            } else if r.abs() > 0.5 {
                (Verdict::Suspicious, format!("rho={r:+.2} (weak); frac_range={fr:.3}"))
            } else {
                (Verdict::Broken, format!("rho={r:+.2} (expected Linear); frac_range={fr:.3}"))
            }
        }
        Expectation::Peaked => {
            if let Some(i) = detect_peak(metrics) {
                (Verdict::Sane, format!("peak at value[{i}]={:.4}  frac_range={fr:.3}", values[i]))
            } else if fr < 0.005 {
                (Verdict::Suspicious, format!("no peak found; frac_range={fr:.3} (very small)"))
            } else if r.abs() > 0.9 {
                (Verdict::Broken, format!("monotone (rho={r:+.2}) where peak expected; frac_range={fr:.3}"))
            } else {
                (Verdict::Suspicious, format!("no clear peak (rho={r:+.2}); frac_range={fr:.3}"))
            }
        }
        Expectation::Saturating => {
            // Saturating: monotone but slope decreasing. We check monotone
            // increasing AND second-half delta < first-half delta.
            if r > 0.6 {
                let n = metrics.len();
                let half_lo = metrics[n / 2] - metrics[0];
                let half_hi = metrics[n - 1] - metrics[n / 2];
                if half_lo.abs() > 1e-9 && half_hi.abs() <= 1.1 * half_lo.abs() {
                    (Verdict::Sane, format!("rho={r:+.2} half_lo={half_lo:+.3e} half_hi={half_hi:+.3e}"))
                } else {
                    (Verdict::Suspicious, format!("rho={r:+.2} but not saturating: half_lo={half_lo:+.3e} half_hi={half_hi:+.3e}"))
                }
            } else {
                (Verdict::Suspicious, format!("rho={r:+.2} (expected Saturating monotone)"))
            }
        }
        Expectation::Weak => {
            if fr < 0.05 {
                (Verdict::Sane, format!("frac_range={fr:.3} (small as expected)"))
            } else if fr < 0.15 {
                (Verdict::Suspicious, format!("frac_range={fr:.3} (larger than expected for Weak)"))
            } else {
                (Verdict::Suspicious, format!("frac_range={fr:.3} (much larger than expected for Weak)"))
            }
        }
        Expectation::ScaleInvariant => {
            if fr < 0.02 {
                (Verdict::Sane, format!("frac_range={fr:.4} (numerical noise level)"))
            } else if fr < 0.10 {
                (Verdict::Suspicious, format!("frac_range={fr:.3} (numerical knob shouldn't shift physics)"))
            } else {
                (Verdict::Broken, format!("frac_range={fr:.3} (numerical knob materially shifts physics — bug?)"))
            }
        }
        Expectation::TunedAcoustic => {
            // Treat as 'has SOME sensitivity' here; cross-RPM peak-shift is
            // checked separately at the cross-cutting stage.
            if fr < 0.005 {
                (Verdict::Suspicious, format!("frac_range={fr:.4} (too inert for tuned-acoustic param)"))
            } else {
                (Verdict::Sane, format!("frac_range={fr:.3}  rho={r:+.2}"))
            }
        }
        Expectation::Skip => (Verdict::Skipped, "no expectation".into()),
    }
}

// ---------------- Runner ----------------

/// Run one trial at (path, value, rpm). Apply the override to a fresh config
/// clone, build a fresh engine, run N_CYCLES, return the last cycle stats.
fn run_one(
    base_cfg: &engine_sim::model::sdm26::SDM26Config,
    path: &str,
    value: f64,
    rpm: f64,
) -> Result<(CycleStats, usize, f64), String> {
    let mut cfg = base_cfg.clone();
    apply_override(&mut cfg, path, value).map_err(|e| e.to_string())?;
    let t0 = Instant::now();
    let mut eng = SDM26Engine::new(cfg, JunctionKind::Stagnation);
    let r = eng.run_single_rpm(rpm, N_CYCLES, false, 0.0, 0, false);
    let walltime_s = t0.elapsed().as_secs_f64();
    let last = r
        .cycle_stats
        .last()
        .copied()
        .ok_or_else(|| "no cycles completed".to_string())?;
    Ok((last, r.cycle_stats.len(), walltime_s))
}

#[test]
#[ignore]
fn physics_validation_full() {
    println!("# SDM26 physics validation");
    let cfg = load_v1_json(sdm26_config_path()).expect("load base config");
    let schema = enumerate_schema(&cfg);
    println!("schema parameters: {}", schema.len());

    // Filter schema:
    //   - skip parameters with no expectation defined
    //   - for arrays, we sweep the SCALAR field (uniform value) — apply_override
    //     handles broadcasting; that's the same semantics any single-knob
    //     UI uses.
    let trials: Vec<(ParameterMeta, Vec<f64>)> = schema
        .iter()
        .map(|m| {
            let vals = linspace(m.suggested_min, m.suggested_max, N_VALUES);
            (m.clone(), vals)
        })
        .collect();

    // Build flat trial list.
    let total_runs: usize = trials.iter().map(|(_, v)| v.len() * RPMS.len()).sum();
    println!("total runs (param x value x rpm): {total_runs}");

    let t_start = Instant::now();
    let rows: Mutex<Vec<Row>> = Mutex::new(Vec::with_capacity(total_runs));
    let errors: Mutex<Vec<String>> = Mutex::new(Vec::new());

    // Parallel run.
    let flat: Vec<(String, f64, f64)> = trials
        .iter()
        .flat_map(|(m, vs)| {
            vs.iter()
                .flat_map(|v| RPMS.iter().map(move |r| (m.path.clone(), *v, *r)))
                .collect::<Vec<_>>()
        })
        .collect();

    flat.par_iter().for_each(|(path, value, rpm)| {
        match run_one(&cfg, path, *value, *rpm) {
            Ok((cs, n, dt)) => {
                rows.lock().unwrap().push(Row {
                    path: path.clone(),
                    value: *value,
                    rpm: *rpm,
                    cs,
                    n_cycles_run: n,
                    walltime_s: dt,
                });
            }
            Err(e) => {
                errors
                    .lock()
                    .unwrap()
                    .push(format!("path={path} value={value:.6e} rpm={rpm:.0}: {e}"));
            }
        }
    });

    let elapsed = t_start.elapsed().as_secs_f64();
    let mut rows = rows.into_inner().unwrap();
    let errs = errors.into_inner().unwrap();
    rows.sort_by(|a, b| {
        a.path
            .cmp(&b.path)
            .then(a.value.partial_cmp(&b.value).unwrap())
            .then(a.rpm.partial_cmp(&b.rpm).unwrap())
    });

    println!(
        "completed {} rows in {:.1}s  ({} errors)",
        rows.len(),
        elapsed,
        errs.len()
    );
    for e in &errs {
        println!("  ERR: {e}");
    }

    // ---------------- Write CSV ----------------

    let csv_path = repo_root().join("physics_validation_data.csv");
    let mut csv = File::create(&csv_path).expect("create csv");
    writeln!(
        csv,
        "path,value,rpm,n_cycles_run,walltime_s,imep_bar,bmep_bar,fmep_bar,ve_atm,intake_mass_per_cycle_g,f_residual,indicated_power_k_w,brake_power_k_w,wheel_power_k_w,indicated_torque_nm,brake_torque_nm,wheel_torque_nm,egt_mean,mass_total,nonconservation"
    )
    .unwrap();
    for r in &rows {
        writeln!(
            csv,
            "{path},{val:.10e},{rpm:.1},{ncyc},{wt:.4},{imep:.6e},{bmep:.6e},{fmep:.6e},{ve:.6e},{im:.6e},{fr:.6e},{ipk:.6e},{bpk:.6e},{wpk:.6e},{itq:.6e},{btq:.6e},{wtq:.6e},{egt:.6e},{mt:.6e},{nc:.6e}",
            path = r.path, val = r.value, rpm = r.rpm,
            ncyc = r.n_cycles_run, wt = r.walltime_s,
            imep = r.cs.imep_bar, bmep = r.cs.bmep_bar, fmep = r.cs.fmep_bar, ve = r.cs.ve_atm,
            im = r.cs.intake_mass_per_cycle_g, fr = r.cs.f_residual,
            ipk = r.cs.indicated_power_k_w, bpk = r.cs.brake_power_k_w, wpk = r.cs.wheel_power_k_w,
            itq = r.cs.indicated_torque_nm, btq = r.cs.brake_torque_nm, wtq = r.cs.wheel_torque_nm,
            egt = r.cs.egt_mean, mt = r.cs.mass_total, nc = r.cs.nonconservation,
        ).unwrap();
    }
    println!("wrote CSV: {}", csv_path.display());

    // ---------------- Score + write Markdown ----------------

    // Group rows by (path, rpm) -> sorted-by-value Vec.
    let mut grouped: BTreeMap<(String, u64), Vec<Row>> = BTreeMap::new();
    for r in &rows {
        grouped
            .entry((r.path.clone(), r.rpm.to_bits()))
            .or_default()
            .push(r.clone());
    }
    for v in grouped.values_mut() {
        v.sort_by(|a, b| a.value.partial_cmp(&b.value).unwrap());
    }

    // Per-param verdict aggregation: combine RPM verdicts conservatively
    // (the worst verdict wins).
    fn combine(a: Verdict, b: Verdict) -> Verdict {
        let rank = |v: Verdict| match v {
            Verdict::Sane => 0,
            Verdict::Skipped => 1,
            Verdict::Suspicious => 2,
            Verdict::Broken => 3,
        };
        if rank(a) >= rank(b) {
            a
        } else {
            b
        }
    }

    let md_path = repo_root().join("physics_validation_report.md");
    let mut md = File::create(&md_path).expect("create md");

    writeln!(md, "# SDM26 Physics Validation Report").unwrap();
    writeln!(md).unwrap();
    writeln!(
        md,
        "**Methodology:** sweep each schema parameter across `[suggestedMin, suggestedMax]` in {N_VALUES} steps; \
         run {N_CYCLES} cycles at {} RPMs `{:?}`; \
         capture last-cycle CycleStats; score the response against a hand-coded physical expectation.",
        RPMS.len(),
        RPMS
    )
    .unwrap();
    writeln!(md).unwrap();
    writeln!(md, "Junction: Stagnation.  Base config: `apps/desktop/src-tauri/resources/cfd/configs/sdm26.json`.").unwrap();
    writeln!(md, "Total runs: {} ({} errored).  Wall time: {:.1}s.", rows.len(), errs.len(), elapsed).unwrap();
    writeln!(md).unwrap();
    writeln!(md, "Verdict legend: ✓ SANE / ⚠ SUSPICIOUS / ✗ BROKEN / · SKIPPED").unwrap();
    writeln!(md).unwrap();

    // First pass: per-param scoring.
    let mut summary: Vec<(String, Verdict, String, Expectation, String, Vec<(f64, Vec<Row>)>)> = Vec::new();

    for meta in &schema {
        let (exp, primary_metric, hypothesis) = expectation_for(&meta.path);
        let mut per_rpm: Vec<(f64, Vec<Row>)> = Vec::new();
        let mut overall_verdict = Verdict::Sane;
        let mut diags: Vec<String> = Vec::new();
        for &rpm in RPMS {
            let key = (meta.path.clone(), rpm.to_bits());
            if let Some(rs) = grouped.get(&key) {
                let values: Vec<f64> = rs.iter().map(|r| r.value).collect();
                let metrics: Vec<f64> = rs.iter().map(|r| metric_of(&r.cs, primary_metric)).collect();
                let (v, d) = score_curve(exp, &values, &metrics);
                overall_verdict = combine(overall_verdict, v);
                diags.push(format!("rpm={rpm:.0}: {d}"));
                per_rpm.push((rpm, rs.clone()));
            }
        }
        let combined_diag = format!("{}\nhypothesis: {hypothesis}", diags.join("\n"));
        summary.push((
            meta.path.clone(),
            overall_verdict,
            primary_metric.to_string(),
            exp,
            combined_diag,
            per_rpm,
        ));
    }

    // Executive summary.
    let mut n_sane = 0;
    let mut n_susp = 0;
    let mut n_brk = 0;
    let mut n_skip = 0;
    for (_, v, _, _, _, _) in &summary {
        match v {
            Verdict::Sane => n_sane += 1,
            Verdict::Suspicious => n_susp += 1,
            Verdict::Broken => n_brk += 1,
            Verdict::Skipped => n_skip += 1,
        }
    }
    writeln!(md, "## Executive summary").unwrap();
    writeln!(md).unwrap();
    writeln!(md, "| Verdict | Count |").unwrap();
    writeln!(md, "|---|---|").unwrap();
    writeln!(md, "| ✓ SANE | {n_sane} |").unwrap();
    writeln!(md, "| ⚠ SUSPICIOUS | {n_susp} |").unwrap();
    writeln!(md, "| ✗ BROKEN | {n_brk} |").unwrap();
    writeln!(md, "| · SKIPPED | {n_skip} |").unwrap();
    writeln!(md).unwrap();

    // Quick-reference table.
    writeln!(md, "### Quick reference").unwrap();
    writeln!(md).unwrap();
    writeln!(md, "| Param | Verdict | Primary metric | Expectation |").unwrap();
    writeln!(md, "|---|---|---|---|").unwrap();
    for (path, v, m, e, _, _) in &summary {
        let mark = match v {
            Verdict::Sane => "✓",
            Verdict::Suspicious => "⚠",
            Verdict::Broken => "✗",
            Verdict::Skipped => "·",
        };
        writeln!(md, "| `{path}` | {mark} | `{m}` | {e:?} |").unwrap();
    }
    writeln!(md).unwrap();

    // Per-parameter detail.
    writeln!(md, "## Per-parameter detail").unwrap();
    writeln!(md).unwrap();
    for (path, v, m, _e, diag, per_rpm) in &summary {
        let mark = match v {
            Verdict::Sane => "✓ SANE",
            Verdict::Suspicious => "⚠ SUSPICIOUS",
            Verdict::Broken => "✗ BROKEN",
            Verdict::Skipped => "· SKIPPED",
        };
        writeln!(md, "### `{path}`  —  {mark}").unwrap();
        writeln!(md).unwrap();
        writeln!(md, "Primary metric: `{m}`.").unwrap();
        writeln!(md).unwrap();
        writeln!(md, "```").unwrap();
        writeln!(md, "{diag}").unwrap();
        writeln!(md, "```").unwrap();
        writeln!(md).unwrap();
        // Per-RPM data table.
        for (rpm, rs) in per_rpm {
            writeln!(md, "**rpm={rpm:.0}**").unwrap();
            writeln!(md).unwrap();
            writeln!(md, "| value | imep_bar | bmep_bar | ve_atm | brake_kW | egt_K | nonconserv |").unwrap();
            writeln!(md, "|---|---|---|---|---|---|---|").unwrap();
            for r in rs {
                writeln!(
                    md,
                    "| {:.4e} | {:.3} | {:.3} | {:.3} | {:.2} | {:.0} | {:+.2e} |",
                    r.value,
                    r.cs.imep_bar,
                    r.cs.bmep_bar,
                    r.cs.ve_atm,
                    r.cs.brake_power_k_w,
                    r.cs.egt_mean,
                    r.cs.nonconservation,
                )
                .unwrap();
            }
            writeln!(md).unwrap();
        }
    }

    // Cross-cutting findings.
    writeln!(md, "## Cross-cutting checks").unwrap();
    writeln!(md).unwrap();

    // 1. Drivetrain efficiency linearity (wheel_power_kW = brake_power_kW * eta).
    writeln!(md, "### Drivetrain efficiency: wheel_power = brake_power * eta").unwrap();
    writeln!(md).unwrap();
    if let Some(rs) = grouped.iter().find(|((p, _), _)| p == "drivetrain_efficiency").map(|(_, v)| v) {
        writeln!(md, "Per-row ratio wheel_kW / (brake_kW * eta) — should be exactly 1.0:").unwrap();
        writeln!(md).unwrap();
        writeln!(md, "| eta | brake_kW | wheel_kW | ratio |").unwrap();
        writeln!(md, "|---|---|---|---|").unwrap();
        for r in rs {
            let pred = r.cs.brake_power_k_w * r.value;
            let ratio = if pred.abs() > 1e-9 { r.cs.wheel_power_k_w / pred } else { f64::NAN };
            writeln!(md, "| {:.3} | {:.3} | {:.3} | {:.4} |", r.value, r.cs.brake_power_k_w, r.cs.wheel_power_k_w, ratio).unwrap();
        }
        writeln!(md).unwrap();
    }

    // 2. Ambient-pressure linearity: IMEP / p_ambient should be ~constant.
    writeln!(md, "### Ambient pressure: IMEP / p_amb ~ constant").unwrap();
    writeln!(md).unwrap();
    for &rpm in RPMS {
        let key = ("p_ambient".to_string(), rpm.to_bits());
        if let Some(rs) = grouped.get(&key) {
            writeln!(md, "**rpm={rpm:.0}**").unwrap();
            writeln!(md, "| p_ambient (Pa) | IMEP (bar) | IMEP*1e5/p_amb |").unwrap();
            writeln!(md, "|---|---|---|").unwrap();
            for r in rs {
                let ratio = r.cs.imep_bar * 1e5 / r.value;
                writeln!(md, "| {:.0} | {:.4} | {:.4} |", r.value, r.cs.imep_bar, ratio).unwrap();
            }
            writeln!(md).unwrap();
        }
    }

    // 3. CR vs Otto-cycle thermal-eff prediction
    writeln!(md, "### Compression ratio vs Otto thermal eff (gamma=1.35)").unwrap();
    writeln!(md).unwrap();
    let gamma = 1.35;
    for &rpm in RPMS {
        let key = ("cr".to_string(), rpm.to_bits());
        if let Some(rs) = grouped.get(&key) {
            writeln!(md, "**rpm={rpm:.0}**").unwrap();
            writeln!(md, "| cr | IMEP (bar) | Otto eta = 1-1/cr^(g-1) |").unwrap();
            writeln!(md, "|---|---|---|").unwrap();
            for r in rs {
                let eta_otto = 1.0 - 1.0 / r.value.powf(gamma - 1.0);
                writeln!(md, "| {:.2} | {:.3} | {:.3} |", r.value, r.cs.imep_bar, eta_otto).unwrap();
            }
            writeln!(md).unwrap();
        }
    }

    // 4. Mass-conservation check.
    writeln!(md, "### Mass conservation (max |nonconservation| per param)").unwrap();
    writeln!(md).unwrap();
    writeln!(md, "| Param | max |nonconserv| | worst rpm | worst value |").unwrap();
    writeln!(md, "|---|---|---|---|").unwrap();
    let mut nc_summary: Vec<(String, f64, f64, f64)> = Vec::new();
    for meta in &schema {
        let mut worst = 0.0_f64;
        let mut wr = 0.0_f64;
        let mut wv = 0.0_f64;
        for &rpm in RPMS {
            if let Some(rs) = grouped.get(&(meta.path.clone(), rpm.to_bits())) {
                for r in rs {
                    if r.cs.nonconservation.abs() > worst {
                        worst = r.cs.nonconservation.abs();
                        wr = rpm;
                        wv = r.value;
                    }
                }
            }
        }
        nc_summary.push((meta.path.clone(), worst, wr, wv));
    }
    nc_summary.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    for (p, w, wr, wv) in nc_summary.iter().take(10) {
        writeln!(md, "| `{p}` | {w:.3e} | {wr:.0} | {wv:.4e} |").unwrap();
    }
    writeln!(md).unwrap();

    // 5. Runner length acoustic check: VE-peak-RPM shift with length.
    writeln!(md, "### Intake runner length acoustic tuning").unwrap();
    writeln!(md).unwrap();
    writeln!(md, "Quarter-wave estimate: f_tuned = a / (4L); RPM_tuned = 2*f / (n_per_cycle / 60).").unwrap();
    writeln!(md, "For intake event spanning ~half a 4-stroke cycle, expect peak-VE near the runner's").unwrap();
    writeln!(md, "second harmonic of the engine cycle frequency at given RPM.").unwrap();
    writeln!(md).unwrap();
    writeln!(md, "Per runner-length value, VE at each RPM:").unwrap();
    writeln!(md).unwrap();
    // Build matrix [length][rpm] -> ve_atm
    let mut lengths: Vec<f64> = Vec::new();
    let mut length_table: BTreeMap<u64, Vec<(f64, f64)>> = BTreeMap::new();
    for &rpm in RPMS {
        if let Some(rs) = grouped.get(&("runner_length".to_string(), rpm.to_bits())) {
            for r in rs {
                length_table
                    .entry(r.value.to_bits())
                    .or_default()
                    .push((rpm, r.cs.ve_atm));
                if !lengths.iter().any(|&l| (l - r.value).abs() < 1e-9) {
                    lengths.push(r.value);
                }
            }
        }
    }
    lengths.sort_by(|a, b| a.partial_cmp(b).unwrap());
    write!(md, "| runner_length (m) |").unwrap();
    for &rpm in RPMS {
        write!(md, " VE@{:.0} |", rpm).unwrap();
    }
    writeln!(md).unwrap();
    write!(md, "|---|").unwrap();
    for _ in RPMS {
        write!(md, "---|").unwrap();
    }
    writeln!(md).unwrap();
    for &len in &lengths {
        let mut by_rpm = length_table.get(&len.to_bits()).cloned().unwrap_or_default();
        by_rpm.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        write!(md, "| {:.4} |", len).unwrap();
        for &rpm in RPMS {
            let v = by_rpm.iter().find(|(r, _)| (r - rpm).abs() < 1e-6).map(|(_, v)| *v).unwrap_or(f64::NAN);
            write!(md, " {:.3} |", v).unwrap();
        }
        writeln!(md).unwrap();
    }
    writeln!(md).unwrap();

    // 6. Restrictor choke-cliff check: brake_power vs throat diameter at 12000 RPM
    writeln!(md, "### Restrictor throat diameter — choke-cliff").unwrap();
    writeln!(md).unwrap();
    if let Some(rs) = grouped.get(&("restrictor_throat_diameter".to_string(), 12000.0_f64.to_bits())) {
        writeln!(md, "**rpm=12000**").unwrap();
        writeln!(md, "| throat (m) | mass_in_restrictor | brake_kW | VE |").unwrap();
        writeln!(md, "|---|---|---|---|").unwrap();
        for r in rs {
            writeln!(md, "| {:.4} | {:.4e} | {:.3} | {:.3} |", r.value, r.cs.mass_in_restrictor, r.cs.brake_power_k_w, r.cs.ve_atm).unwrap();
        }
        writeln!(md).unwrap();
    }

    // Top-3 lists.
    writeln!(md, "## Top concerning findings").unwrap();
    writeln!(md).unwrap();
    let mut broken: Vec<_> = summary.iter().filter(|(_, v, _, _, _, _)| *v == Verdict::Broken).collect();
    let mut suspicious: Vec<_> = summary.iter().filter(|(_, v, _, _, _, _)| *v == Verdict::Suspicious).collect();
    broken.sort_by(|a, b| a.0.cmp(&b.0));
    suspicious.sort_by(|a, b| a.0.cmp(&b.0));
    writeln!(md, "### Broken ({} total)", broken.len()).unwrap();
    for (p, _, m, e, _, _) in &broken {
        writeln!(md, "- `{p}` — metric `{m}`, expected `{e:?}`").unwrap();
    }
    writeln!(md).unwrap();
    writeln!(md, "### Suspicious ({} total)", suspicious.len()).unwrap();
    for (p, _, m, e, _, _) in &suspicious {
        writeln!(md, "- `{p}` — metric `{m}`, expected `{e:?}`").unwrap();
    }
    writeln!(md).unwrap();

    if !errs.is_empty() {
        writeln!(md, "## Errors").unwrap();
        writeln!(md).unwrap();
        for e in &errs {
            writeln!(md, "- `{e}`").unwrap();
        }
    }

    println!("wrote report: {}", md_path.display());

    // Don't fail the test on suspicious/broken — the report is the deliverable.
    // But DO fail on totally-bad numerical disasters (all-NaN, etc).
    if rows.is_empty() {
        panic!("no rows captured");
    }
    if !errs.is_empty() && errs.len() > total_runs / 4 {
        panic!("too many run errors: {} of {}", errs.len(), total_runs);
    }
}
