//! MBT spark advance vs RPM — does the simulator correctly shift MBT
//! with engine speed? Real engines need MORE advance at higher RPM
//! because the same crank angle corresponds to less time, so burn must
//! start sooner.
//!
//! Run:
//!   cargo test --release -p cfd-core --test physics_mbt_rpm -- --ignored --nocapture

use std::sync::atomic::AtomicBool;

use engine_sim::config::loader::load_v1_json;
use engine_sim::model::sdm26::{CycleLoopState, CycleOutcome, JunctionKind, SDM26Engine, SDM26Config};

fn sdm26_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../engine-sim/python_ref/configs/sdm26.json")
}

fn run_imep(cfg: &SDM26Config, rpm: f64, n_cycles: u32) -> f64 {
    let cancel = AtomicBool::new(false);
    let mut eng = SDM26Engine::new(cfg.clone(), JunctionKind::Stagnation);
    let mut state = CycleLoopState::new(&mut eng);
    let mut imep = 0.0;
    for _ in 0..n_cycles {
        match eng.advance_one_cycle(rpm, &mut state, None, None, Some(&cancel)) {
            CycleOutcome::Cycle(cs) => imep = cs.imep_bar,
            _ => break,
        }
    }
    imep
}

#[test]
#[ignore]
fn mbt_vs_rpm() {
    let base = load_v1_json(sdm26_path()).unwrap();

    println!("\n=== MBT spark advance vs RPM ===\n");
    println!("Sweep spark from 5° to 40° BTDC at multiple RPMs; report the MBT angle.\n");
    println!("Real engines: MBT advances ~5-10° from idle to redline as burn time matters more.\n");

    let rpms = [4000.0, 6000.0, 8000.0, 10000.0, 12000.0];
    let sparks: Vec<f64> = (5..=40).step_by(2).map(|x| x as f64).collect();

    println!("{:>8}  | {}", "RPM",
        sparks.iter().map(|s| format!("{:>5.0}°", s)).collect::<Vec<_>>().join(" "));
    println!("{:->8}  | {}", "", "-".repeat(sparks.len() * 7));

    let mut mbts: Vec<(f64, f64)> = Vec::new();
    for &rpm in &rpms {
        let row: Vec<f64> = sparks.iter().map(|&s| {
            let mut c = base.clone();
            c.spark_advance = s;
            run_imep(&c, rpm, 6)
        }).collect();
        // Find peak.
        let (mbt_idx, mbt_imep) = row.iter().enumerate()
            .fold((0, f64::NEG_INFINITY), |(bi, bv), (i, &v)| {
                if v > bv { (i, v) } else { (bi, bv) }
            });
        let mbt_spark = sparks[mbt_idx];
        mbts.push((rpm, mbt_spark));

        let row_str: String = row.iter().map(|v| format!("{:>5.2} ", v)).collect();
        println!("{:>8.0}  | {}", rpm, row_str);
        println!("            MBT={}° BTDC (IMEP={:.2})", mbt_spark, mbt_imep);
    }

    println!("\nMBT-vs-RPM trend:");
    for (rpm, mbt) in &mbts {
        println!("  RPM = {:.0}  →  MBT = {}° BTDC", rpm, mbt);
    }

    // Sanity: MBT should increase (or at minimum NOT decrease) with RPM.
    println!("\nExpected: MBT increases monotonically with RPM");
    let mut violations = 0;
    for w in mbts.windows(2) {
        if w[1].1 + 1.0 < w[0].1 {
            violations += 1;
            println!("  ⚠ MBT decreased from RPM={:.0} ({}°) to RPM={:.0} ({}°)",
                w[0].0, w[0].1, w[1].0, w[1].1);
        }
    }
    if violations == 0 {
        println!("  ✓ MBT monotone non-decreasing with RPM");
    }
}
