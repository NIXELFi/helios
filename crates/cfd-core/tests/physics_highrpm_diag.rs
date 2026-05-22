//! Diagnose why the unrestricted sim peaks at 9000 RPM instead of the
//! stock CBR600RR's 13500 RPM. Sequentially apply changes that real
//! high-RPM engines depend on:
//!   1. Faster Wiebe (less crank-degree burn duration)
//!   2. Earlier IVC + later IVO (more overlap, longer fill window)
//!   3. Shorter runner (tuned closer to the actual peak-power RPM)
//!
//! See which one moves the peak-power RPM closer to redline.
//!
//! Run:
//!   cargo test --release -p cfd-core --test physics_highrpm_diag -- --ignored --nocapture

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

fn run_brake_kw(cfg: &SDM26Config, rpm: f64, n_cycles: u32) -> f64 {
    let cancel = AtomicBool::new(false);
    let mut eng = SDM26Engine::new(cfg.clone(), JunctionKind::Stagnation);
    let mut state = CycleLoopState::new(&mut eng);
    let mut kw = 0.0;
    for _ in 0..n_cycles {
        match eng.advance_one_cycle(rpm, &mut state, None, None, Some(&cancel)) {
            CycleOutcome::Cycle(cs) => kw = cs.brake_power_k_w,
            _ => break,
        }
    }
    kw
}

fn peak(cfg: &SDM26Config) -> (f64, f64) {
    let rpms = [6000.0, 7000.0, 8000.0, 9000.0, 10000.0, 11000.0, 12000.0, 13000.0, 13500.0, 14000.0];
    let mut best_kw = 0.0;
    let mut best_rpm = 0.0;
    for &rpm in &rpms {
        let kw = run_brake_kw(cfg, rpm, 6);
        if kw > best_kw { best_kw = kw; best_rpm = rpm; }
    }
    (best_kw, best_rpm)
}

fn set_runner_length(cfg: &mut SDM26Config, l: f64) {
    cfg.runner_length = l;
    if let Some(v) = cfg.runner_lengths.as_mut() {
        for x in v.iter_mut() { *x = l; }
    }
}

#[test]
#[ignore]
fn highrpm_decomposition() {
    let base = load_v1_json(sdm26_path()).unwrap();
    let open = unrestricted(&base);

    println!("\n=== High-RPM gap diagnosis ===");
    println!("Goal: explain why unrestricted sim peaks at 9000 RPM");
    println!("instead of stock CBR600RR's 13500 RPM @ 88 kW.\n");

    println!("{:>50}  {:>10}  {:>10}  {:>10}", "Config", "Peak kW", "@ RPM", "Δ kW");

    let (p0, r0) = peak(&open);
    println!("{:>50}  {:>10.2}  {:>10.0}  {:>10}", "0. Unrestricted (baseline)", p0, r0, "—");
    let mut last = p0;

    // Test 1: Fast burn (25° Wiebe instead of 50°).
    let mut c1 = open.clone();
    c1.combustion_duration = 25.0;
    let (p1, r1) = peak(&c1);
    println!("{:>50}  {:>10.2}  {:>10.0}  {:>+10.2}", "1. + Wiebe 50°→25° (fast burn)", p1, r1, p1 - last);
    last = p1;

    // Test 2: Add aggressive Wiebe m (steeper rise).
    let mut c2 = c1.clone();
    c2.wiebe_m = 3.5; // steeper than default 2
    let (p2, r2) = peak(&c2);
    println!("{:>50}  {:>10.2}  {:>10.0}  {:>+10.2}", "2. + Wiebe m 2→3.5 (steeper)", p2, r2, p2 - last);
    last = p2;

    // Test 3: Higher η_comb.
    let mut c3 = c2.clone();
    c3.eta_comb = 0.99;
    let (p3, r3) = peak(&c3);
    println!("{:>50}  {:>10.2}  {:>10.0}  {:>+10.2}", "3. + η_comb 0.96→0.99", p3, r3, p3 - last);
    last = p3;

    // Test 4: Reduce heat loss.
    let mut c4 = c3.clone();
    c4.woschni_c1_combustion *= 0.5;
    c4.woschni_c1_compression *= 0.5;
    c4.woschni_c1_gas_exchange *= 0.5;
    let (p4, r4) = peak(&c4);
    println!("{:>50}  {:>10.2}  {:>10.0}  {:>+10.2}", "4. + Woschni × 0.5 (less heat loss)", p4, r4, p4 - last);
    last = p4;

    // Test 5: Shorter runner (high-RPM tuned).
    let mut c5 = c4.clone();
    set_runner_length(&mut c5, 0.180);
    let (p5, r5) = peak(&c5);
    println!("{:>50}  {:>10.2}  {:>10.0}  {:>+10.2}", "5. + runner 0.245→0.180 m (high-rpm)", p5, r5, p5 - last);
    last = p5;

    // Test 6: Bigger intake valve.
    let mut c6 = c5.clone();
    c6.intake_valve_max_lift = 0.011;
    c6.intake_valve_diameter = 0.030;
    let (p6, r6) = peak(&c6);
    println!("{:>50}  {:>10.2}  {:>10.0}  {:>+10.2}", "6. + intake valve +25%", p6, r6, p6 - last);
    last = p6;

    // Test 7: Optimized cam (more overlap).
    let mut c7 = c6.clone();
    c7.intake_valve_open_angle = 330.0; // earlier IVO
    c7.intake_valve_close_angle = 610.0; // later IVC
    let (p7, r7) = peak(&c7);
    println!("{:>50}  {:>10.2}  {:>10.0}  {:>+10.2}", "7. + cam: IVO 350°→330°, IVC 585°→610°", p7, r7, p7 - last);
    last = p7;

    // Test 8: Bigger exhaust valve.
    let mut c8 = c7.clone();
    c8.exhaust_valve_max_lift = 0.010;
    c8.exhaust_valve_diameter = 0.026;
    let (p8, r8) = peak(&c8);
    println!("{:>50}  {:>10.2}  {:>10.0}  {:>+10.2}", "8. + exhaust valve +13%", p8, r8, p8 - last);
    last = p8;

    println!();
    println!("From baseline open: {:.1} → {:.1} kW ({:+.0}%) at {:.0} → {:.0} RPM",
        p0, last, 100.0 * (last - p0) / p0, r0, r7);
    println!("Real-world stock CBR600RR: 88 kW @ 13500 RPM");
    println!("Sim hits {:.0}% of stock peak power after aggressive re-tune",
        100.0 * last / 88.0);
}

#[test]
#[ignore]
fn ve_ceiling_hunt() {
    // Pushed-to-the-max intake side, unrestricted, see how high VE can go.
    let base = load_v1_json(sdm26_path()).unwrap();
    let mut c = unrestricted(&base);
    c.combustion_duration = 30.0;
    c.eta_comb = 0.99;
    c.afr_target = 12.5;
    c.intake_valve_max_lift = 0.013;       // huge lift
    c.intake_valve_diameter = 0.033;       // huge valve
    c.exhaust_valve_max_lift = 0.012;
    c.exhaust_valve_diameter = 0.028;
    c.intake_valve_open_angle = 325.0;
    c.intake_valve_close_angle = 615.0;
    c.exhaust_valve_open_angle = 115.0;
    c.exhaust_valve_close_angle = 395.0;
    c.plenum_volume = 0.0045;              // 3x bigger plenum
    set_runner_length(&mut c, 0.18);       // tuned for 14k
    c.runner_diameter_in = 0.045;
    if let Some(arr) = c.runner_diameters_in.as_mut() {
        for v in arr.iter_mut() { *v = 0.045; }
    }
    c.woschni_c1_combustion *= 0.5;
    c.woschni_c1_compression *= 0.5;

    println!("\n=== VE ceiling hunt: maximally aggressive intake/exhaust ===\n");

    let rpms = [8000.0, 10000.0, 12000.0, 13000.0, 13500.0, 14000.0];
    let cancel = AtomicBool::new(false);
    println!("{:>6}  {:>8}  {:>10}  {:>10}", "RPM", "VE", "Brake kW", "Brake Nm");
    let mut peak_kw = 0.0;
    let mut peak_rpm = 0.0;
    let mut peak_ve = 0.0;
    for &rpm in &rpms {
        let mut eng = SDM26Engine::new(c.clone(), JunctionKind::Stagnation);
        let mut state = CycleLoopState::new(&mut eng);
        let mut last_kw = 0.0; let mut last_t = 0.0; let mut last_ve = 0.0;
        for _ in 0..6 {
            match eng.advance_one_cycle(rpm, &mut state, None, None, Some(&cancel)) {
                CycleOutcome::Cycle(cs) => {
                    last_kw = cs.brake_power_k_w; last_t = cs.brake_torque_nm; last_ve = cs.ve_atm;
                }
                _ => break,
            }
        }
        println!("{:>6.0}  {:>8.3}  {:>10.2}  {:>10.2}", rpm, last_ve, last_kw, last_t);
        if last_kw > peak_kw { peak_kw = last_kw; peak_rpm = rpm; peak_ve = last_ve; }
    }
    println!();
    println!("Aggressive peak: {:.1} kW @ {:.0} RPM (VE = {:.3})", peak_kw, peak_rpm, peak_ve);
    println!("Real-world stock CBR600RR: 88 kW @ 13500 RPM (VE ~0.90)");
    println!("Sim hits {:.0}% of stock power, {:.0}% of real VE",
        100.0 * peak_kw / 88.0, 100.0 * peak_ve / 0.90);
}
