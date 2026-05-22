//! Two-zone combustion model benchmark.
//!
//! Compares the legacy single-zone model against the new opt-in
//! two-zone model on the race-calibration CBR600 configuration used
//! by `physics_final_bench`. Two-zone tracks burned and unburned
//! zones separately during combustion and splits Woschni wall heat
//! loss by zone volume fraction (which is dominated by the hot
//! burned zone).
//!
//! Run:
//!   cargo test --release -p cfd-core --test physics_two_zone_check -- --ignored --nocapture

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

/// Match the "race calibration" used by physics_final_bench.
fn race_calibration(base: &SDM26Config) -> SDM26Config {
    let mut c = base.clone();
    c.intake_lift_flat_top_ramp = 0.22;
    c.exhaust_lift_flat_top_ramp = 0.22;
    c.afr_eta_enabled = true;
    c.afr_target = 12.3;
    c.combustion_duration = 30.0;
    c.wiebe_m = 3.0;
    c.tumble_burn_factor = 0.4;
    c.spark_advance = 19.0;
    c.eta_comb = 0.98;
    c.cr = 13.0;
    c.fmep_a = 0.35;
    c.fmep_b = 0.045;
    c.fmep_c = 0.0005;
    c.woschni_c1_combustion *= 0.7;
    c
}

/// Observer that captures per-cylinder peak P, peak bulk T, peak T_b,
/// peak T_u, and total heat-loss surrogate (sum of (T - T_wall) × dt
/// during combustion as a proxy for cumulative heat-loss exposure).
struct ZoneObserver {
    pub max_p: Vec<f64>,
    pub max_t: Vec<f64>,
    pub max_t_b: Vec<f64>,
    pub min_t_u_combust: Vec<f64>, // min T_u during combustion (proxy: unburned compression T)
    pub max_t_u: Vec<f64>,
}

impl ZoneObserver {
    fn new(n_cyl: usize) -> Self {
        Self {
            max_p: vec![0.0; n_cyl],
            max_t: vec![0.0; n_cyl],
            max_t_b: vec![0.0; n_cyl],
            min_t_u_combust: vec![f64::INFINITY; n_cyl],
            max_t_u: vec![0.0; n_cyl],
        }
    }
}

impl CycleObserver for ZoneObserver {
    fn on_step(&mut self, _theta_global_deg: f64, _dt: f64, eng: &SDM26Engine) {
        for (i, cyl) in eng.cylinders.iter().enumerate() {
            if cyl.state.p > self.max_p[i] {
                self.max_p[i] = cyl.state.p;
            }
            if cyl.state.t > self.max_t[i] {
                self.max_t[i] = cyl.state.t;
            }
            if cyl.state.two_zone_active {
                if cyl.state.t_b > self.max_t_b[i] {
                    self.max_t_b[i] = cyl.state.t_b;
                }
                if cyl.state.t_u < self.min_t_u_combust[i] && cyl.state.t_u > 0.0 {
                    self.min_t_u_combust[i] = cyl.state.t_u;
                }
                if cyl.state.t_u > self.max_t_u[i] {
                    self.max_t_u[i] = cyl.state.t_u;
                }
            }
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct Result {
    brake_kw: f64,
    imep_bar: f64,
    peak_p_bar: f64,
    peak_t_k: f64,
    peak_t_b_k: f64,
    max_t_u_k: f64,
}

fn run(cfg: &SDM26Config, rpm: f64, n_cycles_warmup: u32) -> Result {
    let cancel = AtomicBool::new(false);
    let mut eng = SDM26Engine::new(cfg.clone(), JunctionKind::Stagnation);
    let mut state = CycleLoopState::new(&mut eng);
    let mut last_kw = 0.0;
    let mut last_imep = 0.0;
    for _ in 0..n_cycles_warmup {
        match eng.advance_one_cycle(rpm, &mut state, None, None, Some(&cancel)) {
            CycleOutcome::Cycle(cs) => {
                last_kw = cs.brake_power_k_w;
                last_imep = cs.imep_bar;
            }
            _ => break,
        }
    }
    // Instrumented cycle
    let n_cyl = eng.cylinders.len();
    let mut obs = ZoneObserver::new(n_cyl);
    let obs_ref: &mut dyn CycleObserver = &mut obs;
    let _ = eng.advance_one_cycle(rpm, &mut state, None, Some(obs_ref), Some(&cancel));
    let peak_p = obs.max_p.iter().cloned().fold(0.0_f64, f64::max);
    let peak_t = obs.max_t.iter().cloned().fold(0.0_f64, f64::max);
    let peak_t_b = obs.max_t_b.iter().cloned().fold(0.0_f64, f64::max);
    let max_t_u = obs.max_t_u.iter().cloned().fold(0.0_f64, f64::max);
    Result {
        brake_kw: last_kw,
        imep_bar: last_imep,
        peak_p_bar: peak_p / 1e5,
        peak_t_k: peak_t,
        peak_t_b_k: peak_t_b,
        max_t_u_k: max_t_u,
    }
}

#[test]
#[ignore]
fn two_zone_vs_single_zone_sweep() {
    let base = load_v1_json(sdm26_path()).unwrap();
    let race = race_calibration(&base);
    let mut race_two_zone = race.clone();
    race_two_zone.two_zone_enabled = true;

    println!("\n=== Two-zone vs single-zone (restricted FSAE race calibration) ===\n");
    println!("{:>6}  | {:>10}  {:>10}  {:>10}  {:>10}  | {:>10}  {:>10}  {:>10}  {:>10}  {:>10}  {:>10}",
        "RPM",
        "1Z kW", "1Z IMEP", "1Z Ppk", "1Z Tpk",
        "2Z kW", "2Z IMEP", "2Z Ppk", "2Z Tpk", "2Z T_b", "2Z T_u");

    let mut best_1z_kw = 0.0_f64;
    let mut best_2z_kw = 0.0_f64;
    let mut best_1z_rpm = 0.0;
    let mut best_2z_rpm = 0.0;

    for &rpm in &[10000.0_f64, 11000.0, 12000.0, 13000.0, 13500.0, 14000.0] {
        let r1 = run(&race, rpm, 7);
        let r2 = run(&race_two_zone, rpm, 7);
        if r1.brake_kw > best_1z_kw { best_1z_kw = r1.brake_kw; best_1z_rpm = rpm; }
        if r2.brake_kw > best_2z_kw { best_2z_kw = r2.brake_kw; best_2z_rpm = rpm; }
        println!("{:>6.0}  | {:>10.2}  {:>10.2}  {:>10.1}  {:>10.0}  | {:>10.2}  {:>10.2}  {:>10.1}  {:>10.0}  {:>10.0}  {:>10.0}",
            rpm,
            r1.brake_kw, r1.imep_bar, r1.peak_p_bar, r1.peak_t_k,
            r2.brake_kw, r2.imep_bar, r2.peak_p_bar, r2.peak_t_k, r2.peak_t_b_k, r2.max_t_u_k);
    }
    println!();
    println!("Peak 1Z: {:.2} kW @ {:.0} RPM", best_1z_kw, best_1z_rpm);
    println!("Peak 2Z: {:.2} kW @ {:.0} RPM  (Δ = {:+.2} kW, {:+.1}%)",
        best_2z_kw, best_2z_rpm, best_2z_kw - best_1z_kw,
        100.0 * (best_2z_kw - best_1z_kw) / best_1z_kw.max(1e-6));
}

#[test]
#[ignore]
fn two_zone_vs_single_zone_unrestricted() {
    let base = load_v1_json(sdm26_path()).unwrap();
    let race = unrestricted(&race_calibration(&base));
    let mut race_two_zone = race.clone();
    race_two_zone.two_zone_enabled = true;

    println!("\n=== Two-zone vs single-zone (UNRESTRICTED race calibration) ===\n");
    println!("Stock CBR600 target: ~88 kW @ 13.5k RPM\n");
    println!("{:>6}  | {:>10}  {:>10}  {:>10}  {:>10}  | {:>10}  {:>10}  {:>10}  {:>10}  {:>10}  {:>10}",
        "RPM",
        "1Z kW", "1Z IMEP", "1Z Ppk", "1Z Tpk",
        "2Z kW", "2Z IMEP", "2Z Ppk", "2Z Tpk", "2Z T_b", "2Z T_u");

    let mut best_1z_kw = 0.0_f64;
    let mut best_2z_kw = 0.0_f64;
    let mut best_1z_rpm = 0.0;
    let mut best_2z_rpm = 0.0;

    for &rpm in &[10000.0_f64, 11000.0, 12000.0, 13000.0, 13500.0, 14000.0] {
        let r1 = run(&race, rpm, 7);
        let r2 = run(&race_two_zone, rpm, 7);
        if r1.brake_kw > best_1z_kw { best_1z_kw = r1.brake_kw; best_1z_rpm = rpm; }
        if r2.brake_kw > best_2z_kw { best_2z_kw = r2.brake_kw; best_2z_rpm = rpm; }
        println!("{:>6.0}  | {:>10.2}  {:>10.2}  {:>10.1}  {:>10.0}  | {:>10.2}  {:>10.2}  {:>10.1}  {:>10.0}  {:>10.0}  {:>10.0}",
            rpm,
            r1.brake_kw, r1.imep_bar, r1.peak_p_bar, r1.peak_t_k,
            r2.brake_kw, r2.imep_bar, r2.peak_p_bar, r2.peak_t_k, r2.peak_t_b_k, r2.max_t_u_k);
    }
    println!();
    println!("Peak 1Z: {:.2} kW @ {:.0} RPM  ({:.0}% of 88 kW)",
        best_1z_kw, best_1z_rpm, 100.0 * best_1z_kw / 88.0);
    println!("Peak 2Z: {:.2} kW @ {:.0} RPM  ({:.0}% of 88 kW, Δ = {:+.2} kW, {:+.1}%)",
        best_2z_kw, best_2z_rpm, 100.0 * best_2z_kw / 88.0,
        best_2z_kw - best_1z_kw, 100.0 * (best_2z_kw - best_1z_kw) / best_1z_kw.max(1e-6));
}

#[test]
#[ignore]
fn two_zone_with_recalibrated_woschni() {
    // The two-zone model generally produces MORE heat loss than 1Z at
    // matched Woschni because the burned zone dominates the volume
    // fraction at T_b ~ 2500-2800 K vs T_avg ~ 1800-2200 K. To get a
    // useful comparison we also try retuning Woschni c1_combustion
    // downward to compensate.
    let base = load_v1_json(sdm26_path()).unwrap();
    let race = unrestricted(&race_calibration(&base));
    let mut two_zone = race.clone();
    two_zone.two_zone_enabled = true;

    println!("\n=== Two-zone with Woschni c1 retune (unrestricted) ===\n");
    let rpm = 13500.0;
    let r1 = run(&race, rpm, 7);
    println!("Single-zone baseline at {:.0} RPM:  {:.2} kW  IMEP {:.2} bar  Ppk {:.1} bar",
        rpm, r1.brake_kw, r1.imep_bar, r1.peak_p_bar);
    println!();
    println!("{:>10}  | {:>10}  {:>10}  {:>10}  {:>10}", "c1 scale", "kW", "IMEP", "Ppk", "T_b");
    let c1_base = two_zone.woschni_c1_combustion;
    for &s in &[1.00_f64, 0.85, 0.70, 0.55, 0.40, 0.25] {
        let mut c = two_zone.clone();
        c.woschni_c1_combustion = c1_base * s;
        let r = run(&c, rpm, 7);
        println!("{:>10.2}  | {:>10.2}  {:>10.2}  {:>10.1}  {:>10.0}",
            s, r.brake_kw, r.imep_bar, r.peak_p_bar, r.peak_t_b_k);
    }
}
