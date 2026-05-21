//! Parity test for the characteristic junction.

mod common;
use common::*;

use engine_sim::bcs::junction_characteristic::{CharacteristicJunction, CharJunctionLeg};
use engine_sim::bcs::junction_cv::PipeEnd;
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

#[test]
fn bcs_junction_characteristic_parity() {
    let fx = load_fixture("bcs_junction_characteristic");
    let tol = tolerance(&fx);
    for case in fx["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let inp = &case["inputs"];
        let out = &case["outputs"];

        let av = f64_array(&inp["a"]);
        let bv = f64_array(&inp["b"]);
        let cv = f64_array(&inp["c"]);
        let mut a = make_pipe_state(20, 0.3, |_x| av[4], 1.4, 287.0, 320.0, 2);
        let mut b = make_pipe_state(20, 0.3, |_x| bv[4], 1.4, 287.0, 320.0, 2);
        let mut c = make_pipe_state(20, 0.3, |_x| cv[4], 1.4, 287.0, 320.0, 2);
        set_uniform(&mut a, av[0], av[1], av[2], av[3]);
        set_uniform(&mut b, bv[0], bv[1], bv[2], bv[3]);
        set_uniform(&mut c, cv[0], cv[1], cv[2], cv[3]);
        let mut pipes = vec![a, b, c];
        let legs = vec![
            CharJunctionLeg::new(0, PipeEnd::Right),
            CharJunctionLeg::new(1, PipeEnd::Right),
            CharJunctionLeg::new(2, PipeEnd::Left),
        ];
        let mut j = CharacteristicJunction::new(legs, 1.4, 287.0);
        let dt = f64_val(&inp["dt"]);
        j.fill_ghosts(&mut pipes, dt).expect("convergence");

        let want_aq = flat_q(&out["a_q"]);
        let want_bq = flat_q(&out["b_q"]);
        let want_cq = flat_q(&out["c_q"]);
        assert_close_slice(&format!("{name}.a_q"), &pipes[0].q, &want_aq, &tol);
        assert_close_slice(&format!("{name}.b_q"), &pipes[1].q, &want_bq, &tol);
        assert_close_slice(&format!("{name}.c_q"), &pipes[2].q, &want_cq, &tol);
        assert_close("p_junction", j.last_p_junction, f64_val(&out["p_junction"]), &tol);
        assert_close("mass_residual", j.last_mass_residual,
                     f64_val(&out["mass_residual"]), &tol);
        assert_close("energy_residual", j.last_energy_residual,
                     f64_val(&out["energy_residual"]), &tol);
        assert_eq!(j.last_niter as i64, out["niter"].as_i64().unwrap(),
                   "niter mismatch");
        assert_eq!(&j.last_regime, out["regime"].as_str().unwrap(),
                   "regime mismatch");
        assert_close("y_mixed", j.last_y_mixed, f64_val(&out["y_mixed"]), &tol);
    }
}
