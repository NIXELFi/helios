//! Engine-level parity: full SDM26 multi-cycle sweep vs Python golden.

mod common;
use common::*;

use engine_sim::model::sdm26::{JunctionKind, SDM26Config, SDM26Engine};

#[test]
fn engine_5cycle_parity() {
    let fx = load_fixture("engine_5cycle");
    let tol = tolerance(&fx);
    for case in fx["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let inp = &case["inputs"];
        let out = &case["outputs"];
        let rpm = f64_val(&inp["rpm"]);
        let n_cycles = inp["n_cycles"].as_u64().unwrap() as usize;
        let kind = match inp["junction_type"].as_str().unwrap() {
            "stagnation" => JunctionKind::Stagnation,
            "characteristic" => JunctionKind::Characteristic,
            other => panic!("unknown junction_type {other}"),
        };
        let cfg = SDM26Config::default();
        let mut eng = SDM26Engine::new(cfg, kind);
        let result = eng.run_single_rpm(rpm, n_cycles, false, 0.005, 3, false);
        let want_stats = out["cycle_stats"].as_array().unwrap();
        assert_eq!(result.cycle_stats.len(), want_stats.len(),
            "{name}: cycle count mismatch  got={} want={}",
            result.cycle_stats.len(), want_stats.len());
        for (i, (got, want)) in result.cycle_stats.iter().zip(want_stats.iter()).enumerate() {
            let lbl = |k: &str| format!("{name}.cycle[{i}].{k}");
            assert_close(&lbl("imep_bar"), got.imep_bar, f64_val(&want["imep_bar"]), &tol);
            assert_close(&lbl("bmep_bar"), got.bmep_bar, f64_val(&want["bmep_bar"]), &tol);
            assert_close(&lbl("fmep_bar"), got.fmep_bar, f64_val(&want["fmep_bar"]), &tol);
            assert_close(&lbl("ve_atm"), got.ve_atm, f64_val(&want["ve_atm"]), &tol);
            assert_close(&lbl("mass_total"), got.mass_total, f64_val(&want["mass_total"]), &tol);
            assert_close(&lbl("mass_drift"), got.mass_drift, f64_val(&want["mass_drift"]), &tol);
            assert_close(&lbl("mass_in"), got.mass_in_restrictor, f64_val(&want["mass_in_restrictor"]), &tol);
            assert_close(&lbl("mass_out"), got.mass_out_collector, f64_val(&want["mass_out_collector"]), &tol);
            assert_close(&lbl("net_port_flow"), got.net_port_flow, f64_val(&want["net_port_flow"]), &tol);
            assert_close(&lbl("nonconservation"), got.nonconservation, f64_val(&want["nonconservation"]), &tol);
            assert_close(&lbl("intake_g"), got.intake_mass_per_cycle_g, f64_val(&want["intake_mass_per_cycle_g"]), &tol);
            assert_close(&lbl("f_residual"), got.f_residual, f64_val(&want["f_residual"]), &tol);
            assert_close(&lbl("ind_power_kW"), got.indicated_power_k_w, f64_val(&want["indicated_power_kW"]), &tol);
            assert_close(&lbl("brake_power_kW"), got.brake_power_k_w, f64_val(&want["brake_power_kW"]), &tol);
            assert_close(&lbl("wheel_power_kW"), got.wheel_power_k_w, f64_val(&want["wheel_power_kW"]), &tol);
            assert_close(&lbl("ind_torque_Nm"), got.indicated_torque_nm, f64_val(&want["indicated_torque_Nm"]), &tol);
            assert_close(&lbl("brake_torque_Nm"), got.brake_torque_nm, f64_val(&want["brake_torque_Nm"]), &tol);
            assert_close(&lbl("wheel_torque_Nm"), got.wheel_torque_nm, f64_val(&want["wheel_torque_Nm"]), &tol);
            assert_close(&lbl("EGT_mean"), got.egt_mean, f64_val(&want["EGT_mean"]), &tol);
        }
        assert_eq!(result.step_count as i64, out["step_count"].as_i64().unwrap(),
            "{name}: step_count mismatch");
    }
}
