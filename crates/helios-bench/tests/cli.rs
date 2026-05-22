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
/// Subcommands that are still stubs should exit non-zero with a
/// "not yet implemented" message. We rotate through whichever
/// subcommand is still a stub at the current Phase 0 milestone.
/// As of Tasks 10/11 land, `plot` and `compare` are still stubs;
/// `plot` is picked here.
#[test]
fn stubbed_subcommand_bails_with_not_yet_implemented() {
    // `compare` is the last subcommand still a stub at this milestone.
    let out = bin()
        .args(["compare", "no-such-a.ndjson", "no-such-b.ndjson"])
        .output()
        .expect("spawn");
    assert!(!out.status.success(), "expected non-zero exit");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("not yet implemented"),
        "stderr should mention 'not yet implemented': {stderr}"
    );
}

/// `run` rejects a missing study.toml with a clear filesystem error
/// (not the "not yet implemented" message anymore — it now actually
/// tries to read the file).
#[test]
fn run_rejects_missing_study_file() {
    let out = bin()
        .args(["run", "definitely-not-a-file.toml", "--out", "x.ndjson"])
        .output()
        .expect("spawn");
    assert!(!out.status.success(), "expected non-zero exit");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.to_lowercase().contains("read") || stderr.to_lowercase().contains("system cannot find"),
        "stderr should describe a read error: {stderr}"
    );
}
