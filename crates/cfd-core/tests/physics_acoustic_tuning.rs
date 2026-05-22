//! Hands-on acoustic tuning study.
//!
//! Predicts intake-runner tuned RPM via the classical quarter-wave model
//! (RPM_peak ≈ 7.5 · a / L, where a is sound speed in the intake gas
//! and L is runner length), then sweeps the simulator and checks where
//! peak VE actually lands.
//!
//! For an ideal-gas (gamma=1.4, R=287) at the SDM26's intake wall
//! temperature of 325 K, sound speed is a = sqrt(1.4 · 287 · 325) ≈
//! 361.1 m/s. So:
//!     L = 0.20 m  →  predicted RPM_peak ≈ 13540
//!     L = 0.25 m  →  ≈ 10830
//!     L = 0.30 m  →  ≈  9030
//!     L = 0.40 m  →  ≈  6770
//!     L = 0.50 m  →  ≈  5420
//!
//! Caveats:
//!   - The classical formula assumes a quarter-wave tube with rigid
//!     closed end at the valve and open at the plenum. Real runners
//!     have a finite-volume plenum (Helmholtz effects shift this) and
//!     the valve isn't fully closed during the intake stroke.
//!   - Effective acoustic length includes an end-correction (~0.6·R for
//!     an unflanged open end), so the "true" L is slightly longer than
//!     the geometric length.
//!   - The 1D simulator's runner ends are characteristic boundaries
//!     coupled to the plenum lumped node; reflections aren't perfectly
//!     "open".
//!   - We expect agreement within ~15-25% on RPM_peak.
//!
//! Invoke with:
//!   cargo test --release -p cfd-core --test physics_acoustic_tuning \
//!     -- --ignored --nocapture

use std::sync::atomic::AtomicBool;

use engine_sim::config::loader::load_v1_json;
use engine_sim::model::sdm26::{CycleLoopState, CycleOutcome, JunctionKind, SDM26Engine};

const N_CYCLES_WARMUP: u32 = 6;

fn sdm26_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../engine-sim/python_ref/configs/sdm26.json")
}

/// Quarter-wave intake-runner tuning prediction.
fn predicted_peak_rpm(runner_length_m: f64, gas_temp_k: f64) -> f64 {
    let gamma = 1.4_f64;
    let r_specific = 287.0_f64;
    let a = (gamma * r_specific * gas_temp_k).sqrt();
    7.5 * a / runner_length_m
}

/// Run a single-RPM simulation for `n_cycles` and return the LAST cycle's
/// VE_atm value. Uses a freshly-warm engine each call.
fn run_ve(cfg: &engine_sim::model::sdm26::SDM26Config, rpm: f64) -> f64 {
    let cancel = AtomicBool::new(false);
    let mut eng = SDM26Engine::new(cfg.clone(), JunctionKind::Stagnation);
    let mut state = CycleLoopState::new(&mut eng);
    let mut last_ve = 0.0;
    for _ in 0..N_CYCLES_WARMUP {
        match eng.advance_one_cycle(rpm, &mut state, None, None, Some(&cancel)) {
            CycleOutcome::Cycle(cs) => last_ve = cs.ve_atm,
            _ => break,
        }
    }
    last_ve
}

/// Apply a uniform runner-length override to all 4 intake runners.
fn set_intake_runner_length(cfg: &mut engine_sim::model::sdm26::SDM26Config, l: f64) {
    cfg.runner_length = l;
    if let Some(arr) = cfg.runner_lengths.as_mut() {
        for v in arr.iter_mut() {
            *v = l;
        }
    } else {
        cfg.runner_lengths = Some(vec![l; cfg.n_cylinders]);
    }
}

#[test]
#[ignore]
fn acoustic_tuning_intake_runner() {
    let base_cfg = load_v1_json(sdm26_path()).expect("load SDM26");
    let lengths_m: Vec<f64> = vec![0.15, 0.18, 0.21, 0.245, 0.28, 0.32, 0.36, 0.40, 0.45, 0.50];
    let rpms: Vec<f64> = (4000..=13000).step_by(500).map(|x| x as f64).collect();
    let gas_t = 325.0; // intake wall T from SDM26 config

    println!("\n=== Intake runner acoustic tuning sweep ===");
    println!("predicted RPM_peak = 7.5 · a / L  with a = √(γRT) at T={gas_t}K → a≈{:.1} m/s",
        (1.4_f64 * 287.0 * gas_t).sqrt());
    println!();
    println!("{:>8}  {:>10}  {:>10}  {:>8}  {:>10}",
        "L (mm)", "RPM_pred", "RPM_obs", "VE_peak", "abs_err_pct");

    let mut results: Vec<(f64, f64, f64, f64)> = Vec::new();

    for &l in &lengths_m {
        let mut cfg = base_cfg.clone();
        set_intake_runner_length(&mut cfg, l);

        // Sweep RPM, record VE.
        let mut best_rpm = 0.0;
        let mut best_ve = -1.0;
        let mut ve_curve: Vec<(f64, f64)> = Vec::new();
        for &rpm in &rpms {
            let ve = run_ve(&cfg, rpm);
            ve_curve.push((rpm, ve));
            if ve > best_ve {
                best_ve = ve;
                best_rpm = rpm;
            }
        }

        let predicted = predicted_peak_rpm(l, gas_t);
        let err_pct = 100.0 * (best_rpm - predicted).abs() / predicted;
        results.push((l, predicted, best_rpm, err_pct));

        println!("{:>8.1}  {:>10.0}  {:>10.0}  {:>8.3}  {:>10.1}",
            l * 1000.0, predicted, best_rpm, best_ve, err_pct);

        // Also print the curve for visibility
        let curve_str: String = ve_curve.iter()
            .map(|(r, v)| format!("{:.0}={:.3}", r, v))
            .collect::<Vec<_>>().join("  ");
        println!("    curve: {}", curve_str);
    }

    // Summary: how well does the quarter-wave model predict?
    let mean_err: f64 = results.iter().map(|(_, _, _, e)| *e).sum::<f64>() / results.len() as f64;
    let max_err: f64 = results.iter().map(|(_, _, _, e)| *e).fold(0.0_f64, f64::max);
    println!("\nSummary:");
    println!("  mean abs error (predicted vs observed RPM_peak): {mean_err:.1}%");
    println!("  max  abs error: {max_err:.1}%");
    println!();

    // Loose assertion: the trend must hold — RPM_peak monotonically decreases as L increases.
    let observed: Vec<(f64, f64)> = results.iter().map(|(l, _, r, _)| (*l, *r)).collect();
    for w in observed.windows(2) {
        assert!(w[1].1 <= w[0].1 + 100.0,  // allow 100 RPM slack at flat regions
            "expected RPM_peak ↓ as L ↑, but L={:.3}m→{} and L={:.3}m→{}",
            w[0].0, w[0].1, w[1].0, w[1].1);
    }
}
