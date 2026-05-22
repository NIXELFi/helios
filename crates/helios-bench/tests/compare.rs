//! `helios-bench compare` smoke tests.
//!
//! Aligns trials by `(rpm, overrides)`, emits per-metric absolute +
//! relative deltas as a markdown table to stdout. Unmatched trials
//! land in a separate section.

use std::io::Write;
use std::process::Command;
use tempfile::tempdir;

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_helios-bench"))
}

const ENV_LINE: &str = r#"{"kind":"environment","env":{"target_triple":"x","rustc_version":"x","rayon_threads":1,"libm_source":"x"},"seed":1,"commit_hash":"abc"}"#;

fn write_ndjson(path: &std::path::Path, trial_rows: &[&str]) {
    let mut f = std::fs::File::create(path).unwrap();
    writeln!(f, "{ENV_LINE}").unwrap();
    for r in trial_rows {
        writeln!(f, "{r}").unwrap();
    }
}

#[test]
fn compare_aligns_matching_trial_and_reports_unmatched() {
    let dir = tempdir().unwrap();
    let a = dir.path().join("a.ndjson");
    let b = dir.path().join("b.ndjson");

    // file A: one matching trial (rpm=9000, overrides {wiebe_a: 5.0})
    //         + one A-only trial (rpm=12000, no overrides)
    write_ndjson(
        &a,
        &[
            r#"{"kind":"trial","rpm":9000,"overrides":{"wiebe_a":5.0},"imep_bar":9.0,"brake_power_kW":40.0}"#,
            r#"{"kind":"trial","rpm":12000,"overrides":{},"imep_bar":11.0,"brake_power_kW":52.0}"#,
        ],
    );
    // file B: the matching trial with slightly different imep
    //         + one B-only trial (rpm=15000)
    write_ndjson(
        &b,
        &[
            r#"{"kind":"trial","rpm":9000,"overrides":{"wiebe_a":5.0},"imep_bar":9.5,"brake_power_kW":42.0}"#,
            r#"{"kind":"trial","rpm":15000,"overrides":{},"imep_bar":12.0,"brake_power_kW":55.0}"#,
        ],
    );

    let r = bin()
        .args(["compare", a.to_str().unwrap(), b.to_str().unwrap()])
        .output()
        .expect("spawn");
    assert!(
        r.status.success(),
        "compare failed: stderr={}",
        String::from_utf8_lossy(&r.stderr)
    );
    let stdout = String::from_utf8_lossy(&r.stdout);
    // Markdown table header for aligned trials.
    assert!(stdout.contains("| metric |"), "missing markdown header: {stdout}");
    assert!(stdout.contains("imep_bar"), "missing imep_bar row: {stdout}");
    assert!(stdout.contains("brake_power_kW"), "missing brake_power_kW row: {stdout}");
    // Unmatched section.
    assert!(
        stdout.to_lowercase().contains("unmatched"),
        "missing unmatched section: {stdout}"
    );
    // Specific unmatched trials.
    assert!(stdout.contains("12000"), "rpm=12000 (a-only) missing: {stdout}");
    assert!(stdout.contains("15000"), "rpm=15000 (b-only) missing: {stdout}");
}

#[test]
fn compare_fails_on_missing_file() {
    let out = bin()
        .args(["compare", "no-such-a.ndjson", "no-such-b.ndjson"])
        .output()
        .expect("spawn");
    assert!(!out.status.success(), "expected non-zero exit on missing files");
}

#[test]
fn compare_handles_all_matching_no_unmatched_section() {
    let dir = tempdir().unwrap();
    let a = dir.path().join("a.ndjson");
    let b = dir.path().join("b.ndjson");
    write_ndjson(
        &a,
        &[r#"{"kind":"trial","rpm":9000,"overrides":{"x":1.0},"imep_bar":9.0,"brake_power_kW":40.0}"#],
    );
    write_ndjson(
        &b,
        &[r#"{"kind":"trial","rpm":9000,"overrides":{"x":1.0},"imep_bar":9.1,"brake_power_kW":40.5}"#],
    );
    let r = bin()
        .args(["compare", a.to_str().unwrap(), b.to_str().unwrap()])
        .output()
        .expect("spawn");
    assert!(r.status.success(), "stderr={}", String::from_utf8_lossy(&r.stderr));
    let stdout = String::from_utf8_lossy(&r.stdout);
    assert!(stdout.contains("imep_bar"));
    // When everything matches, the "unmatched" section should be empty
    // (header may still print but list should be empty).
    let last_section = stdout.split("Unmatched").nth(1).unwrap_or("");
    assert!(
        !last_section.contains("rpm="),
        "no unmatched trials expected: {last_section}"
    );
}
