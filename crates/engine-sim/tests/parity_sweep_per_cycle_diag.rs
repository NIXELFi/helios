//! Diagnostic: dump per-cycle IMEP/VE/EGT at SDM26 6000 RPM for 15
//! cycles, no convergence stop. Compares Rust against the Python
//! converged cycle 12 reported in docs/sdm26_sweep.json (IMEP 13.097).

use std::path::PathBuf;

use engine_sim::config::loader::load_v1_json;
use engine_sim::model::sdm26::{JunctionKind, SDM26Engine};

#[test]
fn dump_15_cycles_at_6000_rpm() {
    let cfg = load_v1_json(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("python_ref/configs/sdm26.json"),
    ).expect("load");
    let mut eng = SDM26Engine::new(cfg, JunctionKind::Stagnation);
    // 15 cycles, NO convergence stop (tol=0, min=0 with stop_at=false)
    let r = eng.run_single_rpm(6000.0, 15, false, 0.0, 0, false);
    eprintln!("{:>5} {:>9} {:>8} {:>8} {:>9}", "cycle", "imep", "ve", "egt", "p_ind_kW");
    for cs in &r.cycle_stats {
        eprintln!(
            "{:5} {:9.4} {:8.4} {:8.1} {:9.3}",
            cs.cycle, cs.imep_bar, cs.ve_atm, cs.egt_mean, cs.indicated_power_k_w,
        );
    }
    eprintln!("\nPython sdm26_sweep.json @ 6000 RPM: cycle 12 IMEP=13.097 VE=0.8202 EGT=1040.4 P_ind=39.25");
    eprintln!("                                    conv_cycle=11 (so cycle 11 IMEP triggered the rel<0.005 check)");
}
