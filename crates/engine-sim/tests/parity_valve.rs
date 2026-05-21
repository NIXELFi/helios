//! Parity tests for the valve BC (legacy + characteristic).

mod common;
use common::*;

use std::f64::consts::PI;

use engine_sim::bcs::valve::{
    fill_valve_ghost, fill_valve_ghost_characteristic, PipeEndStr, ValveType,
};
use engine_sim::cylinder::valve::{
    ValveParams, EXHAUST_CD_TABLE, EXHAUST_LD_TABLE,
    INTAKE_CD_TABLE, INTAKE_LD_TABLE,
};
use engine_sim::solver::state::{make_pipe_state, set_uniform};

fn flat_q(v: &serde_json::Value) -> Vec<f64> {
    let rows: Vec<Vec<f64>> = v.as_array().unwrap().iter().map(|row| {
        row.as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect()
    }).collect();
    let mut out = Vec::with_capacity(rows.len() * 4);
    for r in rows {
        for x in r { out.push(x); }
    }
    out
}

fn intake_params() -> ValveParams {
    ValveParams {
        diameter: 0.0275, max_lift: 0.00856,
        open_angle_deg: 350.0, close_angle_deg: 585.0,
        seat_angle_deg: 45.0, n_valves: 2,
        ld_table: INTAKE_LD_TABLE.to_vec(),
        cd_table: INTAKE_CD_TABLE.to_vec(),
    }
}

fn exhaust_params() -> ValveParams {
    ValveParams {
        diameter: 0.023, max_lift: 0.00735,
        open_angle_deg: 140.0, close_angle_deg: 365.0,
        seat_angle_deg: 45.0, n_valves: 2,
        ld_table: EXHAUST_LD_TABLE.to_vec(),
        cd_table: EXHAUST_CD_TABLE.to_vec(),
    }
}

#[test]
fn bcs_valve_parity() {
    let fx = load_fixture("bcs_valve");
    let tol = tolerance(&fx);
    for case in fx["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let inp = &case["inputs"];
        let out = &case["outputs"];
        let valve_str = inp["valve_type"].as_str().unwrap();
        let valve_type = ValveType::parse(valve_str);
        let vp = if valve_str == "intake" { intake_params() } else { exhaust_params() };
        let pipe_end = PipeEndStr::parse(inp["pipe_end"].as_str().unwrap());
        let theta = f64_val(&inp["theta_local"]);
        let p_cyl = f64_val(&inp["p_cyl"]);
        let t_cyl = f64_val(&inp["T_cyl"]);
        let xb = f64_val(&inp["xb_cyl"]);
        let interior = f64_array(&inp["interior"]);
        let area_const = 0.25 * PI * vp.diameter * vp.diameter;

        let mut s1 = make_pipe_state(20, 0.3, |_x| area_const, 1.4, 287.0, 350.0, 2);
        set_uniform(&mut s1, interior[0], interior[1], interior[2], interior[3]);
        let m_legacy = fill_valve_ghost(
            &mut s1, pipe_end, valve_type, &vp, theta, p_cyl, t_cyl, xb,
        );
        assert_close(&format!("{name}.mdot_legacy"),
            m_legacy, f64_val(&out["mdot_legacy"]), &tol);
        let want_q_legacy = flat_q(&out["q_legacy"]);
        assert_close_slice(&format!("{name}.q_legacy"), &s1.q, &want_q_legacy, &tol);

        let mut s2 = make_pipe_state(20, 0.3, |_x| area_const, 1.4, 287.0, 350.0, 2);
        set_uniform(&mut s2, interior[0], interior[1], interior[2], interior[3]);
        let m_char = fill_valve_ghost_characteristic(
            &mut s2, pipe_end, valve_type, &vp, theta, p_cyl, t_cyl, xb,
        );
        assert_close(&format!("{name}.mdot_char"),
            m_char, f64_val(&out["mdot_characteristic"]), &tol);
        let want_q_char = flat_q(&out["q_characteristic"]);
        assert_close_slice(&format!("{name}.q_char"), &s2.q, &want_q_char, &tol);
    }
}
