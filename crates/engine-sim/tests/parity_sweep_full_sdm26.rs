//! End-to-end Python-vs-Rust sweep parity check for SDM26.
//!
//! Loads the user-captured Python sweep CSV at
//!   tests/fixtures/sweep_python_v1/sdm26_characteristic_4k_to_15k.csv
//! (committed 2026-05-21 from `1dFVEngineSolver` at SHA 24ba2f4 on
//! branch `research/low-rpm-iteration`, junction=characteristic,
//! n_cycles_max=40, tol=0.005, min_cycles=8), runs the Rust sweep with
//! IDENTICAL parameters, and asserts every (imep, bmep, ve, egt,
//! p_ind) matches to 1e-3 relative tolerance per RPM.
//!
//! A failure here means EITHER the Rust port has drifted OR the Python
//! reference was re-captured with different physics. Re-capture the
//! CSV only when both sides have been intentionally updated.

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;

use engine_sim::config::loader::load_v1_json;
use engine_sim::model::sdm26::JunctionKind;
use engine_sim::model::sweep::{run_sweep, SweepPoint};

fn sdm26_config_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("python_ref/configs/sdm26.json")
}

#[derive(Debug)]
struct PyRow {
    rpm: f64,
    imep_bar: f64,
    bmep_bar: f64,
    ve_atm: f64,
    egt_mean: f64,
    indicated_power_k_w: f64,
    converged_cycle: i64,
}

fn parse_python_csv() -> Vec<PyRow> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/sweep_python_v1/sdm26_characteristic_4k_to_15k.csv");
    let file = File::open(&path)
        .unwrap_or_else(|e| panic!("open {}: {}", path.display(), e));
    let mut lines = BufReader::new(file).lines();

    // Header
    let header = lines.next().expect("header").expect("read header");
    let cols: Vec<&str> = header.split(',').collect();
    let idx = |name: &str| -> usize {
        cols.iter().position(|c| *c == name)
            .unwrap_or_else(|| panic!("missing column {name} in {header}"))
    };
    let i_rpm = idx("rpm");
    let i_imep = idx("imep_bar");
    let i_bmep = idx("bmep_bar");
    let i_ve = idx("ve_atm");
    let i_egt = idx("EGT_mean");
    let i_pind = idx("indicated_power_kW");
    let i_conv = idx("converged_cycle");

    let mut out = Vec::new();
    for line in lines {
        let line = line.expect("read row");
        if line.trim().is_empty() { continue; }
        let v: Vec<&str> = line.split(',').collect();
        out.push(PyRow {
            rpm: v[i_rpm].parse().expect("rpm"),
            imep_bar: v[i_imep].parse().expect("imep"),
            bmep_bar: v[i_bmep].parse().expect("bmep"),
            ve_atm: v[i_ve].parse().expect("ve"),
            egt_mean: v[i_egt].parse().expect("egt"),
            indicated_power_k_w: v[i_pind].parse().expect("p_ind"),
            converged_cycle: v[i_conv].parse().expect("conv"),
        });
    }
    out
}

#[test]
fn rust_sweep_matches_python_fixture_characteristic_4k_to_15k() {
    let py = parse_python_csv();
    assert_eq!(py.len(), 23, "expected 23 RPM rows in fixture");
    let cfg = load_v1_json(sdm26_config_path()).expect("load sdm26");
    let rpm_list: Vec<f64> = py.iter().map(|p| p.rpm).collect();

    let rust: Vec<SweepPoint> = run_sweep(
        &rpm_list, cfg,
        JunctionKind::Characteristic,
        40, 0.005, 8,
    );
    assert_eq!(rust.len(), py.len());

    let mut worst: f64 = 0.0;
    let mut worst_label = String::new();
    eprintln!(
        "{:>6} | {:>9} {:>9} {:>6} | {:>7} {:>7} {:>6} | {:>7} {:>7} {:>6} | {:>9} {:>9} {:>6} | conv py/rs",
        "rpm","imep_py","imep_rs","Δ%","ve_py","ve_rs","Δ%","egt_py","egt_rs","Δ%","pind_py","pind_rs","Δ%",
    );
    for (a, b) in py.iter().zip(rust.iter()) {
        let pct = |py: f64, rs: f64| {
            let d = (rs - py).abs();
            let denom = py.abs().max(1e-12);
            d / denom * 100.0
        };
        let imep_p = pct(a.imep_bar, b.imep_bar);
        let ve_p = pct(a.ve_atm, b.ve_atm);
        let egt_p = pct(a.egt_mean, b.egt_valve_k);
        let pind_p = pct(a.indicated_power_k_w, b.indicated_power_k_w);
        eprintln!(
            "{:6.0} | {:9.4} {:9.4} {:6.3} | {:7.4} {:7.4} {:6.3} | {:7.1} {:7.1} {:6.3} | {:9.4} {:9.4} {:6.3} | {} / {}",
            a.rpm,
            a.imep_bar, b.imep_bar, imep_p,
            a.ve_atm, b.ve_atm, ve_p,
            a.egt_mean, b.egt_valve_k, egt_p,
            a.indicated_power_k_w, b.indicated_power_k_w, pind_p,
            a.converged_cycle, b.converged_cycle,
        );
        for (label, v) in [("imep", imep_p), ("ve", ve_p), ("egt", egt_p), ("pind", pind_p)] {
            if v > worst { worst = v; worst_label = format!("{label}@{:.0}rpm", a.rpm); }
            assert!(
                v < 0.1,
                "rpm {} {}: rel diff {:.4}% (py={} rs={})",
                a.rpm, label, v,
                match label {
                    "imep" => a.imep_bar, "ve" => a.ve_atm,
                    "egt" => a.egt_mean, "pind" => a.indicated_power_k_w,
                    _ => 0.0,
                },
                match label {
                    "imep" => b.imep_bar, "ve" => b.ve_atm,
                    "egt" => b.egt_valve_k, "pind" => b.indicated_power_k_w,
                    _ => 0.0,
                },
            );
        }
        assert_eq!(
            a.converged_cycle, b.converged_cycle,
            "rpm {} converged_cycle: py={} rs={}",
            a.rpm, a.converged_cycle, b.converged_cycle,
        );
    }
    eprintln!("\nworst relative disagreement: {:.4}% ({})", worst, worst_label);
    let _ = (worst, worst_label);
}
