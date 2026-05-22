//! VE diagnosis: why does the sim cap at 0.71 at 13500 RPM unrestricted
//! when real CBR600 hits 0.90? Sweep intake geometry to find the lever.
//!
//! Run:
//!   cargo test --release -p cfd-core --test physics_intake_diagnose -- --ignored --nocapture

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

fn run(cfg: &SDM26Config, rpm: f64, n_cycles: u32) -> (f64, f64, f64) {
    let cancel = AtomicBool::new(false);
    let mut eng = SDM26Engine::new(cfg.clone(), JunctionKind::Stagnation);
    let mut state = CycleLoopState::new(&mut eng);
    let mut last = (0.0, 0.0, 0.0);
    for _ in 0..n_cycles {
        match eng.advance_one_cycle(rpm, &mut state, None, None, Some(&cancel)) {
            CycleOutcome::Cycle(cs) => last = (cs.brake_power_k_w, cs.ve_atm, cs.imep_bar),
            _ => break,
        }
    }
    last
}

fn set_runner(cfg: &mut SDM26Config, l: f64, d: f64) {
    cfg.runner_length = l;
    cfg.runner_diameter_in = d;
    if let Some(v) = cfg.runner_lengths.as_mut() {
        for x in v.iter_mut() { *x = l; }
    }
    if let Some(v) = cfg.runner_diameters_in.as_mut() {
        for x in v.iter_mut() { *x = d; }
    }
}

fn race_calibration(base: &SDM26Config) -> SDM26Config {
    let mut c = unrestricted(base);
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
    c.woschni_c1_combustion *= 0.5;
    c
}

#[test]
#[ignore]
fn runner_length_at_13500() {
    let base = load_v1_json(sdm26_path()).unwrap();
    let race = race_calibration(&base);

    println!("\n=== Runner length sweep at 13500 RPM (race calibration) ===\n");
    println!("Quarter-wave optimal for 13500 RPM with a≈361 m/s: L ≈ 7.5·a/RPM = {:.3} m",
        7.5 * 361.0 / 13500.0);
    println!();

    let lengths_mm = [120.0, 150.0, 180.0, 200.0, 220.0, 245.0, 270.0, 300.0, 350.0];
    println!("{:>8}  {:>8}  {:>10}", "L (mm)", "VE", "Brake kW");
    for &l_mm in &lengths_mm {
        let mut c = race.clone();
        set_runner(&mut c, l_mm / 1000.0, race.runner_diameter_in);
        let (kw, ve, _) = run(&c, 13500.0, 8);
        println!("{:>8.0}  {:>8.3}  {:>10.2}", l_mm, ve, kw);
    }
}

#[test]
#[ignore]
fn runner_diameter_at_13500() {
    let base = load_v1_json(sdm26_path()).unwrap();
    let race = race_calibration(&base);

    println!("\n=== Runner diameter sweep at 13500 RPM (race) ===\n");
    let diameters_mm = [32.0, 36.0, 38.0, 40.0, 42.0, 45.0, 48.0, 52.0];
    println!("{:>8}  {:>8}  {:>10}", "D (mm)", "VE", "Brake kW");
    for &d_mm in &diameters_mm {
        let mut c = race.clone();
        set_runner(&mut c, race.runner_length, d_mm / 1000.0);
        let (kw, ve, _) = run(&c, 13500.0, 8);
        println!("{:>8.0}  {:>8.3}  {:>10.2}", d_mm, ve, kw);
    }
}

#[test]
#[ignore]
fn cam_duration_at_13500() {
    let base = load_v1_json(sdm26_path()).unwrap();
    let race = race_calibration(&base);

    println!("\n=== Intake cam duration sweep at 13500 RPM (race) ===\n");
    println!("Default: IVO=350°, IVC=585°, duration=235°. Race cams: 270-290°.\n");

    let cams = [
        // (IVO, IVC) in degrees ATDC of intake
        (350.0_f64, 585.0_f64, "stock 235°"),
        (340.0, 600.0, "260°"),
        (335.0, 615.0, "280°"),
        (325.0, 625.0, "300°"),
        (315.0, 635.0, "320°"),
    ];
    println!("{:>20}  {:>8}  {:>10}", "Cam", "VE", "Brake kW");
    for &(ivo, ivc, label) in &cams {
        let mut c = race.clone();
        c.intake_valve_open_angle = ivo;
        c.intake_valve_close_angle = ivc;
        // matching exhaust
        let evd = ivc - ivo;  // similar duration
        c.exhaust_valve_open_angle = 540.0 - (evd - 235.0) / 2.0;
        c.exhaust_valve_close_angle = c.exhaust_valve_open_angle + evd;
        let (kw, ve, _) = run(&c, 13500.0, 8);
        println!("{:>20}  {:>8.3}  {:>10.2}", label, ve, kw);
    }
}

#[test]
#[ignore]
fn plenum_at_13500() {
    let base = load_v1_json(sdm26_path()).unwrap();
    let race = race_calibration(&base);

    println!("\n=== Plenum volume sweep at 13500 RPM (race) ===\n");
    let vols = [0.001, 0.0015, 0.0025, 0.004, 0.006, 0.010, 0.020];
    println!("{:>8}  {:>8}  {:>10}", "Vol L", "VE", "Brake kW");
    for &v in &vols {
        let mut c = race.clone();
        c.plenum_volume = v;
        let (kw, ve, _) = run(&c, 13500.0, 8);
        println!("{:>8.4}  {:>8.3}  {:>10.2}", v, ve, kw);
    }
}

#[test]
#[ignore]
fn full_intake_optimization_at_13500() {
    let base = load_v1_json(sdm26_path()).unwrap();
    let mut best_kw = 0.0;
    let mut best_cfg = String::new();
    println!("\n=== Coarse 4D intake search at 13500 RPM ===\n");

    let race = race_calibration(&base);
    for &l in &[0.15, 0.18, 0.20, 0.22, 0.25, 0.30] {
        for &d in &[0.038, 0.042, 0.045] {
            for &ivc in &[600.0, 615.0, 625.0] {
                for &plen in &[0.0025, 0.005, 0.008] {
                    let mut c = race.clone();
                    set_runner(&mut c, l, d);
                    c.intake_valve_open_angle = 335.0;
                    c.intake_valve_close_angle = ivc;
                    c.exhaust_valve_open_angle = 115.0;
                    c.exhaust_valve_close_angle = ivc - 220.0;
                    c.plenum_volume = plen;
                    let (kw, _, _) = run(&c, 13500.0, 8);
                    if kw > best_kw {
                        best_kw = kw;
                        best_cfg = format!("L={:.3}, D={:.3}, IVC={:.0}, plenum={:.4}", l, d, ivc, plen);
                    }
                }
            }
        }
    }
    println!("BEST at 13500 RPM: {:.2} kW  ({})", best_kw, best_cfg);
    println!("({}% of real 88 kW)", 100.0 * best_kw / 88.0);
}

#[test]
#[ignore]
fn big_intake_config() {
    let base = load_v1_json(sdm26_path()).unwrap();
    let mut c = race_calibration(&base);
    set_runner(&mut c, 0.30, 0.048);    // big-diameter velocity-stack style
    c.plenum_volume = 0.0060;             // 6L plenum (realistic FSAE max)

    println!("\n=== Big-intake race config across RPM range ===\n");
    let rpms = [8000.0, 10000.0, 12000.0, 13000.0, 13500.0, 14000.0];
    println!("{:>6}  {:>8}  {:>10}", "RPM", "VE", "Brake kW");
    let mut peak = (0.0, 0.0);
    for &rpm in &rpms {
        let (kw, ve, _) = run(&c, rpm, 8);
        println!("{:>6.0}  {:>8.3}  {:>10.2}", rpm, ve, kw);
        if kw > peak.0 { peak = (kw, rpm); }
    }
    println!();
    println!("Peak: {:.2} kW @ {:.0} RPM ({:.0}% of real 88 kW)", peak.0, peak.1, 100.0 * peak.0 / 88.0);
}

#[test]
#[ignore]
fn intake_geometry_grid() {
    let base = load_v1_json(sdm26_path()).unwrap();
    let race = race_calibration(&base);
    let mut best = (0.0_f64, String::new());
    println!("\n=== Coarse-but-focused intake geometry grid ===\n");
    for &l in &[0.20_f64, 0.25, 0.30, 0.35] {
        for &d in &[0.040_f64, 0.045, 0.050, 0.055, 0.060] {
            for &plen in &[0.004_f64, 0.006, 0.010] {
                let mut c = race.clone();
                set_runner(&mut c, l, d);
                c.plenum_volume = plen;
                let mut maxkw: f64 = 0.0;
                for &rpm in &[12000.0_f64, 13000.0, 13500.0, 14000.0] {
                    let (kw, _, _) = run(&c, rpm, 8);
                    maxkw = maxkw.max(kw);
                }
                if maxkw > best.0 {
                    best = (maxkw, format!("L={:.2}, D={:.3}, plenum={:.3}", l, d, plen));
                }
            }
        }
    }
    println!("Best: {:.2} kW with {}", best.0, best.1);
    println!("→ {:.0}% of real 88 kW", 100.0 * best.0 / 88.0);
}

#[test]
#[ignore]
fn full_breathing_attack() {
    let base = load_v1_json(sdm26_path()).unwrap();
    let mut c = race_calibration(&base);
    // Big intake
    set_runner(&mut c, 0.30, 0.050);
    c.plenum_volume = 0.008;
    // Bigger intake valves
    c.intake_valve_max_lift = 0.011;
    c.intake_valve_diameter = 0.030;
    // Bigger exhaust valves
    c.exhaust_valve_max_lift = 0.010;
    c.exhaust_valve_diameter = 0.027;
    // Race CD table bump
    for v in c.intake_cd_table.iter_mut() { *v = (*v * 1.20).min(0.85); }
    for v in c.exhaust_cd_table.iter_mut() { *v = (*v * 1.15).min(0.80); }

    println!("\n=== Full-breathing race attack ===\n");
    let rpms = [10000.0, 12000.0, 13000.0, 13500.0, 14000.0, 14500.0];
    let mut peak = (0.0, 0.0);
    println!("{:>6}  {:>8}  {:>10}", "RPM", "VE", "Brake kW");
    for &rpm in &rpms {
        let (kw, ve, _) = run(&c, rpm, 8);
        println!("{:>6.0}  {:>8.3}  {:>10.2}", rpm, ve, kw);
        if kw > peak.0 { peak = (kw, rpm); }
    }
    println!();
    println!("Peak: {:.2} kW @ {:.0} RPM ({:.0}% of real 88 kW)", peak.0, peak.1, 100.0 * peak.0 / 88.0);
}

#[test]
#[ignore]
fn moderate_realistic_attack() {
    // Realistic race-tuned but physically plausible
    let base = load_v1_json(sdm26_path()).unwrap();
    let mut c = race_calibration(&base);
    set_runner(&mut c, 0.25, 0.045);     // 45mm runners (realistic race bell mouth)
    c.plenum_volume = 0.0050;             // 5L plenum
    // Slightly bumped valves
    c.intake_valve_max_lift = 0.0095;
    c.exhaust_valve_max_lift = 0.0085;
    // Modest cd bump
    for v in c.intake_cd_table.iter_mut() { *v = (*v * 1.10).min(0.75); }
    for v in c.exhaust_cd_table.iter_mut() { *v = (*v * 1.08).min(0.70); }

    println!("\n=== Moderate realistic CBR600 race config ===\n");
    let rpms = [8000.0, 10000.0, 12000.0, 13000.0, 13500.0, 14000.0];
    let mut peak = (0.0, 0.0);
    println!("{:>6}  {:>8}  {:>10}", "RPM", "VE", "Brake kW");
    for &rpm in &rpms {
        let (kw, ve, _) = run(&c, rpm, 8);
        println!("{:>6.0}  {:>8.3}  {:>10.2}", rpm, ve, kw);
        if kw > peak.0 { peak = (kw, rpm); }
    }
    println!();
    println!("Peak: {:.2} kW @ {:.0} RPM ({:.0}% of real 88 kW)", peak.0, peak.1, 100.0 * peak.0 / 88.0);
}
