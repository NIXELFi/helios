//! Parity tests for restrictor, subsonic, and junction_cv BCs.

mod common;
use common::*;

use engine_sim::bcs::junction_cv::{JunctionCV, JunctionCVLeg, PipeEnd};
use engine_sim::bcs::restrictor::{fill_choked_restrictor_left, restrictor_mdot};
use engine_sim::bcs::subsonic::{
    fill_subsonic_inflow_left, fill_subsonic_inflow_left_characteristic,
    fill_subsonic_outflow_right,
};
use engine_sim::solver::state::{make_pipe_state, set_uniform, N_VARS};

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

#[test]
fn bcs_restrictor_parity() {
    let fx = load_fixture("bcs_restrictor");
    let tol = tolerance(&fx);
    for case in fx["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let inp = &case["inputs"];
        let out = &case["outputs"];
        if name.starts_with("mdot@") {
            let m = restrictor_mdot(
                f64_val(&inp["p_down"]),
                f64_val(&inp["p_0"]),
                f64_val(&inp["T_0"]),
                f64_val(&inp["A_t"]),
                f64_val(&inp["Cd"]),
                f64_val(&inp["gamma"]),
                f64_val(&inp["R_gas"]),
            );
            assert_close(name, m, f64_val(&out["mdot"]), &tol);
        } else {
            let interior_p = f64_val(&inp["interior_p"]);
            let p_0 = f64_val(&inp["p_0"]);
            let t_0 = f64_val(&inp["T_0"]);
            let a_t = f64_val(&inp["A_t"]);
            let cd = f64_val(&inp["Cd"]);
            let loss = f64_val(&inp["loss_coef"]);
            let mut s = make_pipe_state(20, 0.3, |_x| 0.005, 1.4, 287.0, 320.0, 2);
            // interior rho mirrors python: set_uniform with rho derived
            let init_rho = if name.contains("subsonic") { 1.0 } else { 0.4 };
            set_uniform(&mut s, init_rho, 0.0, interior_p, 0.0);
            let m = fill_choked_restrictor_left(&mut s, p_0, t_0, a_t, cd, loss);
            assert_close(&format!("{name}.mdot"), m, f64_val(&out["mdot"]), &tol);
            let want_q = flat_q(&out["q_after"]);
            assert_close_slice(&format!("{name}.q"), &s.q, &want_q, &tol);
        }
    }
}

#[test]
fn bcs_subsonic_parity() {
    let fx = load_fixture("bcs_subsonic");
    let tol = tolerance(&fx);
    for case in fx["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let inp = &case["inputs"];
        let out = &case["outputs"];
        let mut s = make_pipe_state(20, 0.2, |_x| 0.001, 1.4, 287.0, 320.0, 2);
        // The Python fixture set interior to (1.184, 10.0, 100000.0) for all three cases.
        let int_rho = inp.get("interior_rho").map(f64_val).unwrap_or(1.184);
        let int_u = inp.get("interior_u").map(f64_val).unwrap_or(10.0);
        let int_p = inp.get("interior_p").map(f64_val).unwrap_or(100000.0);
        set_uniform(&mut s, int_rho, int_u, int_p, 0.0);
        match name {
            "subsonic_inflow_left_legacy" => {
                fill_subsonic_inflow_left(&mut s,
                    f64_val(&inp["rho"]), f64_val(&inp["u"]),
                    f64_val(&inp["p"]),   f64_val(&inp["Y"]));
            }
            "subsonic_inflow_left_characteristic" => {
                fill_subsonic_inflow_left_characteristic(&mut s,
                    f64_val(&inp["rho_res"]), 0.0,
                    f64_val(&inp["p_res"]),   f64_val(&inp["Y_res"]));
            }
            "subsonic_outflow_right" => {
                fill_subsonic_outflow_right(&mut s, f64_val(&inp["p_back"]));
            }
            _ => panic!("unknown case {name}"),
        }
        let want = flat_q(&out["q"]);
        assert_close_slice(name, &s.q, &want, &tol);
    }
}

#[test]
fn bcs_junction_cv_parity() {
    let fx = load_fixture("bcs_junction_cv");
    let tol = tolerance(&fx);
    for case in fx["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let out = &case["outputs"];
        let inp = &case["inputs"];

        let av = f64_array(&inp["a"]);  // [rho, u, p, Y, area]
        let bv = f64_array(&inp["b"]);
        let cv = f64_array(&inp["c"]);

        let a_area = av[4]; let b_area = bv[4]; let c_area = cv[4];
        let mut a = make_pipe_state(10, 0.3, |_x| a_area, 1.4, 287.0, 320.0, 2);
        let mut b = make_pipe_state(10, 0.3, |_x| b_area, 1.4, 287.0, 320.0, 2);
        let mut c = make_pipe_state(10, 0.3, |_x| c_area, 1.4, 287.0, 320.0, 2);
        set_uniform(&mut a, av[0], av[1], av[2], av[3]);
        set_uniform(&mut b, bv[0], bv[1], bv[2], bv[3]);
        set_uniform(&mut c, cv[0], cv[1], cv[2], cv[3]);

        let mut pipes = vec![a, b, c];
        let legs = vec![
            JunctionCVLeg::new(0, PipeEnd::Right),
            JunctionCVLeg::new(1, PipeEnd::Right),
            JunctionCVLeg::new(2, PipeEnd::Left),
        ];
        let mut j = JunctionCV::from_legs(
            legs, &pipes, 101325.0, 300.0, 0.0, 1.4, 287.0, 1.0,
        );
        j.fill_ghosts(&mut pipes, 0.0);

        let after_fill = &out["after_fill_ghosts"];
        let want_aq = flat_q(&after_fill["a_q"]);
        let want_bq = flat_q(&after_fill["b_q"]);
        let want_cq = flat_q(&after_fill["c_q"]);
        assert_close_slice(&format!("{name}.a_q"), &pipes[0].q, &want_aq, &tol);
        assert_close_slice(&format!("{name}.b_q"), &pipes[1].q, &want_bq, &tol);
        assert_close_slice(&format!("{name}.c_q"), &pipes[2].q, &want_cq, &tol);
        assert_close("M", j.m, f64_val(&after_fill["M"]), &tol);
        assert_close("E", j.e, f64_val(&after_fill["E"]), &tol);
        assert_close("M_Y", j.m_y, f64_val(&after_fill["M_Y"]), &tol);
        assert_close("V", j.volume, f64_val(&after_fill["V"]), &tol);
        assert_close("last_p", j.last_p, f64_val(&after_fill["last_p"]), &tol);
        assert_close("last_T", j.last_t, f64_val(&after_fill["last_T"]), &tol);

        // Build the flux arrays mirroring Python's _scratch injections.
        let mut flux_a = vec![0.0; (pipes[0].n_total() + 1) * N_VARS];
        let mut flux_b = vec![0.0; (pipes[1].n_total() + 1) * N_VARS];
        let mut flux_c = vec![0.0; (pipes[2].n_total() + 1) * N_VARS];
        let a_face = pipes[0].n_ghost + pipes[0].n_cells;
        let b_face = pipes[1].n_ghost + pipes[1].n_cells;
        let c_face = pipes[2].n_ghost;
        flux_a[a_face * N_VARS]     = 0.1;
        flux_a[a_face * N_VARS + 2] = 200.0;
        flux_b[b_face * N_VARS]     = 0.05;
        flux_b[b_face * N_VARS + 2] = 100.0;
        flux_c[c_face * N_VARS]     = -0.15;
        flux_c[c_face * N_VARS + 2] = -300.0;
        let fluxes: [&[f64]; 3] = [&flux_a, &flux_b, &flux_c];
        j.absorb_fluxes(&pipes, &fluxes, 1e-5);
        let after = &out["after_absorb"];
        assert_close("M_after", j.m, f64_val(&after["M"]), &tol);
        assert_close("E_after", j.e, f64_val(&after["E"]), &tol);
        assert_close("M_Y_after", j.m_y, f64_val(&after["M_Y"]), &tol);
    }
}
