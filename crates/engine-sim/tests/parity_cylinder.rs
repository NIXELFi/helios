//! Parity test for CylinderModel::advance — closed cycle + gas exchange.

mod common;
use common::*;

use std::f64::consts::PI;

use engine_sim::cylinder::combustion::WiebeParams;
use engine_sim::cylinder::cylinder::{CylinderGeom, CylinderModel};
use engine_sim::cylinder::heat_transfer::WoschniParams;
use engine_sim::cylinder::valve::{
    ValveParams, EXHAUST_CD_TABLE, EXHAUST_LD_TABLE,
    INTAKE_CD_TABLE, INTAKE_LD_TABLE,
};

fn build_model(phase_offset: f64) -> CylinderModel {
    let geom = CylinderGeom {
        bore: 0.067, stroke: 0.0425, con_rod: 0.0963, cr: 12.2,
        n_intake_valves: 2, n_exhaust_valves: 2,
    };
    let wiebe = WiebeParams::default();
    let woschni = WoschniParams::new(0.067, 0.0425);
    let intake = ValveParams {
        diameter: 0.0275, max_lift: 0.00856,
        open_angle_deg: 350.0, close_angle_deg: 585.0,
        seat_angle_deg: 45.0, n_valves: 2,
        ld_table: INTAKE_LD_TABLE.to_vec(),
        cd_table: INTAKE_CD_TABLE.to_vec(),
    };
    let exhaust = ValveParams {
        diameter: 0.023, max_lift: 0.00735,
        open_angle_deg: 140.0, close_angle_deg: 365.0,
        seat_angle_deg: 45.0, n_valves: 2,
        ld_table: EXHAUST_LD_TABLE.to_vec(),
        cd_table: EXHAUST_CD_TABLE.to_vec(),
    };
    CylinderModel::new(geom, wiebe, woschni, intake, exhaust, phase_offset, false)
}

#[test]
fn cylinder_advance_parity() {
    let fx = load_fixture("cylinder_advance");
    let tol = tolerance(&fx);
    for case in fx["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let inp = &case["inputs"];
        let out = &case["outputs"];
        let rpm = f64_val(&inp["rpm"]);
        let dt = f64_val(&inp["dt"]);
        let theta_start = f64_val(&inp["theta_start"]);
        let n_steps = inp["n_steps"].as_u64().unwrap() as usize;
        let mut cyl = build_model(0.0);
        let init_p = inp.get("init_p").map(f64_val).unwrap_or(101325.0);
        let init_t = inp.get("init_T").map(f64_val).unwrap_or(300.0);
        let init_theta = inp.get("init_theta_global_deg").map(f64_val).unwrap_or(theta_start);
        cyl.initialize(init_p, init_t, init_theta);
        if let Some(v) = inp.get("mdot_intake") {
            cyl.state.mdot_intake = f64_val(v);
        }
        if let Some(v) = inp.get("T_intake") {
            cyl.state.t_intake = f64_val(v);
        }
        let omega = 2.0 * PI * rpm / 60.0;
        let dtheta = dt * 180.0 / PI * omega;
        let mut theta = theta_start;
        let want_snapshots = out["snapshots"].as_array().unwrap();
        for i in 0..n_steps {
            cyl.advance(theta, dtheta, rpm, dt);
            theta += dtheta;
            let want = &want_snapshots[i];
            assert_close(&format!("{name}.p[{i}]"), cyl.state.p, f64_val(&want["p"]), &tol);
            assert_close(&format!("{name}.T[{i}]"), cyl.state.t, f64_val(&want["T"]), &tol);
            assert_close(&format!("{name}.m[{i}]"), cyl.state.m, f64_val(&want["m"]), &tol);
            if let Some(w) = want.get("x_b") {
                assert_close(&format!("{name}.xb[{i}]"), cyl.state.x_b, f64_val(w), &tol);
            }
            if let Some(w) = want.get("work_cycle") {
                assert_close(&format!("{name}.work[{i}]"), cyl.state.work_cycle, f64_val(w), &tol);
            }
            let want_theta = f64_val(&want["theta"]);
            assert_close(&format!("{name}.theta[{i}]"), theta, want_theta, &tol);
        }
    }
}
