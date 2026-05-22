//! Push every available knob to its physical limit to find the model's
//! absolute ceiling. If this doesn't close the unrestricted gap, the
//! remaining gap is a fundamental modeling-class limitation.
//!
//! Run:
//!   cargo test --release -p cfd-core --test physics_max_attack -- --ignored --nocapture

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

fn run(cfg: &SDM26Config, rpm: f64, n_cycles: u32) -> (f64, f64, f64, f64, f64) {
    // brake_kw, brake_torque, ve, imep, egt
    let cancel = AtomicBool::new(false);
    let mut eng = SDM26Engine::new(cfg.clone(), JunctionKind::Stagnation);
    let mut state = CycleLoopState::new(&mut eng);
    let mut last = (0.0, 0.0, 0.0, 0.0, 0.0);
    for _ in 0..n_cycles {
        match eng.advance_one_cycle(rpm, &mut state, None, None, Some(&cancel)) {
            CycleOutcome::Cycle(cs) => last = (
                cs.brake_power_k_w, cs.brake_torque_nm, cs.ve_atm,
                cs.imep_bar, cs.egt_mean
            ),
            _ => break,
        }
    }
    last
}

fn set_runner_length(cfg: &mut SDM26Config, l: f64) {
    cfg.runner_length = l;
    if let Some(v) = cfg.runner_lengths.as_mut() {
        for x in v.iter_mut() { *x = l; }
    }
}

#[test]
#[ignore]
fn max_attack_unrestricted() {
    let base = load_v1_json(sdm26_path()).unwrap();
    let mut c = unrestricted(&base);

    // Everything maxed out:
    c.intake_lift_flat_top_ramp = 0.20;       // very flat-top cam
    c.exhaust_lift_flat_top_ramp = 0.20;
    c.afr_eta_enabled = true;
    c.afr_target = 12.0;                       // power-rich
    c.combustion_duration = 25.0;              // fast burn (modern chamber)
    c.spark_advance = 30.0;                    // aggressive advance
    c.eta_comb = 0.99;                         // perfect combustion
    c.cr = 13.5;                               // race compression
    c.fmep_a = 0.25;
    c.fmep_b = 0.04;
    c.fmep_c = 0.0003;
    c.woschni_c1_combustion *= 0.5;
    c.woschni_c1_compression *= 0.5;
    c.intake_valve_max_lift = 0.012;
    c.intake_valve_diameter = 0.032;
    c.exhaust_valve_max_lift = 0.011;
    c.exhaust_valve_diameter = 0.027;
    c.intake_valve_open_angle = 325.0;         // wide cam
    c.intake_valve_close_angle = 615.0;
    c.exhaust_valve_open_angle = 115.0;
    c.exhaust_valve_close_angle = 395.0;
    c.plenum_volume = 0.0040;
    set_runner_length(&mut c, 0.20);
    c.runner_diameter_in = 0.045;
    if let Some(arr) = c.runner_diameters_in.as_mut() {
        for v in arr.iter_mut() { *v = 0.045; }
    }
    // Bump intake cd table
    for v in c.intake_cd_table.iter_mut() { *v = (*v * 1.15).min(0.85); }
    for v in c.exhaust_cd_table.iter_mut() { *v = (*v * 1.15).min(0.80); }

    println!("\n=== MAX ATTACK: everything maxed out, unrestricted ===\n");

    let rpms = [8000.0, 10000.0, 11000.0, 12000.0, 13000.0, 13500.0, 14000.0, 14500.0, 15000.0];
    println!("{:>6}  {:>8}  {:>8}  {:>10}  {:>10}  {:>10}", "RPM", "VE", "IMEP", "Brake kW", "Brake Nm", "EGT K");
    let mut peak = (0.0, 0.0);
    for &rpm in &rpms {
        let (kw, t, ve, imep, egt) = run(&c, rpm, 8);
        println!("{:>6.0}  {:>8.3}  {:>8.2}  {:>10.2}  {:>10.2}  {:>10.0}", rpm, ve, imep, kw, t, egt);
        if kw > peak.0 { peak = (kw, rpm); }
    }
    println!();
    println!("Peak: {:.1} kW @ {:.0} RPM", peak.0, peak.1);
    println!("Real-world stock CBR600RR: 88 kW @ 13500 RPM");
    println!("Sim hits {:.0}% of real peak", 100.0 * peak.0 / 88.0);
}

#[test]
#[ignore]
fn measured_attack_unrestricted() {
    let base = load_v1_json(sdm26_path()).unwrap();
    let mut c = unrestricted(&base);

    // Realistic modern racing CBR600 calibration:
    c.intake_lift_flat_top_ramp = 0.22;
    c.exhaust_lift_flat_top_ramp = 0.22;
    c.afr_eta_enabled = true;
    c.afr_target = 12.3;
    c.combustion_duration = 35.0;
    c.spark_advance = 28.0;
    c.eta_comb = 0.98;
    c.cr = 13.0;                    // modest CR bump (stock 12.2 → race 13.0)
    c.fmep_a = 0.35;
    c.fmep_b = 0.045;
    c.fmep_c = 0.0005;
    c.woschni_c1_combustion *= 0.7;
    c.intake_valve_max_lift = 0.0095;
    c.exhaust_valve_max_lift = 0.0085;

    println!("\n=== MEASURED ATTACK: realistic race CBR600 calibration ===\n");

    let rpms = [8000.0, 10000.0, 11000.0, 12000.0, 13000.0, 13500.0, 14000.0];
    println!("{:>6}  {:>8}  {:>8}  {:>10}  {:>10}", "RPM", "VE", "IMEP", "Brake kW", "Brake Nm");
    let mut peak = (0.0, 0.0);
    for &rpm in &rpms {
        let (kw, t, ve, imep, _) = run(&c, rpm, 8);
        println!("{:>6.0}  {:>8.3}  {:>8.2}  {:>10.2}  {:>10.2}", rpm, ve, imep, kw, t);
        if kw > peak.0 { peak = (kw, rpm); }
    }
    println!();
    println!("Peak: {:.1} kW @ {:.0} RPM ({:.0}% of real 88 kW)", peak.0, peak.1, 100.0 * peak.0 / 88.0);
}

#[test]
#[ignore]
fn mbt_per_rpm_attack() {
    let base = load_v1_json(sdm26_path()).unwrap();
    let mut tuned = unrestricted(&base);
    tuned.intake_lift_flat_top_ramp = 0.22;
    tuned.exhaust_lift_flat_top_ramp = 0.22;
    tuned.afr_eta_enabled = true;
    tuned.afr_target = 12.3;
    tuned.combustion_duration = 30.0;
    tuned.wiebe_m = 3.0;                       // steeper burn = higher peak P
    tuned.eta_comb = 0.98;
    tuned.cr = 13.0;
    tuned.fmep_a = 0.35;
    tuned.fmep_b = 0.045;
    tuned.fmep_c = 0.0005;
    tuned.woschni_c1_combustion *= 0.7;

    println!("\n=== MBT-per-RPM attack: optimize spark at each RPM ===\n");

    let rpms = [8000.0, 10000.0, 12000.0, 13000.0, 13500.0, 14000.0];
    let sparks: Vec<f64> = (15..=40).step_by(2).map(|x| x as f64).collect();

    let mut peak_kw = 0.0;
    let mut peak_rpm = 0.0;
    let mut peak_sa = 0.0;

    for &rpm in &rpms {
        let mut best_kw = 0.0;
        let mut best_sa = 0.0;
        for &sa in &sparks {
            let mut c = tuned.clone();
            c.spark_advance = sa;
            let (kw, _, _, _, _) = run(&c, rpm, 8);
            if kw > best_kw { best_kw = kw; best_sa = sa; }
        }
        println!("  RPM={:.0}  MBT={:.0}° BTDC  Peak kW={:.2}", rpm, best_sa, best_kw);
        if best_kw > peak_kw { peak_kw = best_kw; peak_rpm = rpm; peak_sa = best_sa; }
    }

    println!();
    println!("Global peak: {:.1} kW @ {:.0} RPM, MBT {:.0}°", peak_kw, peak_rpm, peak_sa);
    println!("Real-world: 88 kW. Sim {:.0}%.", 100.0 * peak_kw / 88.0);
}

#[test]
#[ignore]
fn extreme_wiebe_attack() {
    let base = load_v1_json(sdm26_path()).unwrap();
    let mut c = unrestricted(&base);
    c.intake_lift_flat_top_ramp = 0.22;
    c.exhaust_lift_flat_top_ramp = 0.22;
    c.afr_eta_enabled = true;
    c.afr_target = 12.3;
    c.eta_comb = 0.98;
    c.cr = 13.0;
    c.fmep_a = 0.35;
    c.fmep_b = 0.045;
    c.fmep_c = 0.0005;
    c.woschni_c1_combustion *= 0.5;
    c.spark_advance = 17.0;

    println!("\n=== Extreme Wiebe shape attack ===\n");

    let cases = [
        ("baseline (m=3, dur=30)",      3.0, 30.0),
        ("m=3, dur=25 (faster)",        3.0, 25.0),
        ("m=4, dur=30 (steeper)",       4.0, 30.0),
        ("m=4, dur=25",                 4.0, 25.0),
        ("m=5, dur=25 (very steep)",    5.0, 25.0),
        ("m=5, dur=20",                 5.0, 20.0),
        ("m=2 (default), dur=20",       2.0, 20.0),
        ("m=2.5, dur=22",               2.5, 22.0),
    ];

    println!("{:>30}  {:>8}  {:>8}", "config", "Pk kW", "Pk RPM");
    let mut overall_peak = 0.0;
    let mut overall_cfg = "";
    for (label, m, dur) in &cases {
        let mut cc = c.clone();
        cc.wiebe_m = *m;
        cc.combustion_duration = *dur;
        let mut peak_kw = 0.0;
        let mut peak_rpm = 0.0;
        for &rpm in &[10000.0, 12000.0, 13000.0, 13500.0, 14000.0] {
            let (kw, _, _, _, _) = run(&cc, rpm, 8);
            if kw > peak_kw { peak_kw = kw; peak_rpm = rpm; }
        }
        println!("{:>30}  {:>8.2}  {:>8.0}", label, peak_kw, peak_rpm);
        if peak_kw > overall_peak { overall_peak = peak_kw; overall_cfg = label; }
    }
    println!();
    println!("Best: {} → {:.1} kW ({:.0}% of real 88 kW)", overall_cfg, overall_peak, 100.0 * overall_peak / 88.0);
}

#[test]
#[ignore]
fn tumble_attack() {
    let base = load_v1_json(sdm26_path()).unwrap();
    let mut c = unrestricted(&base);
    c.intake_lift_flat_top_ramp = 0.22;
    c.exhaust_lift_flat_top_ramp = 0.22;
    c.afr_eta_enabled = true;
    c.afr_target = 12.3;
    c.combustion_duration = 30.0;
    c.wiebe_m = 3.0;
    c.spark_advance = 19.0;
    c.eta_comb = 0.98;
    c.cr = 13.0;
    c.fmep_a = 0.35; c.fmep_b = 0.045; c.fmep_c = 0.0005;
    c.woschni_c1_combustion *= 0.7;

    println!("\n=== Tumble burn factor sweep (unrestricted) ===\n");

    let factors = [0.0, 0.2, 0.4, 0.6, 0.8, 1.0];
    for &tf in &factors {
        let mut cc = c.clone();
        cc.tumble_burn_factor = tf;
        let mut peak_kw = 0.0;
        let mut peak_rpm = 0.0;
        let mut peak_imep = 0.0;
        for &rpm in &[10000.0, 12000.0, 13000.0, 13500.0, 14000.0_f64] {
            let (kw, _, _, imep, _) = run(&cc, rpm, 8);
            if kw > peak_kw { peak_kw = kw; peak_rpm = rpm; peak_imep = imep; }
        }
        println!("  tumble={:.1}  peak={:.2} kW @ {:.0} RPM  (IMEP {:.2})  → {:.0}% of real",
            tf, peak_kw, peak_rpm, peak_imep, 100.0 * peak_kw / 88.0);
    }
}
