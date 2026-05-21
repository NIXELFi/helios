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
