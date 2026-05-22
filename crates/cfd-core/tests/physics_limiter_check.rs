//! Verify that wiring cfg.limiter through to muscl_hancock_step actually
//! changes behavior. Pre-fix: all 3 limiters produced bit-identical results.
//! Post-fix: should see measurable differences in IMEP and VE at acoustic-
//! sensitive RPMs.
//!
//! Run:
//!   cargo test --release -p cfd-core --test physics_limiter_check -- --ignored --nocapture

use std::sync::atomic::AtomicBool;

use engine_sim::config::loader::load_v1_json;
use engine_sim::model::sdm26::{CycleLoopState, CycleOutcome, JunctionKind, SDM26Engine, SDM26Config};

fn sdm26_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../engine-sim/python_ref/configs/sdm26.json")
}

fn run(cfg: &SDM26Config, rpm: f64, n_cycles: u32) -> (f64, f64, f64) {
    let cancel = AtomicBool::new(false);
    let mut eng = SDM26Engine::new(cfg.clone(), JunctionKind::Stagnation);
    let mut state = CycleLoopState::new(&mut eng);
    let mut last = (0.0, 0.0, 0.0);
    for _ in 0..n_cycles {
        match eng.advance_one_cycle(rpm, &mut state, None, None, Some(&cancel)) {
            CycleOutcome::Cycle(cs) => last = (cs.imep_bar, cs.ve_atm, cs.brake_power_k_w),
            _ => break,
        }
    }
    last
}

#[test]
#[ignore]
fn limiter_now_makes_difference() {
    let base = load_v1_json(sdm26_path()).unwrap();
    let rpms = [4000.0, 8000.0, 12000.0];

    println!("\n=== Slope limiter sensitivity (post-fix) ===\n");
    println!("Pre-fix: all 3 limiters bit-identical (dead knob)");
    println!("Post-fix: van Leer and Superbee should produce different VE/IMEP\n");

    for &rpm in &rpms {
        println!("RPM = {:.0}", rpm);
        println!("  {:>12}  {:>10}  {:>10}  {:>10}", "limiter", "IMEP", "VE", "Brake kW");
        let mut results: Vec<(&str, (f64, f64, f64))> = Vec::new();
        for (label, lim) in [("minmod(0)", 0), ("van Leer(1)", 1), ("superbee(2)", 2)] {
            let mut c = base.clone();
            c.limiter = lim;
            let r = run(&c, rpm, 6);
            results.push((label, r));
            println!("  {:>12}  {:>10.4}  {:>10.4}  {:>10.4}", label, r.0, r.1, r.2);
        }
        // Verify differences
        let imep_minmod = results[0].1.0;
        let imep_vanleer = results[1].1.0;
        let imep_superbee = results[2].1.0;
        let rel_vl = (imep_vanleer - imep_minmod).abs() / imep_minmod.max(1e-9);
        let rel_sb = (imep_superbee - imep_minmod).abs() / imep_minmod.max(1e-9);
        println!("  Δ vs minmod: van Leer {:.4}%, superbee {:.4}%", 100.0 * rel_vl, 100.0 * rel_sb);
        println!();
    }
}
