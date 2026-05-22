//! `helios-bench run` — execute one or more single-RPM simulations from
//! a `study.toml`, emit NDJSON with one trial record per RPM.
//!
//! plan-review-v1 #1: SDM26Engine::new is infallible and takes
//! (cfg, junction_kind). plan-review-v1 #2: run_single_rpm has
//! six args and returns RunResult { cycle_stats: Vec<CycleStats>, ... }.
//! We aggregate by taking the LAST CycleStats (or last converged if
//! stop_at_convergence early-stopped the run). plan-review-v1 #7:
//! load_v1_json -> Result<SDM26Config, ConfigLoadError>.
//! plan-review-v1 #8: callers pass `crates/engine-sim/python_ref/configs/sdm26.json`
//! as the canonical baseline.

use crate::environment::capture;
use crate::ndjson::ResultWriter;
use crate::study::Study;
use anyhow::{bail, Context, Result};
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

/// Summary returned from library-mode `run`: enough for an agent to decide
/// what to do next without re-parsing the NDJSON. CLI use discards it.
#[derive(Debug, Serialize)]
pub struct RunSummary {
    pub out_path: PathBuf,
    pub commit_hash: String,
    pub seed: Option<u64>,
    pub n_trials: usize,
    pub rpms: Vec<f64>,
}

pub fn execute(args: Args) -> Result<()> {
    execute_with(&args).map(|_| ())
}

pub fn execute_with(args: &Args) -> Result<RunSummary> {
    let txt = std::fs::read_to_string(&args.study)
        .with_context(|| format!("read {}", args.study.display()))?;
    let study: Study = toml::from_str(&txt).context("parse study.toml")?;
    study.validate().map_err(|e| anyhow::anyhow!("validate: {e}"))?;

    // Recorded runs pin to single-thread for line-order determinism.
    // (plan-review-v1 I-9 flags the env-var mutation as racy; helios-bench
    // is a single-process binary so this is safe here, but the sweep
    // subcommand will use rayon::ThreadPoolBuilder::install scopes
    // when it lands in Task 10.)
    if study.run.recorded {
        std::env::set_var("RAYON_NUM_THREADS", "1");
    }

    let commit = args
        .commit
        .clone()
        .or_else(|| current_commit_hash().ok())
        .unwrap_or_else(|| "unknown".into());

    let env = capture(study.environment.rayon_threads);
    let mut writer = ResultWriter::create(&args.out, &env, study.run.seed, &commit)?;

    let cfg = load_v1_json(&study.run.config)
        .with_context(|| format!("load engine config {}", study.run.config))?;

    let junction_kind = parse_junction_kind(study.run.junction.as_deref())?;

    let mut n_trials: usize = 0;
    for &rpm in &study.run.rpm {
        // Fresh engine per RPM keeps each operating point independent
        // (matches the parity-test convention).
        let mut engine = SDM26Engine::new(cfg.clone(), junction_kind);

        // Convergence params: tol=0.005, min_cycles=3, stop=false matches
        // crates/engine-sim/tests/parity_engine.rs:25. We pass stop=false
        // so the run always executes the full requested cycle count and
        // the LAST cycle is the canonical aggregate.
        let result: RunResult = engine.run_single_rpm(
            rpm,
            study.run.cycles as usize,
            false,
            0.005,
            3,
            false,
        );

        let stats: &CycleStats = result
            .cycle_stats
            .last()
            .ok_or_else(|| anyhow::anyhow!("rpm={rpm}: no cycle_stats produced"))?;

        let row = json!({
            "kind": "trial",
            "rpm": result.rpm,
            "n_cycles_requested": result.n_cycles_requested,
            "n_cycles_run": result.n_cycles_run,
            "step_count": result.step_count,
            "converged_cycle": result.converged_cycle,
            // Aggregate metrics — taken from the LAST CycleStats.
            "cycle": stats.cycle,
            "imep_bar": stats.imep_bar,
            "bmep_bar": stats.bmep_bar,
            "fmep_bar": stats.fmep_bar,
            "ve_atm": stats.ve_atm,
            "brake_power_kW": stats.brake_power_k_w,
            "brake_torque_Nm": stats.brake_torque_nm,
            "indicated_power_kW": stats.indicated_power_k_w,
            "indicated_torque_Nm": stats.indicated_torque_nm,
            "wheel_power_kW": stats.wheel_power_k_w,
            "egt_mean_K": stats.egt_mean,
            "mass_drift_kg": stats.mass_drift,
            "mass_total_kg": stats.mass_total,
            "nonconservation": stats.nonconservation,
            "intake_mass_per_cycle_g": stats.intake_mass_per_cycle_g,
            "f_residual": stats.f_residual,
        });
        writer.write(&row)?;
        n_trials += 1;
    }

    writer.finish()?;
    Ok(RunSummary {
        out_path: args.out.clone(),
        commit_hash: commit,
        seed: study.run.seed,
        n_trials,
        rpms: study.run.rpm.clone(),
    })
}

fn parse_junction_kind(s: Option<&str>) -> Result<JunctionKind> {
    match s.map(|x| x.to_ascii_lowercase()).as_deref() {
        // Default to Characteristic — that's the parity-test default
        // (crates/engine-sim/tests/parity_engine.rs).
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
