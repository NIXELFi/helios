//! FMEP coefficient sensitivity. Default Chen-Flynn is (0.5, 0.1, 0.003).
//! Heywood Tab. 13.3 typical for "small engine" friction:
//!   A ≈ 0.3-0.5, B ≈ 0.04-0.05, C ≈ 5e-4 to 1e-3
//! Race motorcycle engines tend to the lower end of B and C.
//!
//! Run:
//!   cargo test --release -p cfd-core --test physics_fmep_check -- --ignored --nocapture

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
            CycleOutcome::Cycle(cs) => last = (cs.brake_power_k_w, cs.fmep_bar, cs.imep_bar),
            _ => break,
        }
    }
    last
}

#[test]
#[ignore]
fn fmep_value_at_rpm() {
    let base = load_v1_json(sdm26_path()).unwrap();
    println!("\n=== FMEP value at default config ===\n");
    println!("Formula: fmep = {:.2} + {:.3}·sp + {:.5}·sp²", base.fmep_a, base.fmep_b, base.fmep_c);

    for &rpm in &[6000.0, 9000.0, 12000.0, 13500.0_f64] {
        let sp = 2.0 * base.stroke * rpm / 60.0;
        let fmep = base.fmep_a + base.fmep_b * sp + base.fmep_c * sp * sp;
        println!("  RPM={:.0}  sp={:.2} m/s  FMEP={:.2} bar", rpm, sp, fmep);
    }
}

#[test]
#[ignore]
fn fmep_coefficient_sensitivity() {
    let base = load_v1_json(sdm26_path()).unwrap();
    let mut open = unrestricted(&base);
    open.intake_lift_flat_top_ramp = 0.25;
    open.exhaust_lift_flat_top_ramp = 0.25;

    println!("\n=== FMEP coefficient sensitivity (unrestricted + flat-top) ===\n");

    // Heywood Table 13.3 "passenger car typical" coefficients
    let coeffs = [
        ("legacy (0.5, 0.1, 0.003)",   (0.5_f64, 0.1, 0.003)),
        ("Heywood mid (0.4, 0.05, 5e-4)", (0.4, 0.05, 0.0005)),
        ("Heywood low (0.3, 0.04, 5e-4)", (0.3, 0.04, 0.0005)),
        ("motorcycle racing? (0.25, 0.04, 3e-4)", (0.25, 0.04, 0.0003)),
    ];

    for &rpm in &[8000.0, 10000.0, 12000.0, 13500.0_f64] {
        let sp = 2.0 * base.stroke * rpm / 60.0;
        println!("RPM = {:.0}  (sp = {:.2} m/s)", rpm, sp);
        println!("  {:>42}  {:>8}  {:>8}  {:>10}", "FMEP coeffs", "fmep", "imep", "Brake kW");
        for (label, (a, b, c)) in &coeffs {
            let mut cfg = open.clone();
            cfg.fmep_a = *a;
            cfg.fmep_b = *b;
            cfg.fmep_c = *c;
            let fmep_calc = a + b * sp + c * sp * sp;
            let (kw, fmep, imep) = run(&cfg, rpm, 6);
            println!("  {:>42}  {:>8.2}  {:>8.2}  {:>10.2}  (calc {:.2})", label, fmep, imep, kw, fmep_calc);
        }
        println!();
    }
}
