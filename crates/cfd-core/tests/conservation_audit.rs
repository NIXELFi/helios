//! Conservation-law audit for the SDM26 1D engine solver.
//!
//! For each scenario (default + boundary configs + numerical knobs), runs
//! N cycles at a target RPM and reports:
//!   - per-cycle `nonconservation` (kg/cycle = mass_drift - net_port_flow)
//!   - whether magnitude is BOUNDED or DRIFTING across cycles
//!   - approximate indicated thermal efficiency vs Otto-cycle ceiling
//!
//! Outputs structured JSON sidecars at the workspace root named
//! `conservation_<scenario>.json` plus a combined `conservation_summary.json`.
//! These are then ingested by the reporting script / markdown report.
//!
//! Run with:
//!   cargo test --release -p cfd-core --test conservation_audit -- --ignored --nocapture
//!
//! NOTE: these tests are #[ignore]-gated so CI doesn't pay the cost.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use engine_sim::config::loader::load_v1_json;
use engine_sim::model::sdm26::{JunctionKind, RunResult, SDM26Config, SDM26Engine};
use engine_sim::solver::muscl::{LIMITER_MINMOD, LIMITER_SUPERBEE, LIMITER_VAN_LEER};

// --------- file helpers --------------------------------------------------

fn sdm26_config_path() -> PathBuf {
    let candidates = [
        "../../apps/desktop/src-tauri/resources/cfd/configs/sdm26.json",
        "../engine-sim/python_ref/configs/sdm26.json",
    ];
    for c in candidates {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(c);
        if p.exists() {
            return p;
        }
    }
    panic!("no sdm26.json");
}

fn workspace_root() -> PathBuf {
    // CARGO_MANIFEST_DIR for cfd-core = <repo>/crates/cfd-core
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf()
}

// --------- scenario record + serialization (manual JSON) -----------------

#[derive(Debug, Clone)]
struct ScenarioResult {
    name: String,
    rpm: f64,
    n_cycles: usize,
    cr: f64,
    limiter: i32,
    cfl: f64,
    nonconservation_per_cycle: Vec<f64>, // kg / cycle
    mass_drift_per_cycle: Vec<f64>,
    net_port_flow_per_cycle: Vec<f64>,
    imep_bar_last: f64,
    indicated_power_w_last: f64,
    intake_mass_g_last: f64,
    fuel_mass_kg_per_cycle_last: f64,
    eta_indicated: f64,
    eta_otto: f64,
    eta_ratio: f64,
    final_nonconservation: f64,
    final_mass_drift: f64,
    final_net_port_flow: f64,
    trend: String,
    walltime_s: f64,
    notes: String,
}

fn json_num(v: f64) -> String {
    if v.is_finite() {
        format!("{:.6e}", v)
    } else {
        "null".to_string()
    }
}

fn write_json(path: &Path, sr: &ScenarioResult) -> std::io::Result<()> {
    let mut f = fs::File::create(path)?;
    let nc: Vec<String> = sr.nonconservation_per_cycle.iter().map(|v| json_num(*v)).collect();
    let md: Vec<String> = sr.mass_drift_per_cycle.iter().map(|v| json_num(*v)).collect();
    let np: Vec<String> = sr.net_port_flow_per_cycle.iter().map(|v| json_num(*v)).collect();
    writeln!(f, "{{")?;
    writeln!(f, "  \"name\": \"{}\",", sr.name)?;
    writeln!(f, "  \"rpm\": {},", json_num(sr.rpm))?;
    writeln!(f, "  \"n_cycles\": {},", sr.n_cycles)?;
    writeln!(f, "  \"cr\": {},", json_num(sr.cr))?;
    writeln!(f, "  \"limiter\": {},", sr.limiter)?;
    writeln!(f, "  \"cfl\": {},", json_num(sr.cfl))?;
    writeln!(f, "  \"nonconservation_per_cycle_kg\": [{}],", nc.join(","))?;
    writeln!(f, "  \"mass_drift_per_cycle_kg\": [{}],", md.join(","))?;
    writeln!(f, "  \"net_port_flow_per_cycle_kg\": [{}],", np.join(","))?;
    writeln!(f, "  \"imep_bar_last\": {},", json_num(sr.imep_bar_last))?;
    writeln!(f, "  \"indicated_power_w_last\": {},", json_num(sr.indicated_power_w_last))?;
    writeln!(f, "  \"intake_mass_g_last\": {},", json_num(sr.intake_mass_g_last))?;
    writeln!(f, "  \"fuel_mass_kg_per_cycle_last\": {},", json_num(sr.fuel_mass_kg_per_cycle_last))?;
    writeln!(f, "  \"eta_indicated\": {},", json_num(sr.eta_indicated))?;
    writeln!(f, "  \"eta_otto\": {},", json_num(sr.eta_otto))?;
    writeln!(f, "  \"eta_ratio\": {},", json_num(sr.eta_ratio))?;
    writeln!(f, "  \"final_nonconservation\": {},", json_num(sr.final_nonconservation))?;
    writeln!(f, "  \"final_mass_drift\": {},", json_num(sr.final_mass_drift))?;
    writeln!(f, "  \"final_net_port_flow\": {},", json_num(sr.final_net_port_flow))?;
    writeln!(f, "  \"trend\": \"{}\",", sr.trend)?;
    writeln!(f, "  \"walltime_s\": {},", json_num(sr.walltime_s))?;
    writeln!(f, "  \"notes\": \"{}\"", sr.notes)?;
    writeln!(f, "}}")?;
    Ok(())
}

// shared collection so a final "summary" test (run last alphabetically) can
// aggregate. We do not rely on this for primary output — each scenario writes
// its own file. But we also append into the summary via a JSON line file.
fn append_summary_line(sr: &ScenarioResult) {
    let path = workspace_root().join("conservation_results.ndjson");
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .expect("open ndjson");
    let nc: Vec<String> = sr.nonconservation_per_cycle.iter().map(|v| json_num(*v)).collect();
    let one_line = format!(
        "{{\"name\":\"{}\",\"rpm\":{},\"n_cycles\":{},\"cr\":{},\"limiter\":{},\"cfl\":{},\
         \"final_nonconservation\":{},\"final_mass_drift\":{},\"final_net_port_flow\":{},\
         \"eta_indicated\":{},\"eta_otto\":{},\"eta_ratio\":{},\"trend\":\"{}\",\
         \"imep_bar_last\":{},\"nc\":[{}],\"notes\":\"{}\"}}\n",
        sr.name, json_num(sr.rpm), sr.n_cycles, json_num(sr.cr), sr.limiter, json_num(sr.cfl),
        json_num(sr.final_nonconservation), json_num(sr.final_mass_drift),
        json_num(sr.final_net_port_flow),
        json_num(sr.eta_indicated), json_num(sr.eta_otto), json_num(sr.eta_ratio),
        sr.trend, json_num(sr.imep_bar_last), nc.join(","), sr.notes,
    );
    f.write_all(one_line.as_bytes()).expect("write ndjson");
}

// --------- core scenario runner ------------------------------------------

/// Classify a sequence of |nonconservation| values as BOUNDED or DRIFTING.
///
/// Rule of thumb: compare mean of last-third to mean of first-third. If the
/// last-third mean exceeds 2× the first-third mean AND the absolute increase
/// exceeds 1e-7 kg, we call it DRIFTING; else BOUNDED.
fn classify_trend(nc: &[f64]) -> String {
    if nc.len() < 6 {
        return "TOO_FEW_CYCLES".to_string();
    }
    let abs_nc: Vec<f64> = nc.iter().map(|v| v.abs()).collect();
    let n = abs_nc.len();
    let third = (n / 3).max(1);
    let first: f64 = abs_nc[..third].iter().sum::<f64>() / (third as f64);
    let last: f64 = abs_nc[n - third..].iter().sum::<f64>() / (third as f64);
    let growing = last > 2.0 * first && (last - first) > 1e-7;
    if growing {
        format!("DRIFTING (first1/3 mean={:.3e}, last1/3 mean={:.3e})", first, last)
    } else {
        format!("BOUNDED (first1/3 mean={:.3e}, last1/3 mean={:.3e})", first, last)
    }
}

fn eta_otto(cr: f64, gamma: f64) -> f64 {
    if cr <= 1.0 {
        0.0
    } else {
        1.0 - cr.powf(-(gamma - 1.0))
    }
}

fn run_scenario(name: &str, cfg: SDM26Config, rpm: f64, n_cycles: usize, notes: &str) -> ScenarioResult {
    let cr = cfg.cr;
    let limiter = cfg.limiter;
    let cfl = cfg.cfl;
    let q_lhv = cfg.q_lhv;
    let afr_target = cfg.afr_target;

    let t0 = Instant::now();
    let mut eng = SDM26Engine::new(cfg, JunctionKind::Stagnation);
    let r: RunResult = eng.run_single_rpm(rpm, n_cycles, false, 0.0, 0, false);
    let walltime_s = t0.elapsed().as_secs_f64();

    let nc: Vec<f64> = r.cycle_stats.iter().map(|s| s.nonconservation).collect();
    let md: Vec<f64> = r.cycle_stats.iter().map(|s| s.mass_drift).collect();
    let np: Vec<f64> = r.cycle_stats.iter().map(|s| s.net_port_flow).collect();

    // last-cycle thermo
    let (imep, ind_power_w, intake_g) = if let Some(last) = r.cycle_stats.last() {
        (last.imep_bar, last.indicated_power_k_w * 1000.0, last.intake_mass_per_cycle_g)
    } else {
        (f64::NAN, f64::NAN, f64::NAN)
    };
    // m_fuel per cycle = m_intake_total / (1 + afr)
    let intake_kg = intake_g / 1000.0;
    let m_fuel_per_cycle = if intake_kg.is_finite() && afr_target > 0.0 {
        intake_kg / (1.0 + afr_target)
    } else {
        f64::NAN
    };
    // η = P / (m_fuel · qLHV · rpm/120) ; 4-stroke -> 1 power-stroke per 2 rev → cycles/sec = rpm/120
    let q_in_rate_w = m_fuel_per_cycle * q_lhv * (rpm / 120.0);
    let eta_ind = if q_in_rate_w > 0.0 { ind_power_w / q_in_rate_w } else { f64::NAN };
    let e_otto = eta_otto(cr, 1.4);
    let eta_ratio = if e_otto > 0.0 { eta_ind / e_otto } else { f64::NAN };

    let final_nc = nc.last().copied().unwrap_or(f64::NAN);
    let final_md = md.last().copied().unwrap_or(f64::NAN);
    let final_np = np.last().copied().unwrap_or(f64::NAN);

    let trend = classify_trend(&nc);

    let sr = ScenarioResult {
        name: name.to_string(),
        rpm,
        n_cycles: r.cycle_stats.len(),
        cr,
        limiter,
        cfl,
        nonconservation_per_cycle: nc,
        mass_drift_per_cycle: md,
        net_port_flow_per_cycle: np,
        imep_bar_last: imep,
        indicated_power_w_last: ind_power_w,
        intake_mass_g_last: intake_g,
        fuel_mass_kg_per_cycle_last: m_fuel_per_cycle,
        eta_indicated: eta_ind,
        eta_otto: e_otto,
        eta_ratio,
        final_nonconservation: final_nc,
        final_mass_drift: final_md,
        final_net_port_flow: final_np,
        trend: trend.clone(),
        walltime_s,
        notes: notes.replace('"', "'"),
    };

    let out_path = workspace_root().join(format!("conservation_{}.json", name));
    let _ = write_json(&out_path, &sr);
    append_summary_line(&sr);

    println!("\n[{}] rpm={:.0} cr={:.2} cfl={:.2} lim={} n={}cycles walltime={:.1}s",
             name, rpm, cr, cfl, limiter, sr.n_cycles, walltime_s);
    println!("  final_nonconservation = {:+.3e} kg/cycle", final_nc);
    println!("  final_mass_drift      = {:+.3e} kg/cycle", final_md);
    println!("  final_net_port_flow   = {:+.3e} kg/cycle", final_np);
    println!("  imep                  = {:.2} bar    indicated_power = {:.2} kW",
             imep, ind_power_w / 1e3);
    println!("  intake_per_cycle      = {:.3} g    fuel_per_cycle = {:.3e} kg",
             intake_g, m_fuel_per_cycle);
    println!("  eta_indicated         = {:.3}    eta_otto = {:.3}    ratio = {:.3}",
             eta_ind, e_otto, eta_ratio);
    println!("  trend                 = {}", trend);
    sr
}

// once-per-process: wipe the ndjson append-log so re-runs start fresh.
static INIT: Mutex<bool> = Mutex::new(false);
fn ensure_clean_log() {
    let mut g = INIT.lock().unwrap();
    if !*g {
        let p = workspace_root().join("conservation_results.ndjson");
        let _ = fs::remove_file(&p);
        *g = true;
    }
}

fn base_cfg() -> SDM26Config {
    let mut cfg = load_v1_json(sdm26_config_path()).expect("load sdm26.json");
    cfg.enable_residual_tracking = false;
    cfg
}

// --------- scenario tests ------------------------------------------------

const N_CYCLES_SHORT: usize = 10;
const N_CYCLES_LONG: usize = 20;
const RPM_DEFAULT: f64 = 8000.0;

#[test]
#[ignore]
fn audit_01_default_baseline() {
    ensure_clean_log();
    let cfg = base_cfg();
    run_scenario("01_default_baseline", cfg, RPM_DEFAULT, N_CYCLES_LONG,
                 "Default config; baseline conservation reference.");
}

#[test]
#[ignore]
fn audit_02_high_cr_16() {
    ensure_clean_log();
    let mut cfg = base_cfg();
    cfg.cr = 16.0;
    run_scenario("02_high_cr_16", cfg, RPM_DEFAULT, N_CYCLES_SHORT,
                 "High compression ratio CR=16.");
}

#[test]
#[ignore]
fn audit_03_low_cr_8() {
    ensure_clean_log();
    let mut cfg = base_cfg();
    cfg.cr = 8.0;
    run_scenario("03_low_cr_8", cfg, RPM_DEFAULT, N_CYCLES_SHORT,
                 "Low compression ratio CR=8.");
}

#[test]
#[ignore]
fn audit_04a_tight_cfl_03() {
    ensure_clean_log();
    let mut cfg = base_cfg();
    cfg.cfl = 0.3;
    run_scenario("04a_tight_cfl_0p3", cfg, RPM_DEFAULT, N_CYCLES_SHORT,
                 "Tight CFL=0.3 (small dt; expect tighter conservation but slower).");
}

#[test]
#[ignore]
fn audit_04b_loose_cfl_085() {
    ensure_clean_log();
    let mut cfg = base_cfg();
    cfg.cfl = 0.85;
    run_scenario("04b_loose_cfl_0p85", cfg, RPM_DEFAULT, N_CYCLES_SHORT,
                 "Loose CFL=0.85 (numerical stress).");
}

#[test]
#[ignore]
fn audit_05_tiny_runner_010() {
    ensure_clean_log();
    let mut cfg = base_cfg();
    cfg.runner_length = 0.10;
    cfg.runner_lengths = None;
    run_scenario("05_tiny_runner_0p10m", cfg, RPM_DEFAULT, N_CYCLES_SHORT,
                 "Short runner 0.10m (strong acoustic regime).");
}

#[test]
#[ignore]
fn audit_06_long_runner_050() {
    ensure_clean_log();
    let mut cfg = base_cfg();
    cfg.runner_length = 0.50;
    cfg.runner_lengths = None;
    run_scenario("06_long_runner_0p50m", cfg, RPM_DEFAULT, N_CYCLES_SHORT,
                 "Long runner 0.50m.");
}

#[test]
#[ignore]
fn audit_07_tiny_restrictor_15mm() {
    ensure_clean_log();
    let mut cfg = base_cfg();
    cfg.restrictor_throat_diameter = 0.015;
    run_scenario("07_tiny_restrictor_15mm", cfg, RPM_DEFAULT, N_CYCLES_SHORT,
                 "Tiny 15mm restrictor — choked hard.");
}

#[test]
#[ignore]
fn audit_08_no_restrictor_loss() {
    ensure_clean_log();
    let mut cfg = base_cfg();
    cfg.restrictor_cd = 0.99;
    cfg.restrictor_loss_coef = 0.0;
    run_scenario("08_no_restrictor_loss", cfg, RPM_DEFAULT, N_CYCLES_SHORT,
                 "Cd=0.99, loss=0 — best-case flow through restrictor.");
}

#[test]
#[ignore]
fn audit_09_high_rpm_13000() {
    ensure_clean_log();
    let cfg = base_cfg();
    run_scenario("09_high_rpm_13000", cfg, 13000.0, N_CYCLES_SHORT,
                 "High RPM 13000 — numerical stress test.");
}

#[test]
#[ignore]
fn audit_10_low_rpm_3000() {
    ensure_clean_log();
    let cfg = base_cfg();
    run_scenario("10_low_rpm_3000", cfg, 3000.0, N_CYCLES_SHORT,
                 "Low RPM 3000 — slower transients.");
}

#[test]
#[ignore]
fn audit_11a_cold_ambient_273() {
    ensure_clean_log();
    let mut cfg = base_cfg();
    cfg.t_ambient = 273.0;
    run_scenario("11a_cold_ambient_273k", cfg, RPM_DEFAULT, N_CYCLES_SHORT,
                 "Cold ambient 273K.");
}

#[test]
#[ignore]
fn audit_11b_hot_ambient_333() {
    ensure_clean_log();
    let mut cfg = base_cfg();
    cfg.t_ambient = 333.0;
    run_scenario("11b_hot_ambient_333k", cfg, RPM_DEFAULT, N_CYCLES_SHORT,
                 "Hot ambient 333K.");
}

#[test]
#[ignore]
fn audit_12a_limiter_minmod() {
    ensure_clean_log();
    let mut cfg = base_cfg();
    cfg.limiter = LIMITER_MINMOD;
    run_scenario("12a_limiter_minmod", cfg, RPM_DEFAULT, N_CYCLES_SHORT,
                 "Limiter = minmod (0).");
}

#[test]
#[ignore]
fn audit_12b_limiter_van_leer() {
    ensure_clean_log();
    let mut cfg = base_cfg();
    cfg.limiter = LIMITER_VAN_LEER;
    run_scenario("12b_limiter_van_leer", cfg, RPM_DEFAULT, N_CYCLES_SHORT,
                 "Limiter = van Leer (1).");
}

#[test]
#[ignore]
fn audit_12c_limiter_superbee() {
    ensure_clean_log();
    let mut cfg = base_cfg();
    cfg.limiter = LIMITER_SUPERBEE;
    run_scenario("12c_limiter_superbee", cfg, RPM_DEFAULT, N_CYCLES_SHORT,
                 "Limiter = superbee (2).");
}
