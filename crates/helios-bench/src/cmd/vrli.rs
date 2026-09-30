//! `helios-bench vrli` — variable runner length intake (VRLI) design study
//! (finding 0037).
//!
//! 1. Runs the engine on an (extension × rpm) grid, where "extension" is the
//!    telescoping-trumpet runner length change at the plenum mouth
//!    (`runner_mouth_extension`), optionally with the trumpets displacing
//!    plenum volume (`vrli_trumpet_od`). Points are independent and run in
//!    parallel; results are cached in an NDJSON file so a study can be
//!    resumed or re-analysed without re-running the engine.
//! 2. Builds the brake-torque / VE surfaces and, for every stroke in the
//!    study (the stroke is the design variable), finds the best placement
//!    of the telescoping range and scores it against the VRLI requirements
//!    (P1 average-torque gain, P2 no-dip ratio, F2 actuator speed, F3
//!    position resolution, C2 mass, packaging).
//! 3. Writes `surface.csv`, `designs.csv` (every placement), `strokes.csv`
//!    (best placement per stroke = the gain-vs-stroke Pareto set),
//!    `recommended.json` and `ecu_map.csv` (rpm → runner length / plate
//!    position) for the recommended design.
//!
//! ```toml
//! [vrli]
//! config = "../configs/sdm26_asbuilt_cal.json"   # relative to this file
//! cycles = 30
//! threads = 15
//! tune = "neutral"          # "neutral": drop afr_map / spark_advance_map; "config": keep them
//! trumpet_od_mm = 44.0      # 0 = no plenum displacement
//! displacement_ref_mm = 0.0 # extension at which the trumpet mouth is at the plenum floor
//! rpm = { min = 4000, max = 12500, step = 250 }
//! extension_mm = { min = -80, max = 200, step = 10 }
//! cache = "vrli_cache.ndjson"
//!
//! [design]
//! band_rpm = [6000, 12000]
//! driver_band_rpm = [7000, 10500]
//! baseline_extension_mm = 0.0
//! strokes_mm = [0, 25, 50, 75, 100, 125, 150, 175, 200]
//! placement_step_mm = 5.0
//! metric = "torque"         # or "ve"
//! ```

use crate::vrli::{best_placement, evaluate, recommend, DesignResult, DesignSpec, MassModel, Surface};
use anyhow::{bail, Context, Result};
use cfd_core::params::apply_override;
use clap::Args as ClapArgs;
use engine_sim::config::loader::load_v1_json_with_warnings;
use engine_sim::model::sdm26::{JunctionKind, SDM26Config, SDM26Engine};
use rayon::prelude::*;
use serde::Deserialize;
use serde_json::json;
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(ClapArgs)]
pub struct Args {
    /// Path to the VRLI study TOML
    pub study: PathBuf,
    /// Output directory
    #[arg(long)]
    pub out: PathBuf,
    /// Only analyse cached points; fail if any grid point is missing
    #[arg(long)]
    pub analyze_only: bool,
}

#[derive(Debug, Deserialize)]
struct StudyFile {
    vrli: VrliRun,
    #[serde(default)]
    design: DesignCfg,
}

#[derive(Debug, Deserialize, Clone, Copy)]
struct Range {
    min: f64,
    max: f64,
    step: f64,
}

impl Range {
    fn values(&self) -> Vec<f64> {
        let n = ((self.max - self.min) / self.step + 1e-9).floor() as usize;
        (0..=n).map(|i| self.min + i as f64 * self.step).collect()
    }
}

#[derive(Debug, Deserialize)]
struct VrliRun {
    config: String,
    #[serde(default = "d_cycles")]
    cycles: usize,
    #[serde(default = "d_threads")]
    threads: usize,
    #[serde(default)]
    junction: Option<String>,
    #[serde(default = "d_tune")]
    tune: String,
    #[serde(default)]
    trumpet_od_mm: f64,
    #[serde(default)]
    displacement_ref_mm: f64,
    rpm: Range,
    extension_mm: Range,
    #[serde(default)]
    cache: Option<String>,
    /// Extra `apply_override` values applied to the base config.
    #[serde(default)]
    overrides: BTreeMap<String, f64>,
}
fn d_cycles() -> usize { 30 }
fn d_threads() -> usize { 8 }
fn d_tune() -> String { "neutral".into() }

#[derive(Debug, Deserialize)]
#[serde(default)]
struct DesignCfg {
    band_rpm: [f64; 2],
    driver_band_rpm: [f64; 2],
    baseline_extension_mm: f64,
    strokes_mm: Vec<f64>,
    placement_step_mm: f64,
    position_step_mm: f64,
    f3_resolution_mm: f64,
    sweep_rate_rpm_s: f64,
    full_stroke_time_s: f64,
    metric: String,
    knee_fraction: f64,
    max_protrusion_mm: f64,
    mass: MassCfg,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(default)]
struct MassCfg {
    fixed_kg: f64,
    per_100mm_kg: f64,
    actuator_kg_at_100mm: f64,
    actuator_exponent: f64,
    limit_kg: f64,
}

impl Default for MassCfg {
    fn default() -> Self {
        let m = MassModel::default();
        Self {
            fixed_kg: m.fixed_kg,
            per_100mm_kg: m.per_100mm_kg,
            actuator_kg_at_100mm: m.actuator_kg_at_100mm,
            actuator_exponent: m.actuator_exponent,
            limit_kg: m.limit_kg,
        }
    }
}

impl Default for DesignCfg {
    fn default() -> Self {
        Self {
            band_rpm: [6000.0, 12000.0],
            driver_band_rpm: [7000.0, 10500.0],
            baseline_extension_mm: 0.0,
            strokes_mm: vec![0.0, 25.0, 50.0, 75.0, 100.0, 125.0, 150.0, 175.0, 200.0],
            placement_step_mm: 5.0,
            position_step_mm: 1.0,
            f3_resolution_mm: 2.0,
            sweep_rate_rpm_s: 6000.0,
            full_stroke_time_s: 0.5,
            metric: "torque".into(),
            knee_fraction: 0.9,
            max_protrusion_mm: f64::INFINITY,
            mass: MassCfg::default(),
        }
    }
}

/// One simulated grid point.
#[derive(Debug, Clone, Copy)]
struct Point {
    ve: f64,
    torque: f64,
    power: f64,
    imep: f64,
}

pub fn execute(args: Args) -> Result<()> {
    let txt = std::fs::read_to_string(&args.study).with_context(|| format!("read {}", args.study.display()))?;
    let st: StudyFile = toml::from_str(&txt).context("parse VRLI study TOML")?;
    let dir = args.study.parent().unwrap_or(Path::new("."));
    let cfg_path = dir.join(&st.vrli.config);
    let (mut base, warns) = load_v1_json_with_warnings(cfg_path.to_str().unwrap())
        .with_context(|| format!("load {}", cfg_path.display()))?;
    for w in &warns {
        eprintln!("warning: {}: {w}", cfg_path.display());
    }
    match st.vrli.tune.as_str() {
        "neutral" => {
            base.afr_map = None;
            base.spark_advance_map = None;
        }
        "config" => {}
        other => bail!("vrli.tune must be \"neutral\" or \"config\", got {other:?}"),
    }
    for (k, v) in &st.vrli.overrides {
        apply_override(&mut base, k, *v).with_context(|| format!("override {k}={v}"))?;
    }
    let junction = match st.vrli.junction.as_deref().map(|s| s.to_ascii_lowercase()).as_deref() {
        None | Some("characteristic") | Some("char") => JunctionKind::Characteristic,
        Some("stagnation") | Some("cv") => JunctionKind::Stagnation,
        Some(o) => bail!("unknown junction {o:?}"),
    };
    let exts = st.vrli.extension_mm.values();
    let rpms = st.vrli.rpm.values();
    std::fs::create_dir_all(&args.out)?;

    // ---- cache ------------------------------------------------------------
    let cache_path = match &st.vrli.cache {
        Some(c) => dir.join(c),
        None => args.out.join("vrli_cache.ndjson"),
    };
    let od = st.vrli.trumpet_od_mm;
    let dref = st.vrli.displacement_ref_mm;
    let tag = format!(
        "{}|{}|{}|{:?}|{:?}",
        st.vrli.config, st.vrli.tune, st.vrli.cycles,
        st.vrli.overrides.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>(),
        st.vrli.junction
    );
    // Displacement only acts beyond the reference, so points at or below it
    // share a key with the no-displacement surface.
    let key = |e: f64, r: f64| {
        let od_eff = if od > 0.0 && e > dref { od } else { 0.0 };
        let dref_eff = if od_eff > 0.0 { dref } else { 0.0 };
        format!("{tag}|e={e:.3}|rpm={r:.1}|od={od_eff:.3}|ref={dref_eff:.3}")
    };
    let mut cache: HashMap<String, Point> = HashMap::new();
    if let Ok(f) = std::fs::File::open(&cache_path) {
        for line in std::io::BufReader::new(f).lines().map_while(|l| l.ok()) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                if let (Some(k), Some(ve), Some(t), Some(p), Some(i)) = (
                    v["key"].as_str(), v["ve"].as_f64(), v["torque"].as_f64(), v["power"].as_f64(), v["imep"].as_f64(),
                ) {
                    cache.insert(k.to_string(), Point { ve, torque: t, power: p, imep: i });
                }
            }
        }
    }
    let todo: Vec<(f64, f64)> = exts
        .iter()
        .flat_map(|&e| rpms.iter().map(move |&r| (e, r)))
        .filter(|&(e, r)| !cache.contains_key(&key(e, r)))
        .collect();
    if !todo.is_empty() {
        if args.analyze_only {
            bail!("{} grid points are not in the cache {}", todo.len(), cache_path.display());
        }
        eprintln!("vrli: {} of {} points to run ({} threads)", todo.len(), exts.len() * rpms.len(), st.vrli.threads);
        let file = Mutex::new(
            std::fs::OpenOptions::new().create(true).append(true).open(&cache_path)
                .with_context(|| format!("open cache {}", cache_path.display()))?,
        );
        let done = Mutex::new(0usize);
        let pool = rayon::ThreadPoolBuilder::new().num_threads(st.vrli.threads.max(1)).build()?;
        let results: Vec<Result<(String, Point)>> = pool.install(|| {
            todo.par_iter()
                .map(|&(e, r)| {
                    let mut cfg: SDM26Config = base.clone();
                    cfg.runner_mouth_extension = e / 1000.0;
                    cfg.vrli_trumpet_od = od / 1000.0;
                    cfg.vrli_displacement_ref = dref / 1000.0;
                    let mut eng = SDM26Engine::new(cfg, junction);
                    let res = eng.run_single_rpm(r, st.vrli.cycles, false, 0.005, 3, false);
                    let s = res.cycle_stats.last().ok_or_else(|| anyhow::anyhow!("no cycle at ext {e} rpm {r}"))?;
                    let p = Point { ve: s.ve_atm, torque: s.brake_torque_nm, power: s.brake_power_k_w, imep: s.imep_bar };
                    let k = key(e, r);
                    let line = json!({"key": k, "ext_mm": e, "rpm": r, "ve": p.ve, "torque": p.torque,
                                      "power": p.power, "imep": p.imep});
                    writeln!(file.lock().unwrap(), "{line}")?;
                    let mut d = done.lock().unwrap();
                    *d += 1;
                    if *d % 25 == 0 || *d == todo.len() {
                        eprintln!("vrli: {}/{}", *d, todo.len());
                    }
                    Ok((k, p))
                })
                .collect()
        });
        for r in results {
            let (k, p) = r?;
            cache.insert(k, p);
        }
    }

    // ---- surfaces ---------------------------------------------------------
    let grid = |f: &dyn Fn(&Point) -> f64| -> Vec<Vec<f64>> {
        exts.iter().map(|&e| rpms.iter().map(|&r| f(&cache[&key(e, r)])).collect()).collect()
    };
    let torque = Surface { ext_mm: exts.clone(), rpm: rpms.clone(), val: grid(&|p| p.torque) };
    let ve = Surface { ext_mm: exts.clone(), rpm: rpms.clone(), val: grid(&|p| p.ve) };
    {
        let mut f = std::fs::File::create(args.out.join("surface.csv"))?;
        writeln!(f, "ext_mm,runner_mm,rpm,ve,brake_torque_Nm,brake_power_kW,imep_bar")?;
        let l0 = base.runner_length * 1000.0;
        for e in &exts {
            for r in &rpms {
                let p = cache[&key(*e, *r)];
                writeln!(f, "{e},{:.1},{r},{:.5},{:.4},{:.4},{:.4}", l0 + e, p.ve, p.torque, p.power, p.imep)?;
            }
        }
    }
    let d = &st.design;
    let surf = match d.metric.as_str() {
        "torque" => &torque,
        "ve" => &ve,
        o => bail!("design.metric must be \"torque\" or \"ve\", got {o:?}"),
    };
    let spec = DesignSpec {
        band: (d.band_rpm[0], d.band_rpm[1]),
        driver_band: (d.driver_band_rpm[0], d.driver_band_rpm[1]),
        baseline_ext_mm: d.baseline_extension_mm,
        position_step_mm: d.position_step_mm,
        f3_resolution_mm: d.f3_resolution_mm,
        sweep_rate_rpm_s: d.sweep_rate_rpm_s,
        full_stroke_time_s: d.full_stroke_time_s,
        mass: MassModel {
            fixed_kg: d.mass.fixed_kg,
            per_100mm_kg: d.mass.per_100mm_kg,
            actuator_kg_at_100mm: d.mass.actuator_kg_at_100mm,
            actuator_exponent: d.mass.actuator_exponent,
            limit_kg: d.mass.limit_kg,
        },
        max_protrusion_mm: d.max_protrusion_mm,
        displacement_ref_mm: dref,
    };
    let (e_lo, e_hi) = (exts[0], exts[exts.len() - 1]);
    let mut per_stroke: Vec<DesignResult> = Vec::new();
    let mut fd = std::fs::File::create(args.out.join("designs.csv"))?;
    writeln!(fd, "{}", CSV_HEADER)?;
    for &stroke in &d.strokes_mm {
        match best_placement(surf, &spec, stroke, e_lo, e_hi, d.placement_step_mm) {
            Some((best, all)) => {
                for r in &all {
                    writeln!(fd, "{}", csv_row(r))?;
                }
                per_stroke.push(best);
            }
            None => eprintln!("vrli: stroke {stroke} mm does not fit the extension grid; skipped"),
        }
    }
    let mut fs = std::fs::File::create(args.out.join("strokes.csv"))?;
    writeln!(fs, "{}", CSV_HEADER)?;
    for r in &per_stroke {
        writeln!(fs, "{}", csv_row(r))?;
    }
    let (best, knee) = recommend(&per_stroke, d.knee_fraction);
    let rec = knee.clone().or(best.clone());
    if let Some(r) = &rec {
        let (_, sched) = evaluate(surf, &spec, r.lmin_mm, r.stroke_mm);
        let l0 = base.runner_length * 1000.0;
        let mut f = std::fs::File::create(args.out.join("ecu_map.csv"))?;
        writeln!(f, "rpm,runner_length_mm,extension_mm,plate_position_mm,quasi_steady_extension_mm")?;
        for j in 0..sched.rpm.len() {
            let e = sched.quantised_mm[j];
            writeln!(f, "{},{:.1},{:.1},{:.1},{:.1}", sched.rpm[j], l0 + e, e, e - r.lmin_mm, sched.quasi_steady_mm[j])?;
        }
    }
    let summary = json!({
        "study": args.study.display().to_string(),
        "config": st.vrli.config,
        "tune": st.vrli.tune,
        "metric": d.metric,
        "base_runner_length_mm": base.runner_length * 1000.0,
        "trumpet_od_mm": od,
        "displacement_ref_mm": dref,
        "best_feasible": best,
        "recommended_knee": knee,
        "knee_fraction": d.knee_fraction,
        "per_stroke": per_stroke,
    });
    std::fs::write(args.out.join("recommended.json"), serde_json::to_string_pretty(&summary)?)?;

    println!("stroke  Lmin  Lmax   P1 gain  (rate-lim)  driver   P2     failsafe(gain)   req/avail mm/s  mass  ok");
    for r in &per_stroke {
        println!(
            "{:5.0} {:6.0} {:5.0}  {:+6.2}%  ({:+6.2}%)  {:+6.2}%  {:.3}  {:5.0} ({:+5.2}%)   {:5.0}/{:<5.0}  {:.2}  {}",
            r.stroke_mm, r.lmin_mm, r.lmax_mm, 100.0 * r.p1_gain, 100.0 * r.p1_gain_rate_limited,
            100.0 * r.driver_gain, r.p2_ratio, r.failsafe_mm, 100.0 * r.failsafe_gain,
            r.required_speed_mm_s, r.available_speed_mm_s, r.mass_kg,
            if r.feasible_mass && r.feasible_packaging { "yes" } else { "no" },
        );
    }
    if let Some(r) = &rec {
        println!("recommended: stroke {:.0} mm, extension {:.0}..{:.0} mm (runner {:.0}..{:.0} mm), P1 {:+.2}%",
            r.stroke_mm, r.lmin_mm, r.lmax_mm, base.runner_length * 1000.0 + r.lmin_mm,
            base.runner_length * 1000.0 + r.lmax_mm, 100.0 * r.p1_gain);
    }
    Ok(())
}

const CSV_HEADER: &str = "stroke_mm,lmin_mm,lmax_mm,p1_gain,p1_gain_rate_limited,p1_gain_quantised,driver_gain,\
p2_ratio,p2_rpm,failsafe_mm,failsafe_gain,required_speed_mm_s,available_speed_mm_s,max_map_jump_mm,mass_kg,\
protrusion_mm,feasible_mass,feasible_packaging";

fn csv_row(r: &DesignResult) -> String {
    format!(
        "{},{},{},{:.6},{:.6},{:.6},{:.6},{:.5},{},{},{:.6},{:.1},{:.1},{:.1},{:.3},{:.1},{},{}",
        r.stroke_mm, r.lmin_mm, r.lmax_mm, r.p1_gain, r.p1_gain_rate_limited, r.p1_gain_quantised, r.driver_gain,
        r.p2_ratio, r.p2_rpm, r.failsafe_mm, r.failsafe_gain, r.required_speed_mm_s, r.available_speed_mm_s,
        r.max_map_jump_mm, r.mass_kg, r.protrusion_mm, r.feasible_mass, r.feasible_packaging
    )
}
