//! `study.toml` schema — the reproducibility unit.
//!
//! Required sections: `[run]`, `[environment]`.
//! Optional: `[sweep]`, `[[acceptance]]`.
//!
//! Validation rules (spec C4 + C6):
//!   - recorded=true REQUIRES seed
//!   - recorded=true REQUIRES rayon_threads == 1
//!   - every `[[acceptance]]` entry must have a non-empty citation
//!
//! plan-review-v1 #3: RPM is `Vec<f64>` (not `Vec<u32>`) so that
//! `SDM26Engine::run_single_rpm(rpm: f64, …)` doesn't need a cast at
//! the call site.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Study {
    pub run: Run,
    pub environment: Environment,
    #[serde(default)]
    pub sweep: Option<Sweep>,
    #[serde(default)]
    pub acceptance: Vec<Acceptance>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Run {
    /// Path to the engine_sim v1 JSON config file.
    pub config: String,
    /// RPM operating points to evaluate. plan-review-v1 #3: `Vec<f64>`.
    pub rpm: Vec<f64>,
    /// Number of crank cycles per RPM.
    pub cycles: u32,
    /// When true, this run is reproducibility-recorded — seed required,
    /// rayon_threads must equal 1.
    pub recorded: bool,
    /// Random seed. Required when recorded=true (enforced by `validate()`).
    #[serde(default)]
    pub seed: Option<u64>,
    /// Optional junction kind override (parity tests typically use "characteristic").
    /// plan-review-v1 #1: surface this so the run subcommand can pick a default.
    #[serde(default)]
    pub junction: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Environment {
    pub target_triple: String,
    pub rustc_version: String,
    pub rayon_threads: u32,
    pub libm_source: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Sweep {
    pub sampler: String,
    pub n_trials: u32,
    pub parameters: Vec<SweepParam>,
    /// Optional full-factorial grid axes (finding 0032). Every sampled
    /// trial is run at every grid point, e.g. one RPM sweep per runner
    /// length for a variable-length-intake envelope study:
    ///
    /// ```toml
    /// [[sweep.grid]]
    /// name = "runner_length"
    /// values = [0.18, 0.21, 0.245, 0.28, 0.32]
    /// ```
    #[serde(default)]
    pub grid: Vec<GridAxis>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GridAxis {
    /// `apply_override` path (e.g. `runner_length`, `plenum_volume`).
    pub name: String,
    pub values: Vec<f64>,
}

impl Sweep {
    /// Cartesian product of the grid axes as (name, value) override lists,
    /// axes in name order (stable NDJSON). One empty point when no grid.
    pub fn grid_points(&self) -> Vec<Vec<(String, f64)>> {
        let mut axes = self.grid.clone();
        axes.sort_by(|a, b| a.name.cmp(&b.name));
        let mut pts: Vec<Vec<(String, f64)>> = vec![vec![]];
        for ax in &axes {
            let mut next = Vec::with_capacity(pts.len() * ax.values.len());
            for p in &pts {
                for &v in &ax.values {
                    let mut q = p.clone();
                    q.push((ax.name.clone(), v));
                    next.push(q);
                }
            }
            pts = next;
        }
        pts
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SweepParam {
    pub name: String,
    pub min: f64,
    pub max: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Acceptance {
    pub metric: String,
    pub target: f64,
    /// Tolerance: "5%" or "±5%" or "0.95x". Parsed at validate time.
    pub tolerance: String,
    /// Citation pointer. spec C6: must be non-empty.
    pub citation: String,
}

impl Study {
    /// Cross-field validation. Serde catches missing required keys; this
    /// catches the semantic rules (C4 + C6).
    pub fn validate(&self) -> Result<(), String> {
        if self.run.recorded {
            if self.run.seed.is_none() {
                return Err("recorded=true requires `seed`".into());
            }
            if self.environment.rayon_threads != 1 {
                return Err(format!(
                    "recorded=true requires rayon_threads=1, got {}",
                    self.environment.rayon_threads
                ));
            }
        }
        if let Some(sw) = &self.sweep {
            for ax in &sw.grid {
                if ax.values.is_empty() {
                    return Err(format!("sweep.grid axis {:?} has no values", ax.name));
                }
            }
        }
        for a in &self.acceptance {
            if a.citation.trim().is_empty() {
                return Err(format!(
                    "acceptance metric {:?} has empty citation",
                    a.metric
                ));
            }
        }
        Ok(())
    }
}
