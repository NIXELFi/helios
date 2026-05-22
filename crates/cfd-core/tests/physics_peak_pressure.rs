//! Capture in-cylinder peak pressure to diagnose why the sim hits a
//! ~60 kW unrestricted ceiling. Real CBR600 at peak power reaches
//! ~70-80 bar peak cylinder pressure; if the sim only reaches ~50 bar,
//! that's where the work is being lost.
//!
//! Run:
//!   cargo test --release -p cfd-core --test physics_peak_pressure -- --ignored --nocapture

use std::sync::atomic::AtomicBool;

use engine_sim::config::loader::load_v1_json;
use engine_sim::model::sdm26::{
    CycleLoopState, CycleObserver, CycleOutcome, JunctionKind, SDM26Engine, SDM26Config,
};

fn sdm26_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../engine-sim/python_ref/configs/sdm26.json")
}

fn unrestricted(cfg: &SDM26Config) -> SDM26Config {
    let mut c = cfg.clone();
    c.restrictor_throat_diameter = 0.050;
    c.restrictor_cd = 0.99;
    c.restrictor_loss_coef = 0.0;
    c
}

/// Observer that tracks per-cylinder peak pressure across the cycle.
struct PeakPressureObserver {
    pub max_p: Vec<f64>,
    pub max_t: Vec<f64>,
    pub max_p_theta: Vec<f64>,
}

impl PeakPressureObserver {
    fn new(n_cyl: usize) -> Self {
        Self {
            max_p: vec![0.0; n_cyl],
            max_t: vec![0.0; n_cyl],
            max_p_theta: vec![0.0; n_cyl],
        }
    }
}

impl CycleObserver for PeakPressureObserver {
    fn on_step(&mut self, theta_global_deg: f64, _dt: f64, eng: &SDM26Engine) {
        for (i, cyl) in eng.cylinders.iter().enumerate() {
            if cyl.state.p > self.max_p[i] {
                self.max_p[i] = cyl.state.p;
                self.max_p_theta[i] = theta_global_deg;
            }
            if cyl.state.t > self.max_t[i] {
                self.max_t[i] = cyl.state.t;
            }
        }
    }
}

fn run_with_peak(cfg: &SDM26Config, rpm: f64, n_cycles_warmup: u32) -> (f64, f64, f64, f64, f64) {
    // Returns: (brake_kW, imep_bar, peak_P_bar, peak_T_K, peak_P_theta_deg)
    let cancel = AtomicBool::new(false);
    let mut eng = SDM26Engine::new(cfg.clone(), JunctionKind::Stagnation);
    let mut state = CycleLoopState::new(&mut eng);
    let mut last_kw = 0.0; let mut last_imep = 0.0;
    // Warm up
    for _ in 0..n_cycles_warmup {
        match eng.advance_one_cycle(rpm, &mut state, None, None, Some(&cancel)) {
            CycleOutcome::Cycle(cs) => {
                last_kw = cs.brake_power_k_w;
                last_imep = cs.imep_bar;
            }
            _ => break,
        }
    }
    // Capture cycle
    let n_cyl = eng.cylinders.len();
    let mut obs = PeakPressureObserver::new(n_cyl);
    let obs_ref: &mut dyn CycleObserver = &mut obs;
    let _ = eng.advance_one_cycle(rpm, &mut state, None, Some(obs_ref), Some(&cancel));
    let peak_p = obs.max_p.iter().cloned().fold(0.0_f64, f64::max);
    let peak_t = obs.max_t.iter().cloned().fold(0.0_f64, f64::max);
    let i_peak = obs.max_p.iter().position(|&v| v == peak_p).unwrap_or(0);
    let theta_peak = obs.max_p_theta[i_peak];
    (last_kw, last_imep, peak_p / 1e5, peak_t, theta_peak)
}

#[test]
#[ignore]
fn peak_pressure_diagnosis() {
    let base = load_v1_json(sdm26_path()).unwrap();

    println!("\n=== In-cylinder peak pressure diagnosis ===\n");
    println!("Real CBR600 at peak power: peak P ~ 70-80 bar @ ~12-18° ATDC");
    println!();

    // Race calibration
    let mut race = unrestricted(&base);
    race.intake_lift_flat_top_ramp = 0.22;
    race.exhaust_lift_flat_top_ramp = 0.22;
    race.afr_eta_enabled = true;
    race.afr_target = 12.3;
    race.combustion_duration = 30.0;
    race.wiebe_m = 3.0;
    race.tumble_burn_factor = 0.4;
    race.spark_advance = 19.0;
    race.eta_comb = 0.98;
    race.cr = 13.0;
    race.fmep_a = 0.35; race.fmep_b = 0.045; race.fmep_c = 0.0005;
    race.woschni_c1_combustion *= 0.7;

    println!("Race calibration at varying RPM:");
    println!("{:>6}  {:>8}  {:>8}  {:>10}  {:>10}  {:>10}",
        "RPM", "Brake kW", "IMEP", "Peak P bar", "Peak T K", "Peak θ");

    for &rpm in &[8000.0_f64, 10000.0, 12000.0, 13500.0, 14000.0] {
        let (kw, imep, peakp, peakt, theta) = run_with_peak(&race, rpm, 6);
        let theta_atdc = (theta + 360.0).rem_euclid(720.0) - 360.0;
        println!("{:>6.0}  {:>8.2}  {:>8.2}  {:>10.2}  {:>10.0}  {:>9.1}°",
            rpm, kw, imep, peakp, peakt, theta_atdc);
    }
}

#[test]
#[ignore]
fn aggressive_heat_loss_reduction() {
    let base = load_v1_json(sdm26_path()).unwrap();
    let mut race = unrestricted(&base);
    race.intake_lift_flat_top_ramp = 0.22;
    race.exhaust_lift_flat_top_ramp = 0.22;
    race.afr_eta_enabled = true;
    race.afr_target = 12.3;
    race.combustion_duration = 30.0;
    race.wiebe_m = 3.0;
    race.spark_advance = 19.0;
    race.eta_comb = 0.98;
    race.cr = 13.0;
    race.fmep_a = 0.35; race.fmep_b = 0.045; race.fmep_c = 0.0005;

    println!("\n=== Aggressive heat-loss reduction sweep ===\n");
    println!("Test if dropping Woschni c1_combustion further closes the gap.\n");

    let scales = [1.0, 0.7, 0.5, 0.3, 0.2, 0.1];
    let baseline_c1 = base.woschni_c1_combustion;
    let rpm = 13500.0;
    println!("RPM = {:.0}", rpm);
    println!("  {:>8}  {:>8}  {:>10}  {:>10}", "scale", "IMEP", "Brake kW", "Peak P bar");

    for &s in &scales {
        let mut c = race.clone();
        c.woschni_c1_combustion = baseline_c1 * s;
        let (kw, imep, peakp, _, _) = run_with_peak(&c, rpm, 6);
        println!("  {:>8.2}  {:>8.2}  {:>10.2}  {:>10.2}", s, imep, kw, peakp);
    }
}

#[test]
#[ignore]
fn cr_aggressive_sweep() {
    let base = load_v1_json(sdm26_path()).unwrap();
    let mut race = unrestricted(&base);
    race.intake_lift_flat_top_ramp = 0.22;
    race.exhaust_lift_flat_top_ramp = 0.22;
    race.afr_eta_enabled = true;
    race.afr_target = 12.3;
    race.combustion_duration = 30.0;
    race.wiebe_m = 3.0;
    race.spark_advance = 19.0;
    race.eta_comb = 0.98;
    race.fmep_a = 0.35; race.fmep_b = 0.045; race.fmep_c = 0.0005;
    race.woschni_c1_combustion *= 0.5;

    println!("\n=== Compression ratio sweep (race calibration) ===\n");

    let crs = [12.2_f64, 13.0, 13.5, 14.0, 14.5, 15.0, 15.5, 16.0];
    let rpm = 13500.0;
    for cr in crs {
        let mut c = race.clone();
        c.cr = cr;
        let (kw, imep, peakp, peakt, _) = run_with_peak(&c, rpm, 6);
        println!("  CR={:.1}  IMEP={:.2}  Brake kW={:.2}  Peak P={:.1} bar  Peak T={:.0} K",
            cr, imep, kw, peakp, peakt);
    }
}
