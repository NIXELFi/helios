//! Smoke: `helios-bench run` on a real SDM26 config emits NDJSON whose
//! first line is the environment block and whose subsequent lines have
//! the expected trial fields (imep_bar, brake_power_kW, rpm).
//!
//! plan-review-v1 #8: uses `crates/engine-sim/python_ref/configs/sdm26.json`
//! (the canonical baseline) — not the made-up
//! `engine_matrix_sdm26_baseline.json` that the plan body referenced.

use std::process::Command;
use tempfile::tempdir;

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_helios-bench"))
}

#[test]
fn run_produces_ndjson_with_env_first_line() {
    let dir = tempdir().unwrap();
    let study_path = dir.path().join("study.toml");
    let out_path = dir.path().join("results.ndjson");

    // CARGO_MANIFEST_DIR points at crates/helios-bench; go up two to
    // the workspace root, then into engine-sim/python_ref/configs.
    let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let cfg = manifest
        .parent()
        .unwrap()
        .join("engine-sim/python_ref/configs/sdm26.json");
    let cfg = std::fs::canonicalize(&cfg)
        .unwrap_or_else(|e| panic!("baseline config not found at {}: {e}", cfg.display()));

    let cfg_str = cfg.display().to_string().replace('\\', "/");

    // Single low RPM, 2 cycles, no convergence early-stop — keeps the
    // smoke quick on a debug build.
    let toml_text = format!(
        r#"
[run]
config = "{cfg_str}"
rpm = [6000.0]
cycles = 2
recorded = true
seed = 1
junction = "characteristic"

[environment]
target_triple = "any"
rustc_version = "any"
rayon_threads = 1
libm_source = "any"
"#
    );
    std::fs::write(&study_path, toml_text).unwrap();

    let out = bin()
        .args([
            "run",
            study_path.to_str().unwrap(),
            "--out",
            out_path.to_str().unwrap(),
            "--commit",
            "smoke-test",
        ])
        .output()
        .expect("spawn helios-bench");
    assert!(
        out.status.success(),
        "run failed:\nstdout={}\nstderr={}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );

    let body = std::fs::read_to_string(&out_path).unwrap();
    let lines: Vec<&str> = body.lines().collect();
    assert!(
        lines.len() >= 2,
        "expected env line + at least one trial; got {}: {body}",
        lines.len()
    );

    let env: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(env["kind"], "environment");
    assert_eq!(env["commit_hash"], "smoke-test");
    assert_eq!(env["seed"], 1);

    let trial: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
    assert_eq!(trial["kind"], "trial");
    assert!(trial["imep_bar"].is_number(), "trial missing imep_bar: {trial}");
    assert!(
        trial["brake_power_kW"].is_number(),
        "trial missing brake_power_kW: {trial}"
    );
    assert_eq!(trial["rpm"], 6000.0);
    assert_eq!(trial["n_cycles_run"], 2);
}
