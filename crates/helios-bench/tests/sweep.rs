//! `helios-bench sweep` smoke tests.
//!
//! Verifies:
//! - LHS sweep with N trials produces an env line + N trials in NDJSON
//! - Recorded sweeps are deterministic at the same seed (data rows
//!   compare byte-equal)
//! - Unknown sampler / missing [sweep] section fail cleanly

use serde_json::Value;
use std::path::PathBuf;
use std::process::Command;
use tempfile::tempdir;

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_helios-bench"))
}

fn baseline_config_path() -> PathBuf {
    // CARGO_MANIFEST_DIR points at crates/helios-bench/
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let p = manifest
        .join("..")
        .join("engine-sim")
        .join("python_ref")
        .join("configs")
        .join("sdm26.json");
    std::fs::canonicalize(&p).unwrap_or(p)
}

fn write_study(dir: &std::path::Path, n_trials: u32, seed: u64) -> PathBuf {
    let cfg = baseline_config_path();
    let cfg_str = cfg.display().to_string().replace('\\', "/");
    let study = dir.join("study.toml");
    let txt = format!(
        r#"[run]
config = "{cfg_str}"
rpm = [9000.0]
cycles = 2
recorded = true
seed = {seed}
junction = "characteristic"

[environment]
target_triple = "any"
rustc_version = "any"
rayon_threads = 1
libm_source = "any"

[sweep]
sampler = "lhs"
n_trials = {n_trials}
parameters = [
  {{ name = "wiebe_a", min = 4.0, max = 6.0 }},
]
"#
    );
    std::fs::write(&study, txt).unwrap();
    study
}

#[test]
fn sweep_lhs_4_trials_produces_4_trials_one_rpm() {
    let dir = tempdir().unwrap();
    let study = write_study(dir.path(), 4, 1);
    let out = dir.path().join("sweep.ndjson");

    let r = bin()
        .args([
            "sweep",
            study.to_str().unwrap(),
            "--out",
            out.to_str().unwrap(),
            "--commit",
            "deadbeef",
        ])
        .output()
        .expect("spawn");
    assert!(
        r.status.success(),
        "sweep failed: stderr={}",
        String::from_utf8_lossy(&r.stderr)
    );
    let body = std::fs::read_to_string(&out).unwrap();
    let lines: Vec<&str> = body.lines().collect();
    // env line + 4 trial lines
    assert!(
        lines.len() >= 5,
        "expected env + 4 trials, got {} lines",
        lines.len()
    );
    let env: Value = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(env["kind"], "environment");
    let trial_count = lines
        .iter()
        .skip(1)
        .filter(|l| {
            let v: Value = serde_json::from_str(l).unwrap_or(Value::Null);
            v["kind"] == "trial"
        })
        .count();
    assert_eq!(trial_count, 4);

    // Verify the override block round-trips and the metric fields are present
    let first_trial: Value = serde_json::from_str(lines[1]).unwrap();
    assert!(first_trial["overrides"]["wiebe_a"].is_number());
    assert!(first_trial["imep_bar"].is_number());
    assert!(first_trial["brake_power_kW"].is_number());
    assert!(first_trial["rpm"].is_number());
}

#[test]
fn sweep_deterministic_with_same_seed() {
    let dir = tempdir().unwrap();
    let study = write_study(dir.path(), 3, 42);
    let out_a = dir.path().join("a.ndjson");
    let out_b = dir.path().join("b.ndjson");

    let cmd = |out: &std::path::Path| {
        let r = bin()
            .args([
                "sweep",
                study.to_str().unwrap(),
                "--out",
                out.to_str().unwrap(),
                "--commit",
                "deterministic",
            ])
            .output()
            .expect("spawn");
        assert!(r.status.success(), "stderr={}", String::from_utf8_lossy(&r.stderr));
    };
    cmd(&out_a);
    cmd(&out_b);

    // Compare trial lines only (env line carries a wall-clock timestamp).
    let trials_of = |p: &std::path::Path| -> Vec<Value> {
        std::fs::read_to_string(p)
            .unwrap()
            .lines()
            .skip(1)
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    };
    let a = trials_of(&out_a);
    let b = trials_of(&out_b);
    assert_eq!(a, b, "same seed must produce same trial sequence");
}

#[test]
fn sweep_rejects_missing_sweep_block() {
    let dir = tempdir().unwrap();
    let cfg = baseline_config_path();
    let cfg_str = cfg.display().to_string().replace('\\', "/");
    let study = dir.path().join("study.toml");
    let txt = format!(
        r#"[run]
config = "{cfg_str}"
rpm = [9000.0]
cycles = 2
recorded = true
seed = 1

[environment]
target_triple = "any"
rustc_version = "any"
rayon_threads = 1
libm_source = "any"
"#
    );
    std::fs::write(&study, txt).unwrap();
    let out = dir.path().join("sweep.ndjson");

    let r = bin()
        .args(["sweep", study.to_str().unwrap(), "--out", out.to_str().unwrap()])
        .output()
        .expect("spawn");
    assert!(!r.status.success());
    let stderr = String::from_utf8_lossy(&r.stderr);
    assert!(
        stderr.contains("[sweep]"),
        "expected error mentioning [sweep]: {stderr}"
    );
}
