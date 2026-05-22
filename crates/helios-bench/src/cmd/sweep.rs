//! `helios-bench sweep` — DOE sweep over a single SDM26 baseline config.
//!
//! Reads a `study.toml` with a `[sweep]` section, draws N samples in
//! normalized [0,1) via `cfd_core::optimization::sampler::sample`, maps
//! each sample to physical bounds, applies the parameter overrides via
//! `cfd_core::params::apply_override`, runs the engine for every
//! `[run].rpm` entry, and writes one NDJSON `kind=trial` line per
//! `(trial_id, rpm)` combination.
//!
//! Known Issues resolved here (plan-review-v1):
//!  - #4: `SamplerKind` imported from `cfd_core::dto` (not `optimization::sampler`).
//!  - #6: `apply_override` is the real `cfd_core::params::apply_override`
//!        (`&mut SDM26Config, &str, f64`). The plan's stub is dropped.
//!  - I-9: `RAYON_NUM_THREADS` env-var mutation is racy. We build a
//!         single-thread rayon pool and `install`-scope the run instead.
//!  - Spec C4 stable order: parameters are sorted by name before
//!         iteration so the override JSON map serializes in stable order.

use crate::environment::capture;
use crate::ndjson::ResultWriter;
use crate::study::Study;
use anyhow::{bail, Context, Result};
use cfd_core::dto::SamplerKind;
use cfd_core::optimization::sampler::sample;
use cfd_core::params::apply_override;
use clap::Args as ClapArgs;
use engine_sim::config::loader::load_v1_json;
use engine_sim::model::sdm26::{CycleStats, JunctionKind, RunResult, SDM26Engine};
use serde::Serialize;
use serde_json::json;
use std::path::PathBuf;

#[derive(ClapArgs)]
pub struct Args {
    /// Path to study.toml
    pub study: PathBuf,
    /// Output NDJSON path
    #[arg(long)]
    pub out: PathBuf,
    /// Override commit hash (default: read from `git rev-parse HEAD`)
    #[arg(long)]
    pub commit: Option<String>,
}

/// Summary returned from library-mode `sweep`.
#[derive(Debug, Serialize)]
pub struct SweepSummary {
    pub out_path: PathBuf,
    pub commit_hash: String,
    pub seed: Option<u64>,
    pub trials: usize,
    pub rpms: Vec<f64>,
    pub sampler: String,
    pub parameters: Vec<String>,
}

pub fn execute(args: Args) -> Result<()> {
    execute_with(&args).map(|_| ())
}

pub fn execute_with(args: &Args) -> Result<SweepSummary> {
    let txt = std::fs::read_to_string(&args.study)
        .with_context(|| format!("read {}", args.study.display()))?;
    let study: Study = toml::from_str(&txt).context("parse study.toml")?;
    study.validate().map_err(|e| anyhow::anyhow!("validate: {e}"))?;

    let sweep_spec = study
        .sweep
        .clone()
        .ok_or_else(|| anyhow::anyhow!("[sweep] section required for `sweep` subcommand"))?;

    // Spec C4 stable order: sort parameters by name once, then preserve
    // that order everywhere downstream (sampler column order, override
    // JSON map). plan-review-v1: drop the in-loop sort that recomputed
    // the same permutation N_trials times.
    let mut params = sweep_spec.parameters.clone();
    params.sort_by(|a, b| a.name.cmp(&b.name));

    let kind = match sweep_spec.sampler.to_ascii_lowercase().as_str() {
        "lhs" => SamplerKind::Lhs,
        "random" => SamplerKind::Random,
        other => bail!("unknown sampler: {other:?} (expected lhs|random)"),
    };

    let commit = args
        .commit
        .clone()
        .or_else(|| current_commit_hash().ok())
        .unwrap_or_else(|| "unknown".into());

    let env = capture(study.environment.rayon_threads);
    let mut writer = ResultWriter::create(&args.out, &env, study.run.seed, &commit)?;

    let base_cfg = load_v1_json(&study.run.config)
        .with_context(|| format!("load engine config {}", study.run.config))?;
    let junction_kind = parse_junction_kind(study.run.junction.as_deref())?;

    let samples = sample(kind, sweep_spec.n_trials as usize, params.len(), study.run.seed);

    // plan-review-v1 I-9: replace `std::env::set_var("RAYON_NUM_THREADS",
    // "1")` (racy in edition 2024) with an install-scoped single-thread
    // pool. For recorded runs we wrap the body so any rayon parallel
    // iterator the engine pulls in sees a 1-thread pool.
    let body = |writer: &mut ResultWriter| -> Result<()> {
        for (trial_id, row) in samples.iter().enumerate() {
            let mut cfg = base_cfg.clone();
            // Build the override map in the SAME order as `params` so
            // the JSON output is stable for spec C4 byte-compare.
            let mut overrides = serde_json::Map::new();
            for (p, &x01) in params.iter().zip(row.iter()) {
                let v = p.min + x01 * (p.max - p.min);
                apply_override(&mut cfg, &p.name, v).with_context(|| {
                    format!("apply_override {}={} for trial {}", p.name, v, trial_id)
                })?;
                overrides.insert(p.name.clone(), json!(v));
            }
            for &rpm in &study.run.rpm {
                let mut engine = SDM26Engine::new(cfg.clone(), junction_kind);
                let result: RunResult =
                    engine.run_single_rpm(rpm, study.run.cycles as usize, false, 0.005, 3, false);
                let stats: &CycleStats = result
                    .cycle_stats
                    .last()
                    .ok_or_else(|| anyhow::anyhow!("trial {trial_id} rpm={rpm}: no cycle_stats"))?;
                writer.write(&json!({
                    "kind": "trial",
                    "trial_id": trial_id,
                    "rpm": result.rpm,
                    "cycles": result.n_cycles_run,
                    "converged_cycle": result.converged_cycle,
                    "overrides": overrides,
                    "imep_bar": stats.imep_bar,
                    "bmep_bar": stats.bmep_bar,
                    "fmep_bar": stats.fmep_bar,
                    "ve_atm": stats.ve_atm,
                    "brake_power_kW": stats.brake_power_k_w,
                    "brake_torque_Nm": stats.brake_torque_nm,
                    "indicated_power_kW": stats.indicated_power_k_w,
                    "egt_mean_K": stats.egt_mean,
                    "mass_drift_kg": stats.mass_drift,
                    "mass_total_kg": stats.mass_total,
                    "nonconservation": stats.nonconservation,
                    "intake_mass_per_cycle_g": stats.intake_mass_per_cycle_g,
                    "f_residual": stats.f_residual,
                }))?;
            }
        }
        Ok(())
    };

    if study.run.recorded {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(1)
            .build()
            .context("build single-thread rayon pool")?;
        pool.install(|| body(&mut writer))?;
    } else {
        body(&mut writer)?;
    }

    writer.finish()?;
    Ok(SweepSummary {
        out_path: args.out.clone(),
        commit_hash: commit,
        seed: study.run.seed,
        trials: sweep_spec.n_trials as usize,
        rpms: study.run.rpm.clone(),
        sampler: sweep_spec.sampler.clone(),
        parameters: params.iter().map(|p| p.name.clone()).collect(),
    })
}

fn parse_junction_kind(s: Option<&str>) -> Result<JunctionKind> {
    match s.map(|x| x.to_ascii_lowercase()).as_deref() {
        None | Some("characteristic") | Some("char") => Ok(JunctionKind::Characteristic),
        Some("stagnation") | Some("cv") => Ok(JunctionKind::Stagnation),
        Some(other) => bail!("unknown junction kind {other:?}; expected 'characteristic' or 'stagnation'"),
    }
}

fn current_commit_hash() -> Result<String> {
    let out = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .output()?;
    if !out.status.success() {
        bail!("git rev-parse HEAD failed");
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}
