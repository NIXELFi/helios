//! Verify the new Heywood-shape AFR-dependent combustion-efficiency
//! produces a textbook rich-power peak around AFR 12-13 and lean
//! misfire below ~AFR 22.
//!
//! Pre-fix: brake power monotonically increased as AFR dropped, all
//! the way to AFR=9.5 (unphysical — no rich quench).
//! Post-fix (afr_eta_enabled=true): brake power should peak around
//! AFR 12.5 and drop sharply below ~11.
//!
//! Run:
//!   cargo test --release -p cfd-core --test physics_afr_eta_check -- --ignored --nocapture

use std::sync::atomic::AtomicBool;

use engine_sim::config::loader::load_v1_json;
use engine_sim::model::sdm26::{CycleLoopState, CycleOutcome, JunctionKind, SDM26Engine, SDM26Config};

fn sdm26_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../engine-sim/python_ref/configs/sdm26.json")
}

fn run(cfg: &SDM26Config, rpm: f64, n_cycles: u32) -> (f64, f64) {
    let cancel = AtomicBool::new(false);
    let mut eng = SDM26Engine::new(cfg.clone(), JunctionKind::Stagnation);
    let mut state = CycleLoopState::new(&mut eng);
    let mut last = (0.0, 0.0);
    for _ in 0..n_cycles {
        match eng.advance_one_cycle(rpm, &mut state, None, None, Some(&cancel)) {
            CycleOutcome::Cycle(cs) => last = (cs.imep_bar, cs.brake_power_k_w),
            _ => break,
        }
    }
    last
}

#[test]
#[ignore]
fn afr_sweep_legacy_vs_rich_quench() {
    let base = load_v1_json(sdm26_path()).unwrap();

    println!("\n=== AFR sweep: legacy (monotone) vs Heywood-shape ===\n");
    println!("Real engines peak power around AFR 12.5 due to rich-quench cliff below ~11.\n");

    let afrs: Vec<f64> = (95..=220).step_by(5).map(|x| x as f64 / 10.0).collect();
    println!("{:>6}  {:>10}  {:>10}  {:>10}", "AFR", "OFF (kW)", "ON (kW)", "Δ kW");

    let mut peak_off = (0.0, 0.0);
    let mut peak_on = (0.0, 0.0);
    for afr in afrs {
        let mut c_off = base.clone();
        c_off.afr_target = afr;
        c_off.afr_eta_enabled = false;
        let (_, kw_off) = run(&c_off, 8000.0, 6);

        let mut c_on = base.clone();
        c_on.afr_target = afr;
        c_on.afr_eta_enabled = true;
        let (_, kw_on) = run(&c_on, 8000.0, 6);

        if kw_off > peak_off.0 { peak_off = (kw_off, afr); }
        if kw_on > peak_on.0 { peak_on = (kw_on, afr); }

        println!("{:>6.1}  {:>10.3}  {:>10.3}  {:>+10.3}", afr, kw_off, kw_on, kw_on - kw_off);
    }
    println!();
    println!("Peak power OFF: {:.2} kW @ AFR={:.1}", peak_off.0, peak_off.1);
    println!("Peak power ON:  {:.2} kW @ AFR={:.1}", peak_on.0, peak_on.1);
    println!();
    println!("Expected ON peak: AFR ~12-13 (real engine textbook behavior).");
}
