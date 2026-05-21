//! Engine-level parity matrix: 2 configs * 2 junctions * 5 RPMs.
//!
//! Each fixture is a 5-cycle SDM run captured from the pinned Python
//! tree at `python_ref/`. Tolerance is ENGINE_TOLERANCE (rtol=1e-6,
//! atol=1e-9) — same as the original `parity_engine.rs`.
//!
//! Macro-generated tests so a failure points at the specific (config,
//! junction, rpm) cell rather than a single big test.

mod common;
use common::*;

use engine_sim::config::loader::load_v1_json;
use engine_sim::model::sdm26::SDM26Engine;

fn run_matrix_fixture(config_name: &str, junction: &str, rpm_label: &str) {
    let fixture_name = format!(
        "engine_matrix_{config_name}_{junction}_{rpm_label}_5cyc"
    );
    let fx = load_fixture(&fixture_name);
    let tol = tolerance(&fx);
    let case = &fx["cases"][0];
    let inp = &case["inputs"];
    let out = &case["outputs"];

    let rpm = f64_val(&inp["rpm"]);
    let n_cycles = inp["n_cycles"].as_u64().unwrap() as usize;
    let kind = junction_kind_from_str(inp["junction_type"].as_str().unwrap());

    let cfg = load_v1_json(config_path_for(config_name))
        .expect("load_v1_json");
    let mut eng = SDM26Engine::new(cfg, kind);
    let result = eng.run_single_rpm(rpm, n_cycles, false, 0.005, 3, false);

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
}

macro_rules! matrix_test {
    ($name:ident, $config:literal, $junction:literal, $rpm:literal) => {
        #[test]
        fn $name() {
            run_matrix_fixture($config, $junction, $rpm);
        }
    };
}

// 2 configs * 2 junctions * 5 RPMs = 20 tests
matrix_test!(sdm25_stagnation_4000,      "sdm25", "stagnation",     "4000");
matrix_test!(sdm25_stagnation_6000,      "sdm25", "stagnation",     "6000");
matrix_test!(sdm25_stagnation_8000,      "sdm25", "stagnation",     "8000");
matrix_test!(sdm25_stagnation_10000,     "sdm25", "stagnation",     "10000");
matrix_test!(sdm25_stagnation_12000,     "sdm25", "stagnation",     "12000");
matrix_test!(sdm25_characteristic_4000,  "sdm25", "characteristic", "4000");
matrix_test!(sdm25_characteristic_6000,  "sdm25", "characteristic", "6000");
matrix_test!(sdm25_characteristic_8000,  "sdm25", "characteristic", "8000");
matrix_test!(sdm25_characteristic_10000, "sdm25", "characteristic", "10000");
matrix_test!(sdm25_characteristic_12000, "sdm25", "characteristic", "12000");
matrix_test!(sdm26_stagnation_4000,      "sdm26", "stagnation",     "4000");
matrix_test!(sdm26_stagnation_6000,      "sdm26", "stagnation",     "6000");
matrix_test!(sdm26_stagnation_8000,      "sdm26", "stagnation",     "8000");
matrix_test!(sdm26_stagnation_10000,     "sdm26", "stagnation",     "10000");
matrix_test!(sdm26_stagnation_12000,     "sdm26", "stagnation",     "12000");
matrix_test!(sdm26_characteristic_4000,  "sdm26", "characteristic", "4000");
matrix_test!(sdm26_characteristic_6000,  "sdm26", "characteristic", "6000");
matrix_test!(sdm26_characteristic_8000,  "sdm26", "characteristic", "8000");
matrix_test!(sdm26_characteristic_10000, "sdm26", "characteristic", "10000");
matrix_test!(sdm26_characteristic_12000, "sdm26", "characteristic", "12000");
