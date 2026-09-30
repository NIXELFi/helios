//! `helios-bench ensemble` — prior-sampled uncertainty ensembles (finding 0038).
//!
//! Draws `n_samples` parameter sets from per-parameter priors (Latin
//! hypercube by default), applies each through `cfd_core::params::apply_override`
//! on top of one base config, and runs every (sample, rpm) point in
//! parallel. One NDJSON line per point carries the sampled values, the
//! applied override values and the engine outputs the calibration
//! likelihood needs (VE, brake torque/power, IMEP, mean plenum pressure).
//! Likelihood weighting / posterior bands are left to analysis scripts:
//! the car references (MAP-VE, dyno) and the error model are study
//! choices that change faster than the runner.
//!
//! ```toml
//! [ensemble]
//! config = "../../apps/desktop/src-tauri/resources/cfd/configs/sdm26_asbuilt_cal.json"
//! n_samples = 64
//! seed = 38
//! sampler = "lhs"            # lhs | random
//! include_nominal = true     # sample 0 = the unperturbed base config
//! rpm = [4000, 4250]         # and/or
//! rpm_ranges = [[4000, 10750, 250], [11000, 12500, 500]]
//! cycles = 30
//! threads = 15
//!
//! [[param]]
//! name = "exhaust_valve_open_angle"
//! mode = "delta"             # absolute | delta (base + v) | scale (base * v)
//! dist = "uniform"           # uniform | loguniform | normal (mean, sd; optional min/max clip)
//! min = -8.0
//! max = 8.0
//! also = []                  # extra override paths that get the same transform
//! ```
//!
//! Re-running with the same `--out` resumes: points already written for
//! the same study hash are skipped.

use anyhow::{bail, Context, Result};
use cfd_core::dto::SamplerKind;
use cfd_core::optimization::sampler::sample;
use cfd_core::params::{apply_override, enumerate_schema};
use clap::Args as ClapArgs;
use engine_sim::config::loader::load_v1_json_with_warnings;
use engine_sim::model::sdm26::{
    CycleLoopState, CycleObserver, CycleOutcome, JunctionKind, SDM26Config, SDM26Engine,
};
use engine_sim::solver::state::N_VARS;
use rayon::prelude::*;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(ClapArgs)]
pub struct Args {
    /// Path to the ensemble study TOML
    pub study: PathBuf,
    /// Output NDJSON (appended / resumed)
    #[arg(long)]
    pub out: PathBuf,
    /// Override the study's thread count
    #[arg(long)]
    pub threads: Option<usize>,
    /// Only print the sampled parameter table (CSV) and exit
    #[arg(long)]
    pub dry_run: bool,
    /// Run only the first N samples (smoke tests)
    #[arg(long)]
    pub max_samples: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EnsembleFile {
    pub ensemble: EnsembleSpec,
    #[serde(default)]
    pub param: Vec<ParamSpec>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EnsembleSpec {
    pub config: String,
    pub n_samples: usize,
    #[serde(default = "default_seed")]
    pub seed: u64,
    #[serde(default = "default_sampler")]
    pub sampler: String,
    #[serde(default = "default_true")]
    pub include_nominal: bool,
    #[serde(default)]
    pub rpm: Vec<f64>,
    #[serde(default)]
    pub rpm_ranges: Vec<[f64; 3]>,
    #[serde(default = "default_cycles")]
    pub cycles: usize,
    #[serde(default = "default_threads")]
    pub threads: usize,
}
fn default_seed() -> u64 { 38 }
fn default_sampler() -> String { "lhs".into() }
fn default_true() -> bool { true }
fn default_cycles() -> usize { 30 }
fn default_threads() -> usize { 4 }

#[derive(Debug, Clone, Deserialize)]
pub struct ParamSpec {
    pub name: String,
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default = "default_dist")]
    pub dist: String,
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
    #[serde(default)]
    pub mean: Option<f64>,
    #[serde(default)]
    pub sd: Option<f64>,
    #[serde(default)]
    pub also: Vec<String>,
}
fn default_mode() -> String { "absolute".into() }
fn default_dist() -> String { "uniform".into() }

impl EnsembleSpec {
    pub fn rpms(&self) -> Vec<f64> {
        let mut v = self.rpm.clone();
        for r in &self.rpm_ranges {
            let (lo, hi, st) = (r[0], r[1], r[2]);
            if st <= 0.0 { continue; }
            let mut x = lo;
            while x <= hi + 1e-9 { v.push(x); x += st; }
        }
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
        v
    }
}

/// Inverse standard-normal CDF (Acklam's rational approximation, |err| < 1.2e-9).
pub fn inv_norm(p: f64) -> f64 {
    let p = p.clamp(1e-12, 1.0 - 1e-12);
    const A: [f64; 6] = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
        1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    const B: [f64; 5] = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
        6.680131188771972e+01, -1.328068155288572e+01];
    const C: [f64; 6] = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
        -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    const D: [f64; 4] = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
        3.754408661907416e+00];
    let pl = 0.02425;
    if p < pl {
        let q = (-2.0 * p.ln()).sqrt();
        (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5])
            / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1.0)
    } else if p <= 1.0 - pl {
        let q = p - 0.5;
        let r = q * q;
        (((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q
            / (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1.0)
    } else {
        let q = (-2.0 * (1.0 - p).ln()).sqrt();
        -(((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5])
            / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1.0)
    }
}

impl ParamSpec {
    /// Map a unit-interval draw to the prior's value (in the param's own
    /// units: absolute value, delta, or scale factor).
    pub fn value(&self, u: f64) -> Result<f64> {
        match self.dist.as_str() {
            "uniform" => {
                let (lo, hi) = self.bounds()?;
                Ok(lo + u * (hi - lo))
            }
            "loguniform" => {
                let (lo, hi) = self.bounds()?;
                if !(lo > 0.0 && hi > 0.0) { bail!("{}: loguniform needs positive min/max", self.name); }
                Ok((lo.ln() + u * (hi.ln() - lo.ln())).exp())
            }
            "normal" => {
                let mean = self.mean.unwrap_or(match self.mode.as_str() { "scale" => 1.0, "delta" => 0.0, _ => 0.0 });
                let sd = self.sd.ok_or_else(|| anyhow::anyhow!("{}: normal needs sd", self.name))?;
                let mut v = mean + sd * inv_norm(u);
                if let Some(lo) = self.min { v = v.max(lo); }
                if let Some(hi) = self.max { v = v.min(hi); }
                Ok(v)
            }
            other => bail!("{}: unknown dist {other:?} (uniform|loguniform|normal)", self.name),
        }
    }
    fn bounds(&self) -> Result<(f64, f64)> {
        match (self.min, self.max) {
            (Some(a), Some(b)) if b >= a => Ok((a, b)),
            _ => bail!("{}: {} needs min <= max", self.name, self.dist),
        }
    }
    /// The value the prior means when it sits at its "no perturbation" point.
    pub fn nominal(&self) -> Option<f64> {
        match self.mode.as_str() {
            "delta" => Some(0.0),
            "scale" => Some(1.0),
            _ => None,
        }
    }
}

/// Base value of an override path in `cfg`, from the cfd-core schema.
pub fn base_value(cfg: &SDM26Config, path: &str) -> Result<f64> {
    enumerate_schema(cfg).into_iter().find(|m| m.path == path).map(|m| m.default)
        .ok_or_else(|| anyhow::anyhow!("no schema default for {path:?}; use mode = \"absolute\""))
}

/// Apply one sampled prior value to `cfg`: returns (path, applied value) pairs.
pub fn apply_param(cfg: &mut SDM26Config, base: &SDM26Config, p: &ParamSpec, v: f64) -> Result<Vec<(String, f64)>> {
    let mut out = Vec::new();
    for path in std::iter::once(&p.name).chain(p.also.iter()) {
        let applied = match p.mode.as_str() {
            "absolute" => v,
            "delta" => base_value(base, path)? + v,
            "scale" => base_value(base, path)? * v,
            other => bail!("{}: unknown mode {other:?} (absolute|delta|scale)", p.name),
        };
        apply_override(cfg, path, applied).with_context(|| format!("apply_override {path}={applied}"))?;
        out.push((path.clone(), applied));
    }
    Ok(out)
}

/// Sampled prior values, one row per sample (sample 0 = nominal when
/// `include_nominal` and every prior has a nominal point).
pub fn draw(spec: &EnsembleSpec, params: &[ParamSpec]) -> Result<Vec<Vec<f64>>> {
    let kind = match spec.sampler.to_ascii_lowercase().as_str() {
        "lhs" => SamplerKind::Lhs,
        "random" => SamplerKind::Random,
        other => bail!("unknown sampler {other:?} (lhs|random)"),
    };
    let mut rows = Vec::with_capacity(spec.n_samples + 1);
    if spec.include_nominal {
        let nom: Option<Vec<f64>> = params.iter().map(|p| p.nominal()).collect();
        match nom {
            Some(n) => rows.push(n),
            None => bail!("include_nominal needs every prior in delta or scale mode"),
        }
    }
    for u in sample(kind, spec.n_samples, params.len(), Some(spec.seed)) {
        rows.push(params.iter().zip(u.iter()).map(|(p, &x)| p.value(x)).collect::<Result<Vec<_>>>()?);
    }
    Ok(rows)
}

/// Mean plenum static pressure over the observed steps.
struct PlenumObs { p_sum: f64, t_sum: f64 }
impl CycleObserver for PlenumObs {
    fn on_step(&mut self, _th: f64, dt: f64, e: &SDM26Engine) {
        let p = &e.pipes[e.plenum_idx];
        let mut pp = 0.0;
        for k in 0..p.n_cells {
            let i = k + p.n_ghost;
            let a = p.area[i];
            let rho = p.q[i * N_VARS] / a;
            let u = p.q[i * N_VARS + 1] / (rho * a);
            let en = p.q[i * N_VARS + 2] / a;
            pp += (p.gamma - 1.0) * (en - 0.5 * rho * u * u);
        }
        self.p_sum += pp / p.n_cells as f64 * dt;
        self.t_sum += dt;
    }
}

/// One engine point: `cycles` cycles, observer on the last 3 (the 0033
/// `huntexp` driver convention, so results line up with findings 0033-0037).
pub fn run_point(cfg: &SDM26Config, rpm: f64, cycles: usize) -> Result<serde_json::Value> {
    let mut eng = SDM26Engine::new(cfg.clone(), JunctionKind::Characteristic);
    let mut st = CycleLoopState::new(&mut eng);
    let target = cycles as f64 * 720.0;
    let mut ob = PlenumObs { p_sum: 0.0, t_sum: 0.0 };
    let mut last = None;
    let mut k = 0usize;
    while st.theta < target {
        let r = if k + 3 >= cycles {
            eng.advance_one_cycle(rpm, &mut st, Some(target), Some(&mut ob), None)
        } else {
            eng.advance_one_cycle(rpm, &mut st, Some(target), None, None)
        };
        match r { CycleOutcome::Cycle(s) => { last = Some(s); k += 1; } _ => break }
    }
    let s = last.ok_or_else(|| anyhow::anyhow!("rpm {rpm}: no cycle completed"))?;
    Ok(json!({
        "ve_del": s.ve_atm, "imep_bar": s.imep_bar, "bt_Nm": s.brake_torque_nm,
        "brake_kW": s.brake_power_k_w, "fmep_bar": s.fmep_bar,
        "p_plenum_Pa": if ob.t_sum > 0.0 { ob.p_sum / ob.t_sum } else { f64::NAN },
        "egt_K": s.egt_mean, "cycles_run": k,
    }))
}

fn study_hash(txt: &str, cfg_txt: &str) -> String {
    let mut h = Sha256::new();
    h.update(txt.as_bytes());
    h.update(cfg_txt.as_bytes());
    format!("{:x}", h.finalize())[..16].to_string()
}

pub fn execute(args: Args) -> Result<()> {
    let txt = std::fs::read_to_string(&args.study).with_context(|| format!("read {}", args.study.display()))?;
    let file: EnsembleFile = toml::from_str(&txt).context("parse ensemble TOML")?;
    let spec = file.ensemble.clone();
    let params = file.param.clone();
    if params.is_empty() { bail!("no [[param]] priors"); }
    let cfg_path = resolve(&args.study, &spec.config);
    let cfg_txt = std::fs::read_to_string(&cfg_path).with_context(|| format!("read {}", cfg_path.display()))?;
    let (base, warns) = load_v1_json_with_warnings(cfg_path.to_str().unwrap())
        .with_context(|| format!("load {}", cfg_path.display()))?;
    for w in &warns { eprintln!("warning: {w}"); }
    let hash = study_hash(&txt, &cfg_txt);
    let rows = draw(&spec, &params)?;
    let n_rows = args.max_samples.map(|m| m.min(rows.len())).unwrap_or(rows.len());

    // Resolve every sample's config up front (fails fast on a bad path).
    let mut cfgs = Vec::with_capacity(n_rows);
    let mut applied_all = Vec::with_capacity(n_rows);
    for row in rows.iter().take(n_rows) {
        let mut cfg = base.clone();
        let mut applied = serde_json::Map::new();
        for (p, &v) in params.iter().zip(row.iter()) {
            for (path, a) in apply_param(&mut cfg, &base, p, v)? { applied.insert(path, json!(a)); }
        }
        cfgs.push(cfg);
        applied_all.push(applied);
    }
    if args.dry_run {
        println!("sample,{}", params.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(","));
        for (i, r) in rows.iter().take(n_rows).enumerate() {
            println!("{i},{}", r.iter().map(|v| format!("{v:.6}")).collect::<Vec<_>>().join(","));
        }
        return Ok(());
    }

    // Resume: skip points already present for this study hash.
    let mut done: HashSet<(usize, i64)> = HashSet::new();
    if args.out.exists() {
        let f = std::fs::File::open(&args.out)?;
        for line in std::io::BufReader::new(f).lines() {
            let line = line?;
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                if v["kind"] == "point" && v["study_hash"] == hash.as_str() {
                    if let (Some(s), Some(r)) = (v["sample"].as_u64(), v["rpm"].as_f64()) {
                        done.insert((s as usize, r.round() as i64));
                    }
                }
            }
        }
    }
    let rpms = spec.rpms();
    let jobs: Vec<(usize, f64)> = (0..n_rows)
        .flat_map(|s| rpms.iter().map(move |&r| (s, r)))
        .filter(|(s, r)| !done.contains(&(*s, r.round() as i64)))
        .collect();
    let out = std::fs::OpenOptions::new().create(true).append(true).open(&args.out)
        .with_context(|| format!("open {}", args.out.display()))?;
    let out = Mutex::new(std::io::BufWriter::new(out));
    {
        let mut w = out.lock().unwrap();
        writeln!(w, "{}", json!({
            "kind": "header", "study_hash": hash, "study": args.study.display().to_string(),
            "config": cfg_path.display().to_string(), "n_rows": n_rows, "rpms": rpms,
            "cycles": spec.cycles, "params": params.iter().map(|p| json!({
                "name": p.name, "mode": p.mode, "dist": p.dist, "min": p.min, "max": p.max,
                "mean": p.mean, "sd": p.sd, "also": p.also})).collect::<Vec<_>>(),
            "samples": rows.iter().take(n_rows).collect::<Vec<_>>(),
            "skipped_done": done.len(), "todo": jobs.len(),
        }))?;
        w.flush()?;
    }
    let threads = args.threads.unwrap_or(spec.threads).max(1);
    let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).build()?;
    let n_jobs = jobs.len();
    let counter = std::sync::atomic::AtomicUsize::new(0);
    eprintln!("ensemble: {n_rows} samples x {} rpm = {} points, {} already done, {threads} threads",
              rpms.len(), n_rows * rpms.len(), done.len());
    pool.install(|| {
        jobs.par_iter().try_for_each(|&(s, rpm)| -> Result<()> {
            let res = run_point(&cfgs[s], rpm, spec.cycles);
            let line = match res {
                Ok(r) => json!({"kind": "point", "study_hash": hash, "sample": s, "rpm": rpm,
                                "prior": params.iter().zip(rows[s].iter()).map(|(p, v)| (p.name.clone(), json!(v))).collect::<serde_json::Map<_, _>>(),
                                "applied": applied_all[s], "out": r}),
                Err(e) => json!({"kind": "error", "study_hash": hash, "sample": s, "rpm": rpm, "error": e.to_string()}),
            };
            let mut w = out.lock().unwrap();
            writeln!(w, "{line}")?;
            w.flush()?;
            let c = counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
            if c % 25 == 0 || c == n_jobs { eprintln!("ensemble: {c}/{n_jobs}"); }
            Ok(())
        })
    })?;
    Ok(())
}

fn resolve(study: &Path, p: &str) -> PathBuf {
    let pb = PathBuf::from(p);
    if pb.is_absolute() { pb } else { study.parent().unwrap_or(Path::new(".")).join(pb) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> SDM26Config {
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../apps/desktop/src-tauri/resources/cfd/configs/sdm26_asbuilt_cal.json");
        load_v1_json_with_warnings(p).unwrap().0
    }
    fn spec(n: usize) -> EnsembleSpec {
        EnsembleSpec { config: String::new(), n_samples: n, seed: 7, sampler: "lhs".into(), include_nominal: true,
                       rpm: vec![], rpm_ranges: vec![[4000.0, 5000.0, 500.0], [9000.0, 9000.0, 1.0]], cycles: 3, threads: 1 }
    }
    fn p(name: &str, mode: &str, dist: &str, min: f64, max: f64) -> ParamSpec {
        ParamSpec { name: name.into(), mode: mode.into(), dist: dist.into(), min: Some(min), max: Some(max),
                    mean: None, sd: None, also: vec![] }
    }

    #[test]
    fn inv_norm_matches_known_quantiles() {
        for (pr, z) in [(0.5, 0.0), (0.975, 1.959964), (0.025, -1.959964), (0.8413447, 1.0), (0.001, -3.090232)] {
            assert!((inv_norm(pr) - z).abs() < 1e-5, "p {pr}: {} vs {z}", inv_norm(pr));
        }
    }

    #[test]
    fn rpm_ranges_expand_and_dedup() {
        assert_eq!(spec(1).rpms(), vec![4000.0, 4500.0, 5000.0, 9000.0]);
    }

    #[test]
    fn lhs_draw_is_stratified_nominal_first_and_seeded() {
        let ps = vec![p("exhaust_valve_open_angle", "delta", "uniform", -8.0, 8.0),
                      p("exhaust_cd_multiplier", "absolute", "loguniform", 0.85, 1.2)];
        let mut ps2 = ps.clone();
        ps2[1].mode = "scale".into();
        let rows = draw(&spec(16), &ps2).unwrap();
        assert_eq!(rows.len(), 17);
        assert_eq!(rows[0], vec![0.0, 1.0]);
        // one draw per 1/16 stratum in each column
        let mut strata: Vec<usize> = rows[1..].iter().map(|r| (((r[0] + 8.0) / 16.0) * 16.0).floor() as usize).collect();
        strata.sort();
        assert_eq!(strata, (0..16).collect::<Vec<_>>());
        assert!(rows[1..].iter().all(|r| r[1] >= 0.85 && r[1] <= 1.2));
        assert_eq!(draw(&spec(16), &ps2).unwrap(), rows, "same seed, same draw");
        // absolute-mode priors have no nominal point
        assert!(draw(&spec(4), &ps).is_err());
    }

    #[test]
    fn normal_prior_clips_and_centres() {
        let mut q = p("exhaust_cd_multiplier", "scale", "normal", 0.9, 1.1);
        q.sd = Some(0.05);
        assert!((q.value(0.5).unwrap() - 1.0).abs() < 1e-12);
        assert_eq!(q.value(1e-9).unwrap(), 0.9);
        assert_eq!(q.value(1.0 - 1e-9).unwrap(), 1.1);
    }

    #[test]
    fn apply_modes_and_linked_paths() {
        let b = base();
        let mut c = b.clone();
        let mut w = p("primary_wall_t", "delta", "uniform", -150.0, 150.0);
        w.also = vec!["secondary_wall_t".into(), "collector_wall_t".into()];
        let a = apply_param(&mut c, &b, &w, -100.0).unwrap();
        assert_eq!(a.len(), 3);
        assert_eq!(c.primary_wall_t, b.primary_wall_t - 100.0);
        assert_eq!(c.secondary_wall_t, b.secondary_wall_t - 100.0);
        assert_eq!(c.collector_wall_t, b.collector_wall_t - 100.0);
        let s = p("exhaust_valve_max_lift", "scale", "uniform", 0.9, 1.1);
        apply_param(&mut c, &b, &s, 1.1).unwrap();
        assert!((c.exhaust_valve_max_lift - b.exhaust_valve_max_lift * 1.1).abs() < 1e-15);
        let ab = p("p_ambient", "absolute", "uniform", 96800.0, 97800.0);
        apply_param(&mut c, &b, &ab, 97000.0).unwrap();
        assert_eq!(c.p_ambient, 97000.0);
        assert!(apply_param(&mut c, &b, &p("no_such_path", "absolute", "uniform", 0.0, 1.0), 0.5).is_err());
    }

    #[test]
    fn uq_overrides_reach_the_engine() {
        // Finding 0038 hooks: Cd multipliers scale the valve tables, port
        // deltas change only the port segment of the runner / primary.
        let b = base();
        let e0 = SDM26Engine::new(b.clone(), JunctionKind::Characteristic);
        let mut c = b.clone();
        for (k, v) in [("intake_cd_multiplier", 1.1), ("exhaust_cd_multiplier", 0.9),
                       ("intake_port_length_delta", 0.02), ("exhaust_port_length_delta", -0.015)] {
            apply_override(&mut c, k, v).unwrap();
        }
        let e1 = SDM26Engine::new(c, JunctionKind::Characteristic);
        let (iv0, iv1) = (&e0.cylinders[0].intake_valve.cd_table, &e1.cylinders[0].intake_valve.cd_table);
        assert!(iv0.iter().zip(iv1.iter()).all(|(a, b)| (b - a * 1.1).abs() < 1e-12));
        let (ev0, ev1) = (&e0.cylinders[0].exhaust_valve.cd_table, &e1.cylinders[0].exhaust_valve.cd_table);
        assert!(ev0.iter().zip(ev1.iter()).all(|(a, b)| (b - a * 0.9).abs() < 1e-12));
        let len = |e: &SDM26Engine, i: usize| e.pipes[i].dx * e.pipes[i].n_cells as f64;
        assert!((len(&e1, e1.runner_idx[0]) - len(&e0, e0.runner_idx[0]) - 0.02).abs() < 1e-9);
        assert!((len(&e1, e1.primary_idx[0]) - len(&e0, e0.primary_idx[0]) + 0.015).abs() < 1e-9);
        // runner mouth (plenum end) diameter unchanged; primary port start unchanged
        let r0 = &e0.pipes[e0.runner_idx[0]];
        let r1 = &e1.pipes[e1.runner_idx[0]];
        assert!((r0.area[r0.n_ghost] - r1.area[r1.n_ghost]).abs() < 1e-12);
    }

    #[test]
    fn zero_perturbation_is_parity() {
        let b = base();
        let mut c = b.clone();
        for (k, v) in [("intake_cd_multiplier", 1.0), ("exhaust_cd_multiplier", 1.0),
                       ("intake_port_length_delta", 0.0), ("exhaust_port_length_delta", 0.0)] {
            apply_override(&mut c, k, v).unwrap();
        }
        let a = run_point(&b, 7000.0, 3).unwrap();
        let z = run_point(&c, 7000.0, 3).unwrap();
        assert_eq!(a, z);
    }
}
