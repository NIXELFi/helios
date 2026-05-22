//! Final benchmark: best-achievable sim performance vs real CBR600 dyno data.
//! All model fixes enabled, parameters tuned to a plausible race calibration.
//!
//! Run:
//!   cargo test --release -p cfd-core --test physics_final_bench -- --ignored --nocapture

use std::sync::atomic::AtomicBool;

use engine_sim::config::loader::load_v1_json;
use engine_sim::model::sdm26::{CycleLoopState, CycleOutcome, JunctionKind, SDM26Engine, SDM26Config};

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

/// "Race CBR600" calibration — best-effort tuning of every available knob.
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
    c.fmep_a = 0.35; c.fmep_b = 0.045; c.fmep_c = 0.0005;
    c.woschni_c1_combustion *= 0.7;
    c
}

fn run(cfg: &SDM26Config, rpm: f64, n_cycles: u32) -> (f64, f64) {
    let cancel = AtomicBool::new(false);
    let mut eng = SDM26Engine::new(cfg.clone(), JunctionKind::Stagnation);
    let mut state = CycleLoopState::new(&mut eng);
    let mut last = (0.0, 0.0);
    for _ in 0..n_cycles {
        match eng.advance_one_cycle(rpm, &mut state, None, None, Some(&cancel)) {
            CycleOutcome::Cycle(cs) => last = (cs.brake_power_k_w, cs.brake_torque_nm),
            _ => break,
        }
    }
    last
}

#[test]
#[ignore]
fn full_dyno_curve_comparison() {
    let base = load_v1_json(sdm26_path()).unwrap();
    let race = race_calibration(&base);

    println!("\n=== Final benchmark: race-calibration CBR600 vs real dyno ===\n");

    let rpms = [5000.0, 6000.0, 7000.0, 8000.0, 9000.0, 10000.0, 11000.0, 12000.0, 13000.0, 13500.0, 14000.0];

    // Restricted
    println!("RESTRICTED (FSAE 20mm)");
    println!("{:>6}  | {:>10}  {:>10}  | {:>10}  {:>10}", "RPM", "Legacy kW", "Legacy Nm", "Race kW", "Race Nm");
    let mut peak_legacy = 0.0; let mut peak_race = 0.0;
    let mut peak_legacy_rpm = 0.0; let mut peak_race_rpm = 0.0;
    for &rpm in &rpms {
        let (kw_l, t_l) = run(&base, rpm, 6);
        let (kw_r, t_r) = run(&race, rpm, 8);
        if kw_l > peak_legacy { peak_legacy = kw_l; peak_legacy_rpm = rpm; }
        if kw_r > peak_race { peak_race = kw_r; peak_race_rpm = rpm; }
        println!("{:>6.0}  | {:>10.2}  {:>10.2}  | {:>10.2}  {:>10.2}", rpm, kw_l, t_l, kw_r, t_r);
    }
    println!();
    println!("Legacy peak: {:.2} kW @ {:.0} RPM", peak_legacy, peak_legacy_rpm);
    println!("Race peak:   {:.2} kW @ {:.0} RPM  ({:+.0}% vs legacy)", peak_race, peak_race_rpm, 100.0 * (peak_race - peak_legacy) / peak_legacy);

    // Unrestricted
    println!();
    println!("UNRESTRICTED");
    let base_open = unrestricted(&base);
    let race_open = unrestricted(&race);
    println!("{:>6}  | {:>10}  {:>10}  | {:>10}  {:>10}", "RPM", "Legacy kW", "Legacy Nm", "Race kW", "Race Nm");
    let mut peak_l2 = 0.0; let mut peak_r2 = 0.0;
    let mut peak_l2_rpm = 0.0; let mut peak_r2_rpm = 0.0;
    for &rpm in &rpms {
        let (kw_l, t_l) = run(&base_open, rpm, 6);
        let (kw_r, t_r) = run(&race_open, rpm, 8);
        if kw_l > peak_l2 { peak_l2 = kw_l; peak_l2_rpm = rpm; }
        if kw_r > peak_r2 { peak_r2 = kw_r; peak_r2_rpm = rpm; }
        println!("{:>6.0}  | {:>10.2}  {:>10.2}  | {:>10.2}  {:>10.2}", rpm, kw_l, t_l, kw_r, t_r);
    }
    println!();
    println!("Legacy unrestricted peak: {:.2} kW @ {:.0} RPM", peak_l2, peak_l2_rpm);
    println!("Race unrestricted peak:   {:.2} kW @ {:.0} RPM  ({:+.0}% vs legacy)",
        peak_r2, peak_r2_rpm, 100.0 * (peak_r2 - peak_l2) / peak_l2);

    println!();
    println!("============================================");
    println!("Real-world targets:");
    println!("  FSAE restricted typical:  ~47 kW peak @ ~11.5k");
    println!("  FSAE restricted bottom:   ~41 kW");
    println!("  Stock CBR600 unrestricted: ~88 kW @ 13.5k");
    println!();
    println!("Achievement:");
    println!("  Race-restricted   vs 47 kW typical:  {:.0}%  ({:.2} kW)", 100.0 * peak_race / 47.0, peak_race);
    println!("  Race-restricted   vs 41 kW bottom:   {:.0}%  ({:.2} kW)", 100.0 * peak_race / 41.0, peak_race);
    println!("  Race-unrestricted vs 88 kW stock:    {:.0}%  ({:.2} kW)", 100.0 * peak_r2 / 88.0, peak_r2);
}
