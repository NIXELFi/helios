//! Full RPM curves: default config vs re-tuned config vs published CBR600
//! data. Final validation table for the synthesis report.
//!
//! Run:
//!   cargo test --release -p cfd-core --test physics_full_curves -- --ignored --nocapture

use std::sync::atomic::AtomicBool;

use engine_sim::config::loader::load_v1_json;
use engine_sim::model::sdm26::{CycleLoopState, CycleOutcome, JunctionKind, SDM26Engine, SDM26Config};

fn sdm26_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../engine-sim/python_ref/configs/sdm26.json")
}

fn run_metrics(cfg: &SDM26Config, rpm: f64, n_cycles: u32) -> (f64, f64, f64, f64, f64) {
    // brake_power_kW, brake_torque_Nm, imep_bar, ve_atm, egt_K
    let cancel = AtomicBool::new(false);
    let mut eng = SDM26Engine::new(cfg.clone(), JunctionKind::Stagnation);
    let mut state = CycleLoopState::new(&mut eng);
    let mut last = (0.0, 0.0, 0.0, 0.0, 0.0);
    for _ in 0..n_cycles {
        match eng.advance_one_cycle(rpm, &mut state, None, None, Some(&cancel)) {
            CycleOutcome::Cycle(cs) => {
                last = (cs.brake_power_k_w, cs.brake_torque_nm, cs.imep_bar, cs.ve_atm, cs.egt_mean);
            }
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
fn full_rpm_curves() {
    let base = load_v1_json(sdm26_path()).unwrap();

    // Retuned: shorter burn + slightly richer + slightly longer runner + slightly looser Woschni.
    // (No spark change — default IS approximately MBT at peak-power RPM.)
    let mut retuned = base.clone();
    retuned.combustion_duration = 35.0;
    retuned.afr_target = 12.5;
    set_runner_length(&mut retuned, 0.30);
    retuned.woschni_c1_combustion *= 0.85;

    println!("\n=== Full RPM curves: default vs realistic re-tune ===\n");
    println!("Retune deltas: burn 50→35°, AFR 13.1→12.5, runner 0.245→0.30 m, Woschni × 0.85\n");
    println!("Real-world FSAE CBR600 (20mm restrictor): peak 41-52 kW, peak torque ~50 Nm @ ~10k RPM\n");

    println!("{:>6}  | {:>22}  | {:>22}  | {:>10}", "RPM",
        "DEFAULT (kW / Nm / VE)", "RETUNE  (kW / Nm / VE)", "Δ kW");
    println!("{:->6}  | {:->22}  | {:->22}  | {:->10}", "", "", "", "");

    let rpms = [4000.0, 5000.0, 6000.0, 7000.0, 8000.0, 9000.0, 10000.0, 11000.0, 12000.0, 13000.0];

    let mut def_peak = (0.0, 0.0); // (kW, rpm)
    let mut ret_peak = (0.0, 0.0);

    for &rpm in &rpms {
        let (kw1, t1, _, ve1, _) = run_metrics(&base, rpm, 6);
        let (kw2, t2, _, ve2, _) = run_metrics(&retuned, rpm, 6);
        if kw1 > def_peak.0 { def_peak = (kw1, rpm); }
        if kw2 > ret_peak.0 { ret_peak = (kw2, rpm); }
        println!("{:>6.0}  |  {:>6.2} / {:>5.1} / {:>5.3}  |  {:>6.2} / {:>5.1} / {:>5.3}  |  {:>+8.2}",
            rpm, kw1, t1, ve1, kw2, t2, ve2, kw2 - kw1);
    }
    println!();
    println!("DEFAULT peak: {:.2} kW @ {:.0} RPM", def_peak.0, def_peak.1);
    println!("RETUNE peak:  {:.2} kW @ {:.0} RPM  ({:+.1}% gain)",
        ret_peak.0, ret_peak.1, 100.0 * (ret_peak.0 - def_peak.0) / def_peak.0);
    println!();
    println!("Real-world bottom (typical): 41 kW @ ~11000 RPM");
    println!("Real-world top    (well-tuned): 52 kW @ ~11500 RPM");
    let gap_default = (41.0 - def_peak.0) / 41.0;
    let gap_retune  = (41.0 - ret_peak.0) / 41.0;
    println!();
    println!("Gap to real-world floor (41 kW):");
    println!("  default: {:+.1}%   retune: {:+.1}%", -100.0 * gap_default, -100.0 * gap_retune);
}
