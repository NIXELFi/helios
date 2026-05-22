//! `helios-bench plot` emits SVGs from an NDJSON result file.
//!
//! Three plots per invocation, written under `--out-dir`:
//! - `power_curve.svg`: brake_power_kW vs RPM
//! - `pv_loop.svg`: requires per-cycle traces — Phase 0 emits a
//!   placeholder SVG (no trace data in CycleStats yet)
//! - `bsfc_curve.svg`: bsfc_g_per_kWh vs RPM if available, else placeholder

use std::io::Write;
use std::process::Command;
use tempfile::tempdir;

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_helios-bench"))
}

fn write_results(path: &std::path::Path, rows: &[&str]) {
    let mut f = std::fs::File::create(path).unwrap();
    writeln!(
        f,
        r#"{{"kind":"environment","env":{{"target_triple":"x","rustc_version":"x","rayon_threads":1,"libm_source":"x"}},"seed":1,"commit_hash":"abc"}}"#
    )
    .unwrap();
    for r in rows {
        writeln!(f, "{r}").unwrap();
    }
}

#[test]
fn plot_emits_power_curve_svg_with_polyline() {
    let dir = tempdir().unwrap();
    let results = dir.path().join("r.ndjson");
    let out_dir = dir.path().join("plots");
    write_results(
        &results,
        &[
            r#"{"kind":"trial","rpm":6000,"brake_power_kW":20.0}"#,
            r#"{"kind":"trial","rpm":9000,"brake_power_kW":35.0}"#,
            r#"{"kind":"trial","rpm":12000,"brake_power_kW":45.0}"#,
        ],
    );

    let r = bin()
        .args([
            "plot",
            results.to_str().unwrap(),
            "--out-dir",
            out_dir.to_str().unwrap(),
        ])
        .output()
        .expect("spawn");
    assert!(
        r.status.success(),
        "plot failed: stderr={}",
        String::from_utf8_lossy(&r.stderr)
    );

    let power = std::fs::read_to_string(out_dir.join("power_curve.svg")).unwrap();
    assert!(power.contains("<svg"), "power_curve missing <svg header:\n{power}");
    assert!(
        power.contains("<polyline"),
        "power_curve missing <polyline:\n{power}"
    );
}

#[test]
fn plot_emits_pv_loop_placeholder_when_no_trace_data() {
    let dir = tempdir().unwrap();
    let results = dir.path().join("r.ndjson");
    let out_dir = dir.path().join("plots");
    write_results(
        &results,
        &[r#"{"kind":"trial","rpm":9000,"brake_power_kW":35.0}"#],
    );

    let r = bin()
        .args([
            "plot",
            results.to_str().unwrap(),
            "--out-dir",
            out_dir.to_str().unwrap(),
        ])
        .output()
        .expect("spawn");
    assert!(r.status.success(), "stderr={}", String::from_utf8_lossy(&r.stderr));

    let pv = std::fs::read_to_string(out_dir.join("pv_loop.svg")).unwrap();
    assert!(pv.contains("<svg"));
    assert!(
        pv.contains("needs trace data") || pv.contains("placeholder"),
        "pv_loop should be a placeholder: {pv}"
    );
}

#[test]
fn plot_emits_bsfc_curve_when_field_present() {
    let dir = tempdir().unwrap();
    let results = dir.path().join("r.ndjson");
    let out_dir = dir.path().join("plots");
    write_results(
        &results,
        &[
            r#"{"kind":"trial","rpm":6000,"brake_power_kW":20.0,"bsfc_g_per_kWh":310.0}"#,
            r#"{"kind":"trial","rpm":9000,"brake_power_kW":35.0,"bsfc_g_per_kWh":295.0}"#,
            r#"{"kind":"trial","rpm":12000,"brake_power_kW":45.0,"bsfc_g_per_kWh":305.0}"#,
        ],
    );

    let r = bin()
        .args([
            "plot",
            results.to_str().unwrap(),
            "--out-dir",
            out_dir.to_str().unwrap(),
        ])
        .output()
        .expect("spawn");
    assert!(r.status.success(), "stderr={}", String::from_utf8_lossy(&r.stderr));

    let bsfc = std::fs::read_to_string(out_dir.join("bsfc_curve.svg")).unwrap();
    assert!(bsfc.contains("<svg"));
    assert!(bsfc.contains("<polyline"), "bsfc curve missing polyline: {bsfc}");
}

#[test]
fn plot_bsfc_is_placeholder_when_field_missing() {
    let dir = tempdir().unwrap();
    let results = dir.path().join("r.ndjson");
    let out_dir = dir.path().join("plots");
    write_results(
        &results,
        &[r#"{"kind":"trial","rpm":9000,"brake_power_kW":35.0}"#],
    );

    let r = bin()
        .args([
            "plot",
            results.to_str().unwrap(),
            "--out-dir",
            out_dir.to_str().unwrap(),
        ])
        .output()
        .expect("spawn");
    assert!(r.status.success());
    let bsfc = std::fs::read_to_string(out_dir.join("bsfc_curve.svg")).unwrap();
    assert!(
        bsfc.contains("placeholder") || bsfc.contains("bsfc_g_per_kWh not present"),
        "bsfc should be a placeholder when bsfc_g_per_kWh missing: {bsfc}"
    );
}
