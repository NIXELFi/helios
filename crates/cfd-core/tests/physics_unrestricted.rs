//! Unrestricted-CBR600 sanity check.
//!
//! Reality check: a stock Honda CBR600RR (no FSAE restrictor) makes
//! ~88 kW (118 HP) at 13500 RPM. If our sim, with the restrictor
//! functionally removed, can't hit that, the calibration is genuinely
//! conservative across the board. If it does, the FSAE-restricted gap
//! is just the restrictor + acoustic-detuning artifact and the model
//! is well-calibrated.
//!
//! Restrictor removal: set throat diameter to 50mm (way above any
//! plausible bottleneck), Cd to 0.99, loss_coef to 0.0.
//!
//! Run:
//!   cargo test --release -p cfd-core --test physics_unrestricted -- --ignored --nocapture

use std::sync::atomic::AtomicBool;

use engine_sim::config::loader::load_v1_json;
use engine_sim::model::sdm26::{CycleLoopState, CycleOutcome, JunctionKind, SDM26Engine, SDM26Config};

fn sdm26_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../engine-sim/python_ref/configs/sdm26.json")
}

fn run_metrics(cfg: &SDM26Config, rpm: f64, n_cycles: u32) -> (f64, f64, f64, f64) {
    // brake_power_kW, brake_torque_Nm, ve_atm, imep_bar
    let cancel = AtomicBool::new(false);
    let mut eng = SDM26Engine::new(cfg.clone(), JunctionKind::Stagnation);
    let mut state = CycleLoopState::new(&mut eng);
    let mut last = (0.0, 0.0, 0.0, 0.0);
    for _ in 0..n_cycles {
        match eng.advance_one_cycle(rpm, &mut state, None, None, Some(&cancel)) {
            CycleOutcome::Cycle(cs) => {
                last = (cs.brake_power_k_w, cs.brake_torque_nm, cs.ve_atm, cs.imep_bar);
            }
            _ => break,
        }
    }
    last
}

fn unrestricted(cfg: &SDM26Config) -> SDM26Config {
    let mut c = cfg.clone();
    c.restrictor_throat_diameter = 0.050; // 50mm — far above any plausible bottleneck
    c.restrictor_cd = 0.99;
    c.restrictor_loss_coef = 0.0;
    c
}

#[test]
#[ignore]
fn unrestricted_rpm_curve() {
    let base = load_v1_json(sdm26_path()).unwrap();
    let unrestr = unrestricted(&base);

    println!("\n=== Unrestricted CBR600 sanity check ===");
    println!("Real-world stock CBR600RR: ~88 kW @ 13500 RPM, peak torque ~66 Nm");
    println!("FSAE-restricted (20mm): 41-52 kW typical\n");
    println!("Removing restrictor: throat 0.020→0.050 m, Cd 0.95→0.99, loss_coef 0\n");

    let rpms = [6000.0, 8000.0, 9000.0, 10000.0, 11000.0, 12000.0, 13000.0, 13500.0, 14000.0];

    println!("{:>6}  | {:>20}  | {:>20}  | {:>8}", "RPM",
        "RESTRICTED (kW/Nm/VE)", "OPEN (kW/Nm/VE)", "Δ kW");
    println!("{:->6}  | {:->20}  | {:->20}  | {:->8}", "", "", "", "");

    let mut restr_peak = (0.0, 0.0, 0.0); // kW, rpm, torque
    let mut open_peak  = (0.0, 0.0, 0.0);
    let mut open_peak_torque = (0.0, 0.0); // torque, rpm
    let mut restr_peak_torque = (0.0, 0.0);

    for &rpm in &rpms {
        let (kw_r, t_r, ve_r, _) = run_metrics(&base, rpm, 6);
        let (kw_o, t_o, ve_o, _) = run_metrics(&unrestr, rpm, 6);
        if kw_r > restr_peak.0 { restr_peak = (kw_r, rpm, t_r); }
        if kw_o > open_peak.0  { open_peak  = (kw_o, rpm, t_o); }
        if t_r > restr_peak_torque.0 { restr_peak_torque = (t_r, rpm); }
        if t_o > open_peak_torque.0  { open_peak_torque  = (t_o, rpm); }
        println!("{:>6.0}  |  {:>5.2} / {:>4.1} / {:>5.3}  |  {:>5.2} / {:>4.1} / {:>5.3}  |  {:>+6.2}",
            rpm, kw_r, t_r, ve_r, kw_o, t_o, ve_o, kw_o - kw_r);
    }

    println!();
    println!("RESTRICTED peak power:  {:.2} kW @ {:.0} RPM  (torque there: {:.1} Nm)",
        restr_peak.0, restr_peak.1, restr_peak.2);
    println!("OPEN       peak power:  {:.2} kW @ {:.0} RPM  (torque there: {:.1} Nm)",
        open_peak.0, open_peak.1, open_peak.2);
    println!("RESTRICTED peak torque: {:.1} Nm @ {:.0} RPM", restr_peak_torque.0, restr_peak_torque.1);
    println!("OPEN       peak torque: {:.1} Nm @ {:.0} RPM", open_peak_torque.0, open_peak_torque.1);

    println!();
    println!("Real-world stock CBR600RR: ~88 kW @ 13500 RPM, ~66 Nm @ 11000 RPM");
    let pwr_pct = 100.0 * open_peak.0 / 88.0;
    let trq_pct = 100.0 * open_peak_torque.0 / 66.0;
    println!("Sim hits {:.1}% of stock peak power, {:.1}% of stock peak torque",
        pwr_pct, trq_pct);
    println!();
    let restrictor_lift = 100.0 * (open_peak.0 - restr_peak.0) / restr_peak.0;
    println!("Lift from removing restrictor: +{:.1}%", restrictor_lift);
}
