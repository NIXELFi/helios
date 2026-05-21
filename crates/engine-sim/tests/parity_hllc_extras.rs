//! Extended HLLC parity: 500 random + 8 Toro textbook Riemann problems.
//!
//! Single consolidated fixture (`hllc_extras.json`) with one test that
//! iterates every case. Tolerance is KERNEL_TOLERANCE (rtol=1e-12,
//! atol=1e-14) — HLLC is a pure flux function so machine precision is
//! achievable.

mod common;
use common::*;

use engine_sim::solver::hllc::hllc_flux;

#[test]
fn hllc_extras_parity() {
    let fx = load_fixture("hllc_extras");
    let tol = tolerance(&fx);
    let cases = fx["cases"].as_array().expect("cases array");
    assert_eq!(cases.len(), 508, "expected 500 random + 8 textbook cases");
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let inp = &case["inputs"];
        let out = &case["outputs"];
        let l = f64_array(&inp["L"]);
        let r = f64_array(&inp["R"]);
        let g = f64_val(&inp["gamma"]);
        let want = f64_array(&out["flux"]);
        let (f0, f1, f2, f3) = hllc_flux(
            l[0], l[1], l[2], l[3],
            r[0], r[1], r[2], r[3],
            g,
        );
        assert_close_slice(name, &[f0, f1, f2, f3], &want, &tol);
    }
}
