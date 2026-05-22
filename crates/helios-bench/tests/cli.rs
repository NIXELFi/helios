//! Top-level CLI smoke. Most subcommands have their own integration tests.

use std::process::Command;

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_helios-bench"))
}

#[test]
fn version_prints() {
    let out = bin().arg("--version").output().expect("spawn");
    assert!(out.status.success(), "--version failed: {:?}", out);
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("helios-bench"), "missing name: {stdout}");
}

#[test]
fn help_lists_subcommands() {
    let out = bin().arg("--help").output().expect("spawn");
    assert!(out.status.success());
    let stdout = String::from_utf8_lossy(&out.stdout);
    for sc in ["run", "sweep", "validate", "compare", "plot", "fingerprint"] {
        assert!(stdout.contains(sc), "help missing subcommand `{sc}`: {stdout}");
    }
}

/// plan-review-v1 #14: behavioral failing-then-passing test.
/// Each subcommand stub should exit non-zero with a "not yet implemented" message.
#[test]
fn run_subcommand_bails_with_not_yet_implemented() {
    let out = bin()
        .args(["run", "no-such.toml", "--out", "no-such.ndjson"])
        .output()
        .expect("spawn");
    assert!(!out.status.success(), "expected non-zero exit");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("not yet implemented"),
        "stderr should mention 'not yet implemented': {stderr}"
    );
}
