//! Shared parity-fixture loader / comparator.
//!
//! Fixtures live at `crates/engine-sim/fixtures/parity/*.json`; the
//! Python capture script (`python_ref/scripts/capture_goldens.py`) is
//! the source of truth.

use serde_json::Value;
use std::fs;
use std::path::PathBuf;

pub fn load_fixture(name: &str) -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let path = root.join("fixtures").join("parity").join(format!("{name}.json"));
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("missing fixture {path:?}: {e}"));
    serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("bad JSON in {path:?}: {e}"))
}

pub struct Tolerance {
    pub rtol: f64,
    pub atol: f64,
}

pub fn tolerance(fixture: &Value) -> Tolerance {
    let t = &fixture["tolerance"];
    Tolerance {
        rtol: t["rtol"].as_f64().expect("tolerance.rtol"),
        atol: t["atol"].as_f64().expect("tolerance.atol"),
    }
}

#[track_caller]
pub fn assert_close(label: &str, got: f64, want: f64, tol: &Tolerance) {
    if got.is_nan() || want.is_nan() {
        assert!(got.is_nan() && want.is_nan(),
            "{label}: NaN mismatch  got={got}  want={want}");
        return;
    }
    let diff = (got - want).abs();
    let lim = tol.atol + tol.rtol * want.abs();
    assert!(
        diff <= lim,
        "{label}: |got-want|={diff:e} > atol+rtol*|want|={lim:e}  got={got}  want={want}",
    );
}

#[allow(dead_code)]
#[track_caller]
pub fn assert_close_slice(label: &str, got: &[f64], want: &[f64], tol: &Tolerance) {
    assert_eq!(got.len(), want.len(),
        "{label}: length mismatch  got={}  want={}", got.len(), want.len());
    for (i, (g, w)) in got.iter().zip(want.iter()).enumerate() {
        assert_close(&format!("{label}[{i}]"), *g, *w, tol);
    }
}

#[allow(dead_code)]
pub fn f64_array(v: &Value) -> Vec<f64> {
    v.as_array().expect("array").iter()
        .map(|x| x.as_f64().expect("f64")).collect()
}

#[allow(dead_code)]
pub fn f64_val(v: &Value) -> f64 {
    v.as_f64().expect("f64")
}

#[allow(dead_code)]
#[track_caller]
pub fn assert_cycle_stats_close(
    label: &str,
    got: &engine_sim::model::sdm26::CycleStats,
    want: &Value,
    tol: &Tolerance,
) {
    let lbl = |k: &str| format!("{label}.{k}");
    assert_close(&lbl("imep_bar"),         got.imep_bar,         f64_val(&want["imep_bar"]),         tol);
    assert_close(&lbl("bmep_bar"),         got.bmep_bar,         f64_val(&want["bmep_bar"]),         tol);
    assert_close(&lbl("fmep_bar"),         got.fmep_bar,         f64_val(&want["fmep_bar"]),         tol);
    assert_close(&lbl("ve_atm"),           got.ve_atm,           f64_val(&want["ve_atm"]),           tol);
    assert_close(&lbl("mass_total"),       got.mass_total,       f64_val(&want["mass_total"]),       tol);
    assert_close(&lbl("mass_drift"),       got.mass_drift,       f64_val(&want["mass_drift"]),       tol);
    assert_close(&lbl("mass_in"),          got.mass_in_restrictor, f64_val(&want["mass_in_restrictor"]), tol);
    assert_close(&lbl("mass_out"),         got.mass_out_collector, f64_val(&want["mass_out_collector"]), tol);
    assert_close(&lbl("net_port_flow"),    got.net_port_flow,    f64_val(&want["net_port_flow"]),    tol);
    assert_close(&lbl("nonconservation"),  got.nonconservation,  f64_val(&want["nonconservation"]),  tol);
    assert_close(&lbl("intake_g"),         got.intake_mass_per_cycle_g, f64_val(&want["intake_mass_per_cycle_g"]), tol);
    assert_close(&lbl("f_residual"),       got.f_residual,       f64_val(&want["f_residual"]),       tol);
    assert_close(&lbl("ind_power_kW"),     got.indicated_power_k_w, f64_val(&want["indicated_power_kW"]), tol);
    assert_close(&lbl("brake_power_kW"),   got.brake_power_k_w,  f64_val(&want["brake_power_kW"]),   tol);
    assert_close(&lbl("wheel_power_kW"),   got.wheel_power_k_w,  f64_val(&want["wheel_power_kW"]),   tol);
    assert_close(&lbl("ind_torque_Nm"),    got.indicated_torque_nm, f64_val(&want["indicated_torque_Nm"]), tol);
    assert_close(&lbl("brake_torque_Nm"),  got.brake_torque_nm,  f64_val(&want["brake_torque_Nm"]),  tol);
    assert_close(&lbl("wheel_torque_Nm"),  got.wheel_torque_nm,  f64_val(&want["wheel_torque_Nm"]),  tol);
    assert_close(&lbl("EGT_mean"),         got.egt_mean,         f64_val(&want["EGT_mean"]),         tol);
}

#[allow(dead_code)]
pub fn config_path_for(name: &str) -> std::path::PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    root.join("python_ref").join("configs").join(format!("{name}.json"))
}

#[allow(dead_code)]
pub fn junction_kind_from_str(s: &str) -> engine_sim::model::sdm26::JunctionKind {
    match s {
        "stagnation" => engine_sim::model::sdm26::JunctionKind::Stagnation,
        "characteristic" => engine_sim::model::sdm26::JunctionKind::Characteristic,
        other => panic!("unknown junction_type {other}"),
    }
}
