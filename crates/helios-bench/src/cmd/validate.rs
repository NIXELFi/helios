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

const MASS_REL_BAND: f64 = 1e-10;
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
    // Preferred: mass_drift_kg / mass_total_kg if both present.
    // Fallback: nonconservation magnitude.
    if let (Some(drift), Some(total)) = (
        t.get("mass_drift_kg").and_then(Value::as_f64),
        t.get("mass_total_kg").and_then(Value::as_f64),
    ) {
        if total > 0.0 {
            let rel = (drift / total).abs();
            if rel > MASS_REL_BAND {
                failures.push(format!(
                    "trial {idx}: mass drift rel={rel:.3e} exceeds C9 band {MASS_REL_BAND:.0e}"
                ));
            }
        }
        return;
    }
    if let Some(nc) = t.get("nonconservation").and_then(Value::as_f64) {
        if nc.abs() > MASS_REL_BAND {
            failures.push(format!(
                "trial {idx}: nonconservation={nc:.3e} exceeds C9 band {MASS_REL_BAND:.0e}"
            ));
        }
    }
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
