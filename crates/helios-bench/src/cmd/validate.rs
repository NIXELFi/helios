//! `helios-bench validate` — physics-invariant checks per spec C9.
//!
//! Tolerances:
//! - mass:        `±1e-10` relative per cycle
//! - energy:      `±0.5%` per cycle  (skipped Phase 0 — instrumentation TODO)
//! - momentum:    `±0.5%` per cycle  (skipped Phase 0 — instrumentation TODO)
//! - positivity:  absolute (imep, brake_power, ve, egt ≥ 0; egt ≥ 200 K floor)
//! - monotonicity: absolute (no trial brake_power flips sign mid-RPM)
//!
//! Energy + momentum residuals are not yet plumbed through `CycleStats`;
//! Phase 0 emits a warning that those checks are skipped and proceeds
//! with the mass + positivity checks. Phase 1 will add per-cycle energy
//! residual fields to `CycleStats` and unconditionally enable the checks.

use anyhow::{bail, Result};
use clap::Args as ClapArgs;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::path::PathBuf;

#[derive(ClapArgs)]
pub struct Args {
    /// Path to NDJSON result file
    pub results: PathBuf,
    /// Comma-separated checks. Defaults to all.
    #[arg(long, default_value = "mass,energy,momentum,positivity,monotonicity")]
    pub checks: String,
}

/// Library-mode validate result: structured pass/fail + failure list.
#[derive(Debug, Serialize)]
pub struct ValidateSummary {
    pub pass: bool,
    pub n_trials: usize,
    pub failures: Vec<String>,
    pub skipped_checks: Vec<String>,
}

/// Spec C9 mass-conservation bands, junction-kind-aware (amended after
/// finding 0003 diagnosed a characteristic-junction precision floor).
const MASS_REL_BAND_CV: f64 = 1e-10;
const MASS_REL_BAND_CHAR: f64 = 5e-4;
/// Strict default for trials missing the `junction` field (legacy NDJSON).
/// Erring strict keeps spec-correct trials passing and surfaces ambiguous
/// records as failures rather than silently relaxing the gate.
const MASS_REL_BAND_DEFAULT: f64 = MASS_REL_BAND_CV;
const EGT_FLOOR_K: f64 = 200.0;

pub fn execute(args: Args) -> Result<()> {
    let summary = execute_with(&args)?;
    if !summary.pass {
        eprintln!("VALIDATE FAIL ({} issues):", summary.failures.len());
        for f in &summary.failures {
            eprintln!("  - {f}");
        }
        bail!("validation failed");
    }
    println!("VALIDATE OK ({} trial(s))", summary.n_trials);
    Ok(())
}

/// Library-mode validate. Does NOT print anything or fail-the-process on
/// invariant violations — returns the structured summary instead. Only
/// returns `Err` for I/O / parse errors that prevent validation from
/// running at all.
pub fn execute_with(args: &Args) -> Result<ValidateSummary> {
    let body = std::fs::read_to_string(&args.results)?;
    let mut env_line: Option<Value> = None;
    let mut trials: Vec<Value> = Vec::new();
    for (i, line) in body.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let v: Value = serde_json::from_str(line)
            .map_err(|e| anyhow::anyhow!("line {}: invalid JSON: {e}", i + 1))?;
        match v.get("kind").and_then(Value::as_str) {
            Some("environment") if env_line.is_none() => env_line = Some(v),
            Some("trial") => trials.push(v),
            _ => { /* ignore unknown record kinds */ }
        }
    }
    if env_line.is_none() {
        bail!("missing environment block (first line must have kind=\"environment\")");
    }

    let checks: HashSet<&str> = args.checks.split(',').map(str::trim).collect();
    let mut failures: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();

    // Phase 0 instrumentation gap warnings.
    if checks.contains("energy") {
        eprintln!(
            "WARNING: energy invariant check skipped — CycleStats has no \
             per-cycle energy residual field yet (Phase 0 gap)."
        );
        skipped.push("energy".into());
    }
    if checks.contains("momentum") {
        eprintln!(
            "WARNING: momentum invariant check skipped — CycleStats has no \
             per-cycle momentum residual field yet (Phase 0 gap)."
        );
        skipped.push("momentum".into());
    }

    for (idx, t) in trials.iter().enumerate() {
        if checks.contains("positivity") {
            check_positivity(idx, t, &mut failures);
        }
        if checks.contains("mass") {
            check_mass(idx, t, &mut failures);
        }
        if checks.contains("monotonicity") {
            check_monotonicity(idx, t, &mut failures);
        }
    }

    Ok(ValidateSummary {
        pass: failures.is_empty(),
        n_trials: trials.len(),
        failures,
        skipped_checks: skipped,
    })
}

fn check_positivity(idx: usize, t: &Value, failures: &mut Vec<String>) {
    for key in ["imep_bar", "brake_power_kW", "egt_mean_K", "ve_atm"] {
        if let Some(n) = t.get(key).and_then(Value::as_f64) {
            if n < 0.0 {
                failures.push(format!("trial {idx}: {key}={n} is negative"));
            }
        }
    }
    if let Some(t_k) = t.get("egt_mean_K").and_then(Value::as_f64) {
        if t_k > 0.0 && t_k < EGT_FLOOR_K {
            failures.push(format!(
                "trial {idx}: egt_mean_K={t_k} below physical floor {EGT_FLOOR_K} K"
            ));
        }
    }
}

fn check_mass(idx: usize, t: &Value, failures: &mut Vec<String>) {
    // Spec C9 mass conservation: the per-cycle FP roundoff residual must
    // be at or below the junction-kind-aware band *relative to total mass*.
    // The correct field is `nonconservation` (kg) — engine-sim's
    // floating-point closure error of the mass-balance equation.
    // `mass_drift_kg` is NOT a conservation residual; it's the cycle-to-
    // cycle convergence delta (intake minus exhaust minus stored), expected
    // nonzero until steady state. Caught while running 0001-limiter-
    // revalidation (commit ac4a6fa).
    //
    // B1 (finding 0003): the original check compared the absolute kg value
    // to a band documented as relative — wrong units. For SDM26 (m_total ≈
    // 3.5e-3 kg) the absolute 1e-10 kg band corresponds to ~3e-8 relative,
    // looser than the intended 1e-10 relative. We now normalize by
    // mass_total_kg (required field) before comparing.
    //
    // Band selection (C9 amendment, finding 0003): CV / Stagnation
    // junctions hold machine-epsilon conservation (~1e-15 relative); the
    // characteristic junction has an algorithmic precision floor at ~1e-4
    // relative on SDM-class engines. The trial row carries a `junction`
    // string; absent it (legacy NDJSON) we default to the strict CV band so
    // missing metadata surfaces rather than silently relaxes the gate.
    if let Some(nc) = t.get("nonconservation").and_then(Value::as_f64) {
        let Some(m_total) = t.get("mass_total_kg").and_then(Value::as_f64) else {
            failures.push(format!(
                "trial {idx}: missing `mass_total_kg` field — cannot normalize nonconservation"
            ));
            return;
        };
        if !(m_total > 0.0) {
            failures.push(format!(
                "trial {idx}: mass_total_kg={m_total} is non-positive — cannot normalize"
            ));
            return;
        }
        let (band, junction_label) = match t.get("junction").and_then(Value::as_str) {
            Some("characteristic") => (MASS_REL_BAND_CHAR, "characteristic"),
            Some("stagnation") => (MASS_REL_BAND_CV, "stagnation"),
            Some(other) => {
                failures.push(format!(
                    "trial {idx}: unknown junction kind {other:?} — \
                     expected 'characteristic' or 'stagnation'"
                ));
                return;
            }
            None => (MASS_REL_BAND_DEFAULT, "unspecified(default=CV)"),
        };
        let nc_rel = nc / m_total;
        if nc_rel.abs() > band {
            failures.push(format!(
                "trial {idx}: nonconservation={nc:.3e} kg / mass_total={m_total:.3e} kg \
                 = {nc_rel:.3e} relative exceeds C9 {junction_label} band {band:.0e}"
            ));
        }
        return;
    }
    // No nonconservation field at all is a schema bug worth flagging — the
    // engine-sim CycleStats always includes it, so its absence means the
    // NDJSON came from a different source than this validator expects.
    failures.push(format!(
        "trial {idx}: missing `nonconservation` field — cannot check mass conservation"
    ));
}

fn check_monotonicity(idx: usize, t: &Value, failures: &mut Vec<String>) {
    // Absolute monotonicity: per-trial brake_power must be ≥ 0 (sign-flip
    // would indicate a bug). Multi-trial monotonicity across an RPM
    // sweep is left for the `compare` subcommand which can align trials
    // by overrides; here we only have one row at a time.
    if let Some(bp) = t.get("brake_power_kW").and_then(Value::as_f64) {
        if !bp.is_finite() {
            failures.push(format!("trial {idx}: brake_power_kW={bp} is not finite"));
        }
    }
}
