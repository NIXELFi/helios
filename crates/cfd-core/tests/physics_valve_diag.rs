//! Diagnose where the VE ceiling comes from in the simulator. Two
//! suspects identified by reading the valve code:
//!   1. Cd table caps at 0.57 at high L/D — a typical port-developed
//!      race head can hit 0.65-0.75
//!   2. sine² lift profile gives mean lift = 0.5 × max_lift (area
//!      under the cam curve). Real cam profiles can give 0.65-0.75
//!      due to flatter peak hold.
//!
//! This test does NOT touch the model — it sweeps the existing config
//! to see how sensitive VE is to higher peak-lift discharge coef.
//!
//! Run:
//!   cargo test --release -p cfd-core --test physics_valve_diag -- --ignored --nocapture

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

fn run(cfg: &SDM26Config, rpm: f64, n_cycles: u32) -> (f64, f64) {
    let cancel = AtomicBool::new(false);
    let mut eng = SDM26Engine::new(cfg.clone(), JunctionKind::Stagnation);
    let mut state = CycleLoopState::new(&mut eng);
    let mut last = (0.0, 0.0);
    for _ in 0..n_cycles {
        match eng.advance_one_cycle(rpm, &mut state, None, None, Some(&cancel)) {
            CycleOutcome::Cycle(cs) => last = (cs.ve_atm, cs.brake_power_k_w),
            _ => break,
        }
    }
    last
}

#[test]
#[ignore]
fn cd_table_sensitivity() {
    let base = load_v1_json(sdm26_path()).unwrap();
    let open = unrestricted(&base);

    println!("\n=== Intake-valve Cd(L/D) table sensitivity (unrestricted) ===\n");
    println!("Default cd_table at L/D=0.30 caps at 0.57. Race ports can hit 0.65-0.75.\n");

    // Build alternative cd tables by scaling
    let scales = [1.0, 1.10, 1.20, 1.30, 1.40];
    let rpms = [8000.0, 10000.0, 12000.0, 13500.0];

    println!("{:>6}  {:>8}  {:>8}  {:>8}  {:>8}  {:>8}",
        "RPM", "1.00×", "1.10×", "1.20×", "1.30×", "1.40×");
    println!("{:->6}  {:->8}  {:->8}  {:->8}  {:->8}  {:->8}",
        "", "", "", "", "", "");

    for &rpm in &rpms {
        let mut row_ve = Vec::new();
        let mut row_kw = Vec::new();
        for &s in &scales {
            let mut c = open.clone();
            // Scale the intake CD table
            for v in c.intake_cd_table.iter_mut() { *v = (*v * s).min(0.95); }
            // Scale the exhaust CD table by same factor
            for v in c.exhaust_cd_table.iter_mut() { *v = (*v * s).min(0.95); }
            let (ve, kw) = run(&c, rpm, 6);
            row_ve.push(ve);
            row_kw.push(kw);
        }
        let s_ve: String = row_ve.iter().map(|v| format!("{:>8.3}", v)).collect();
        let s_kw: String = row_kw.iter().map(|v| format!("{:>8.2}", v)).collect();
        println!("{:>6.0}  {:>8}  VE", rpm, "");
        println!("        {}", s_ve);
        println!("        {}  kW", s_kw);
    }
}

#[test]
#[ignore]
fn cd_table_inspection() {
    let base = load_v1_json(sdm26_path()).unwrap();
    println!("\n=== Bundled SDM26 valve cd tables ===\n");
    println!("Intake: l/d → cd");
    for (i, &cd) in base.intake_cd_table.iter().enumerate() {
        let ld = base.intake_ld_table[i];
        println!("  {:.3}  →  {:.3}", ld, cd);
    }
    println!("\nExhaust: l/d → cd");
    for (i, &cd) in base.exhaust_cd_table.iter().enumerate() {
        let ld = base.exhaust_ld_table[i];
        println!("  {:.3}  →  {:.3}", ld, cd);
    }
    println!("\nMax lift / diameter:");
    println!("  intake : {:.3} / {:.3} = {:.3}",
        base.intake_valve_max_lift, base.intake_valve_diameter,
        base.intake_valve_max_lift / base.intake_valve_diameter);
    println!("  exhaust: {:.3} / {:.3} = {:.3}",
        base.exhaust_valve_max_lift, base.exhaust_valve_diameter,
        base.exhaust_valve_max_lift / base.exhaust_valve_diameter);
}
