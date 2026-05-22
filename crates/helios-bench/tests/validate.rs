//! `helios-bench validate` checks invariants per spec C9:
//!
//! - mass: `±1e-10` relative per cycle (uses `mass_drift_kg` / `mass_total_kg`
//!   if both present, else `nonconservation`)
//! - positivity: imep, brake_power, egt, ve must be ≥ 0; egt above 200 K floor
//! - monotonicity: per-RPM brake_power non-negative across rows
//! - energy + momentum: Phase 0 emits a WARNING that the checks are skipped
//!   pending instrumentation in the engine

use std::io::Write;
use std::process::Command;
use tempfile::tempdir;

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_helios-bench"))
}

fn write_ndjson(path: &std::path::Path, trial_line: &str) {
    let mut f = std::fs::File::create(path).unwrap();
    writeln!(
        f,
        r#"{{"kind":"environment","env":{{"target_triple":"x","rustc_version":"x","rayon_threads":1,"libm_source":"x"}},"seed":1,"commit_hash":"abc"}}"#
    )
    .unwrap();
    writeln!(f, "{trial_line}").unwrap();
}

#[test]
fn validate_passes_on_clean_ndjson() {
    let dir = tempdir().unwrap();
    let p = dir.path().join("r.ndjson");
    write_ndjson(
        &p,
        r#"{"kind":"trial","rpm":9000,"imep_bar":9.5,"brake_power_kW":40.0,"ve_atm":0.85,"egt_mean_K":900.0,"mass_drift_kg":1e-15,"mass_total_kg":0.005,"nonconservation":1e-18}"#,
    );

    let r = bin().args(["validate", p.to_str().unwrap()]).output().unwrap();
    assert!(
        r.status.success(),
        "validate should PASS: stderr={}, stdout={}",
        String::from_utf8_lossy(&r.stderr),
        String::from_utf8_lossy(&r.stdout)
    );
    let stdout = String::from_utf8_lossy(&r.stdout);
    assert!(stdout.contains("OK"), "stdout: {stdout}");
    // Phase 0 must emit a WARNING that energy + momentum are skipped.
    let stderr = String::from_utf8_lossy(&r.stderr);
    assert!(
        stderr.to_lowercase().contains("warning") && stderr.to_lowercase().contains("energy"),
        "expected warning about skipped energy/momentum checks: stderr={stderr}"
    );
}

#[test]
fn validate_fails_on_negative_imep() {
    let dir = tempdir().unwrap();
    let p = dir.path().join("r.ndjson");
    write_ndjson(
        &p,
        r#"{"kind":"trial","rpm":9000,"imep_bar":-1.0,"brake_power_kW":40.0,"ve_atm":0.85,"egt_mean_K":900.0,"mass_drift_kg":0.0,"mass_total_kg":0.005,"nonconservation":0.0}"#,
    );
    let r = bin().args(["validate", p.to_str().unwrap()]).output().unwrap();
    assert!(
        !r.status.success(),
        "validate should FAIL on negative imep: stdout={} stderr={}",
        String::from_utf8_lossy(&r.stdout),
        String::from_utf8_lossy(&r.stderr)
    );
}

#[test]
fn validate_fails_on_mass_drift_above_band() {
    let dir = tempdir().unwrap();
    let p = dir.path().join("r.ndjson");
    // relative drift = 1.0 / 1.0 = 1.0 — way above 1e-10
    write_ndjson(
        &p,
        r#"{"kind":"trial","rpm":9000,"imep_bar":9.0,"brake_power_kW":40.0,"ve_atm":0.85,"egt_mean_K":900.0,"mass_drift_kg":1.0,"mass_total_kg":1.0,"nonconservation":1e-2}"#,
    );
    let r = bin().args(["validate", p.to_str().unwrap()]).output().unwrap();
    assert!(
        !r.status.success(),
        "validate should FAIL on >band mass drift: stderr={}",
        String::from_utf8_lossy(&r.stderr)
    );
}

#[test]
fn validate_fails_on_egt_below_floor() {
    let dir = tempdir().unwrap();
    let p = dir.path().join("r.ndjson");
    write_ndjson(
        &p,
        r#"{"kind":"trial","rpm":9000,"imep_bar":9.0,"brake_power_kW":40.0,"ve_atm":0.85,"egt_mean_K":50.0,"mass_drift_kg":0.0,"mass_total_kg":0.005,"nonconservation":0.0}"#,
    );
    let r = bin().args(["validate", p.to_str().unwrap()]).output().unwrap();
    assert!(!r.status.success(), "validate should FAIL on EGT below 200 K floor");
}

#[test]
fn validate_fails_on_missing_environment_block() {
    let dir = tempdir().unwrap();
    let p = dir.path().join("r.ndjson");
    let mut f = std::fs::File::create(&p).unwrap();
    writeln!(
        f,
        r#"{{"kind":"trial","rpm":9000,"imep_bar":9.0,"brake_power_kW":40.0,"egt_mean_K":900.0,"mass_drift_kg":0.0,"mass_total_kg":0.005}}"#
    )
    .unwrap();
    drop(f);
    let r = bin().args(["validate", p.to_str().unwrap()]).output().unwrap();
    assert!(!r.status.success(), "validate should FAIL when env block is missing");
}

#[test]
fn validate_checks_can_be_selectively_skipped() {
    // With --checks=positivity, a clean trial passes even if mass info is missing.
    let dir = tempdir().unwrap();
    let p = dir.path().join("r.ndjson");
    write_ndjson(
        &p,
        r#"{"kind":"trial","rpm":9000,"imep_bar":9.0,"brake_power_kW":40.0,"ve_atm":0.85,"egt_mean_K":900.0}"#,
    );
    let r = bin()
        .args(["validate", p.to_str().unwrap(), "--checks", "positivity"])
        .output()
        .unwrap();
    assert!(
        r.status.success(),
        "validate --checks=positivity should pass: stderr={}",
        String::from_utf8_lossy(&r.stderr)
    );
}
