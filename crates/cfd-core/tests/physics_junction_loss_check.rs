//! Verify intake_junction_loss_coef now affects Stagnation-junction VE.
//! Pre-fix: sweep produced bit-identical results across loss values.
//! Post-fix: VE should decrease as loss coef increases.

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
fn junction_loss_now_makes_difference() {
    let base = load_v1_json(sdm26_path()).unwrap();
    println!("\n=== Intake junction loss-coef sensitivity (post-fix) ===\n");
    println!("Pre-fix: bit-identical results under Stagnation junction.");
    println!("Post-fix: VE should decrease monotonically with K.\n");

    for rpm in [6000.0, 9000.0, 12000.0] {
        println!("RPM = {:.0}", rpm);
        println!("  {:>6}  {:>10}  {:>10}  {:>10}", "K", "IMEP", "VE", "Brake kW");
        for k in [0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 5.0] {
            let mut c = base.clone();
            c.intake_junction_loss_coef = k;
            let r = run(&c, rpm, 6);
            println!("  {:>6.1}  {:>10.4}  {:>10.4}  {:>10.4}", k, r.0, r.1, r.2);
        }
        println!();
    }
}
