//! Additional MUSCL parity cases beyond the original Sod variants.
//!
//! Each case is its own fixture file so test-report failure points
//! at the specific IC.

mod common;
use common::*;

use engine_sim::bcs::simple::{fill_transmissive_left, fill_transmissive_right};
use engine_sim::solver::muscl::{cfl_dt, muscl_hancock_step, LIMITER_MINMOD};
use engine_sim::solver::state::{make_pipe_state, set_left_right, ScratchBuffers};

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

fn run_muscl_extra(
    n_cells: usize,
    length: f64,
    gamma: f64,
    n_steps: usize,
    limiter: i32,
    lvals: &[f64],
    rvals: &[f64],
) -> (Vec<f64>, Vec<f64>) {
    let mut s = make_pipe_state(n_cells, length, |_x| 1.0, gamma, 287.0, 320.0, 2);
    set_left_right(&mut s, length / 2.0,
        lvals[0], lvals[1], lvals[2], lvals[3],
        rvals[0], rvals[1], rvals[2], rvals[3]);
    let ng = s.n_ghost;
    let mut sc = ScratchBuffers::for_pipe(&s);
    for _ in 0..n_steps {
        let dt = cfl_dt(&s.q, &s.area, s.dx, gamma, 0.85, ng);
        if dt <= 0.0 { break; }
        fill_transmissive_left(&mut s);
        fill_transmissive_right(&mut s);
        muscl_hancock_step(
            &mut s.q, &s.area, &s.area_f, s.dx, dt, gamma, ng, limiter,
            &mut sc.w, &mut sc.slopes, &mut sc.w_pred_l, &mut sc.w_pred_r,
            &mut sc.flux,
        );
    }
    (s.q, sc.flux)
}

fn run_muscl_extra_fixture(name: &str) {
    let fx = load_fixture(name);
    let tol = tolerance(&fx);
    let case = &fx["cases"][0];
    let inp = &case["inputs"];
    let out = &case["outputs"];

    let n_cells = inp["n_cells"].as_u64().unwrap() as usize;
    let length = f64_val(&inp["length"]);
    let gamma = f64_val(&inp["gamma"]);
    let n_steps = inp["n_steps"].as_u64().unwrap() as usize;
    let limiter = inp["limiter"].as_i64().unwrap() as i32;
    let l = f64_array(&inp["L"]);
    let r = f64_array(&inp["R"]);
    assert_eq!(limiter, LIMITER_MINMOD, "extras fixtures pin limiter to MINMOD");

    let (q, flux) = run_muscl_extra(n_cells, length, gamma, n_steps, limiter, &l, &r);
    let q_want = flat_q(&out["q_final"]);
    let flux_want = flat_q(&out["flux_final"]);
    assert_close_slice(&format!("{name}.q"), &q, &q_want, &tol);
    assert_close_slice(&format!("{name}.flux"), &flux, &flux_want, &tol);
}

#[test]
fn muscl_contact_50step_minmod() {
    run_muscl_extra_fixture("muscl_contact_50step_minmod");
}

#[test]
fn muscl_left_rarefaction_50step_minmod() {
    run_muscl_extra_fixture("muscl_left_rarefaction_50step_minmod");
}

#[test]
fn muscl_supersonic_shock_50step_minmod() {
    run_muscl_extra_fixture("muscl_supersonic_shock_50step_minmod");
}

#[test]
fn muscl_sod_50step_gamma13_minmod() {
    run_muscl_extra_fixture("muscl_sod_50step_gamma13_minmod");
}
