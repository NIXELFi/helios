//! Long-run convergence parity: SDM25 + SDM26 25-cycle runs with
//! stop_at_convergence=true.
//!
//! Verifies two things at once:
//!   1. Per-cycle stats agree with Python through cycle 20+ (long-run
//!      drift stays within ENGINE_TOLERANCE).
//!   2. Rust's converged_cycle pick matches Python's converged_cycle.

mod common;
use common::*;

use engine_sim::config::loader::load_v1_json;
use engine_sim::model::sdm26::{JunctionKind, SDM26Engine};

fn run_convergence_fixture(config_name: &str) {
    let fixture_name = format!("engine_convergence_{config_name}_25cyc");
    let fx = load_fixture(&fixture_name);
    let tol = tolerance(&fx);
    let case = &fx["cases"][0];
    let inp = &case["inputs"];
    let out = &case["outputs"];

    let rpm = f64_val(&inp["rpm"]);
    let n_cycles_max = inp["n_cycles_max"].as_u64().unwrap() as usize;
    let tol_imep = f64_val(&inp["convergence_tol_imep"]);
    let min_cycles = inp["convergence_min_cycles"].as_u64().unwrap() as usize;
    assert_eq!(inp["junction_type"].as_str().unwrap(), "stagnation");

    let cfg = load_v1_json(config_path_for(config_name)).expect("load_v1_json");
    let mut eng = SDM26Engine::new(cfg, JunctionKind::Stagnation);
    let result = eng.run_single_rpm(
        rpm, n_cycles_max, false, tol_imep, min_cycles, /* stop_at_convergence */ true,
    );

    let want_stats = out["cycle_stats"].as_array().unwrap();
    assert_eq!(
        result.cycle_stats.len(),
        want_stats.len(),
        "{fixture_name}: cycle count mismatch  got={} want={}",
        result.cycle_stats.len(),
        want_stats.len()
    );
    for (i, (got, want)) in result.cycle_stats.iter().zip(want_stats.iter()).enumerate() {
        assert_cycle_stats_close(
            &format!("{fixture_name}.cycle[{i}]"),
            got,
            want,
            &tol,
        );
    }
    assert_eq!(
        result.step_count as i64,
        out["step_count"].as_i64().unwrap(),
        "{fixture_name}: step_count mismatch"
    );
    assert_eq!(
        result.converged_cycle,
        out["converged_cycle"].as_i64().unwrap(),
        "{fixture_name}: converged_cycle mismatch  got={} want={}",
        result.converged_cycle,
        out["converged_cycle"].as_i64().unwrap()
    );
}

#[test]
fn sdm25_25cyc_convergence() {
    run_convergence_fixture("sdm25");
}

#[test]
fn sdm26_25cyc_convergence() {
    run_convergence_fixture("sdm26");
}
