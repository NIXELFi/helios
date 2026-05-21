//! Parity tests for solver + simple BCs.

mod common;
use common::*;

use engine_sim::bcs::simple::{
    fill_reflective_left, fill_reflective_right,
    fill_transmissive_left, fill_transmissive_right,
};
use engine_sim::solver::hllc::{cons_to_prim, euler_flux, hllc_flux, prim_to_cons};
use engine_sim::solver::muscl::{
    cfl_dt, muscl_hancock_step,
    LIMITER_MINMOD, LIMITER_VAN_LEER, LIMITER_SUPERBEE,
};
use engine_sim::solver::sources::apply_sources;
use engine_sim::solver::state::{
    make_pipe_state, primitives_array, set_left_right, set_uniform,
    total_energy, total_mass, PipeState, ScratchBuffers, N_VARS,
};

fn tapered_area(length: f64, d_in: f64, d_out: f64) -> impl FnMut(f64) -> f64 {
    let pi = std::f64::consts::PI;
    let l = length.max(1e-20);
    move |x: f64| {
        let mut t = x / l;
        if t < 0.0 { t = 0.0; }
        if t > 1.0 { t = 1.0; }
        let d = d_in + (d_out - d_in) * t;
        0.25 * pi * d * d
    }
}

#[test]
fn state_parity() {
    let fx = load_fixture("state");
    let tol = tolerance(&fx);
    for case in fx["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let inp = &case["inputs"];
        let out = &case["outputs"];
        match name {
            "make_pipe_state_taper" => {
                let n = inp["n_cells"].as_u64().unwrap() as usize;
                let l = f64_val(&inp["length"]);
                let d_in = f64_val(&inp["D_in"]);
                let d_out = f64_val(&inp["D_out"]);
                let gamma = f64_val(&inp["gamma"]);
                let r_gas = f64_val(&inp["R_gas"]);
                let wall_t = f64_val(&inp["wall_T"]);
                let n_ghost = inp["n_ghost"].as_u64().unwrap() as usize;
                let s = make_pipe_state(n, l, tapered_area(l, d_in, d_out),
                                        gamma, r_gas, wall_t, n_ghost);
                assert_close_slice("area", &s.area, &f64_array(&out["area"]), &tol);
                assert_close_slice("area_f", &s.area_f, &f64_array(&out["area_f"]), &tol);
                assert_close_slice("hyd_D", &s.hydraulic_d, &f64_array(&out["hydraulic_D"]), &tol);
                assert_close("dx", s.dx, f64_val(&out["dx"]), &tol);
            }
            "set_uniform_then_primitives" => {
                let s_taper = make_pipe_state(20, 0.245, tapered_area(0.245, 0.038, 0.040),
                                              1.4, 287.0, 325.0, 2);
                let mut s = s_taper;
                set_uniform(&mut s,
                    f64_val(&inp["rho"]),
                    f64_val(&inp["u"]),
                    f64_val(&inp["p"]),
                    f64_val(&inp["Y"]),
                );
                let q_flat: Vec<f64> = flat_q(&out["q"]);
                assert_close_slice("q", &s.q, &q_flat, &tol);
                let prim_flat: Vec<f64> = flat_q(&out["primitives"]);
                let got_prim = primitives_array(&s);
                assert_close_slice("primitives", &got_prim, &prim_flat, &tol);
                assert_close("total_mass", total_mass(&s), f64_val(&out["total_mass"]), &tol);
                assert_close("total_energy", total_energy(&s), f64_val(&out["total_energy"]), &tol);
            }
            "set_left_right_sod" => {
                let mut s = make_pipe_state(20, 1.0, |_x| 1.0, 1.4, 287.0, 320.0, 2);
                let lv = f64_array(&inp["L"]);
                let rv = f64_array(&inp["R"]);
                set_left_right(&mut s, f64_val(&inp["x0"]),
                    lv[0], lv[1], lv[2], lv[3],
                    rv[0], rv[1], rv[2], rv[3]);
                let q_flat: Vec<f64> = flat_q(&out["q"]);
                assert_close_slice("q", &s.q, &q_flat, &tol);
            }
            _ => panic!("unknown case {name}"),
        }
    }
}

fn flat_q(v: &serde_json::Value) -> Vec<f64> {
    // Python q is shape (n_total, 4). We stored it as list-of-lists, length n_total.
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
fn hllc_parity() {
    let fx = load_fixture("hllc");
    let tol = tolerance(&fx);
    for case in fx["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let inp = &case["inputs"];
        let out = &case["outputs"];
        if name.starts_with("prim_cons") {
            let rho = f64_val(&inp["rho"]);
            let u = f64_val(&inp["u"]);
            let p = f64_val(&inp["p"]);
            let y = f64_val(&inp["Y"]);
            let g = f64_val(&inp["gamma"]);
            let c = prim_to_cons(rho, u, p, y, g);
            let want_c = f64_array(&out["cons"]);
            assert_close_slice("cons", &[c.0, c.1, c.2, c.3], &want_c, &tol);
            let b = cons_to_prim(c.0, c.1, c.2, c.3, g);
            let want_b = f64_array(&out["round_trip"]);
            assert_close_slice("round_trip", &[b.0, b.1, b.2, b.3], &want_b, &tol);
            let f = euler_flux(rho, u, p, y, g);
            let want_f = f64_array(&out["euler_flux"]);
            assert_close_slice("euler_flux", &[f.0, f.1, f.2, f.3], &want_f, &tol);
        } else if name.starts_with("hllc_") {
            let l = f64_array(&inp["L"]);
            let r = f64_array(&inp["R"]);
            let g = f64_val(&inp["gamma"]);
            let want = f64_array(&out["flux"]);
            let (f0, f1, f2, f3) = hllc_flux(l[0], l[1], l[2], l[3],
                                             r[0], r[1], r[2], r[3], g);
            assert_close_slice(name, &[f0, f1, f2, f3], &want, &tol);
        }
    }
}

fn run_muscl(
    n_steps: usize, limiter: i32, lvals: &[f64], rvals: &[f64],
) -> (Vec<f64>, Vec<f64>) {
    let mut s = make_pipe_state(100, 1.0, |_x| 1.0, 1.4, 287.0, 320.0, 2);
    set_left_right(&mut s, 0.5,
        lvals[0], lvals[1], lvals[2], lvals[3],
        rvals[0], rvals[1], rvals[2], rvals[3]);
    let ng = s.n_ghost;
    let mut sc = ScratchBuffers::for_pipe(&s);
    for _ in 0..n_steps {
        let dt = cfl_dt(&s.q, &s.area, s.dx, 1.4, 0.85, ng);
        if dt <= 0.0 { break; }
        fill_transmissive_left(&mut s);
        fill_transmissive_right(&mut s);
        muscl_hancock_step(
            &mut s.q, &s.area, &s.area_f, s.dx, dt, 1.4, ng, limiter,
            &mut sc.w, &mut sc.slopes, &mut sc.w_pred_l, &mut sc.w_pred_r,
            &mut sc.flux,
        );
    }
    (s.q, sc.flux)
}

#[test]
fn muscl_parity() {
    let fx = load_fixture("muscl");
    let tol = tolerance(&fx);
    for case in fx["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let inp = &case["inputs"];
        let out = &case["outputs"];
        let n_steps = inp["n_steps"].as_u64().unwrap() as usize;
        let limiter = inp["limiter"].as_i64().unwrap() as i32;
        let l = f64_array(&inp["L"]);
        let r = f64_array(&inp["R"]);
        let (q, flux) = run_muscl(n_steps, limiter, &l, &r);
        let q_want = flat_q(&out["q_final"]);
        let flux_want = flat_q(&out["flux_final"]);
        assert_close_slice(&format!("{name}.q"), &q, &q_want, &tol);
        assert_close_slice(&format!("{name}.flux"), &flux, &flux_want, &tol);
    }
}

#[test]
fn sources_parity() {
    let fx = load_fixture("sources");
    let tol = tolerance(&fx);
    for case in fx["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let inp = &case["inputs"];
        let out = &case["outputs"];
        let mut s = make_pipe_state(30, 0.5, |_x| 0.001, 1.4, 287.0, 350.0, 2);
        set_uniform(&mut s, 2.0, 80.0, 200000.0, 0.0);
        let (apply_friction, apply_heat) = match name {
            "apply_sources_uniform" => (true, true),
            "apply_sources_friction_only" => (true, false),
            "apply_sources_heat_only" => (false, true),
            _ => panic!("unknown case {name}"),
        };
        let dt = inp.get("dt").map(|v| v.as_f64().unwrap()).unwrap_or(1e-5);
        apply_sources(&mut s.q, &s.area, &s.hydraulic_d, dt, 1.4, 287.0, 350.0,
                      s.n_ghost, apply_friction, apply_heat);
        let want = flat_q(&out["q_after"]);
        assert_close_slice(&format!("{name}.q"), &s.q, &want, &tol);
    }
}

#[test]
fn bcs_simple_parity() {
    let fx = load_fixture("bcs_simple");
    let tol = tolerance(&fx);
    for case in fx["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let inp = &case["inputs"];
        let out = &case["outputs"];
        let mut s = make_pipe_state(10, 0.2, |_x| 0.001, 1.4, 287.0, 320.0, 2);
        set_uniform(&mut s,
            f64_val(&inp["rho"]), f64_val(&inp["u"]),
            f64_val(&inp["p"]), f64_val(&inp["Y"]));
        match name {
            "trans_left"  => fill_transmissive_left(&mut s),
            "trans_right" => fill_transmissive_right(&mut s),
            "refl_left"   => fill_reflective_left(&mut s),
            "refl_right"  => fill_reflective_right(&mut s),
            _ => panic!("unknown case {name}"),
        }
        let want = flat_q(&out["q"]);
        assert_close_slice(name, &s.q, &want, &tol);
        let _ = (PipeState { ..s }); // suppress unused (kept the struct in scope for clarity)
    }
    // Silence unused warning for N_VARS import via touch:
    let _ = N_VARS;
}
