//! `helios-bench fingerprint` smoke tests.
//!
//! Two modes:
//! - `--suggest --package <name>`: walks cargo metadata, lists `*.rs` under
//!   `src/` and `tests/` as workspace-relative forward-slash paths.
//! - `--files <list>`: reads a newline-separated file list, computes SHA-256
//!   per file, emits `<hex>  <path>` to stdout.

use std::process::Command;
use tempfile::tempdir;

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_helios-bench"))
}

#[test]
fn suggest_lists_engine_sim_sources() {
    let out = bin()
        .args(["fingerprint", "--suggest", "--package", "engine-sim"])
        .output()
        .expect("spawn");
    assert!(
        out.status.success(),
        "fingerprint --suggest failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    // Canonical anchor file — the SDM26 model lives here.
    assert!(
        stdout.contains("crates/engine-sim/src/model/sdm26.rs"),
        "stdout missing sdm26.rs:\n{stdout}"
    );
    // All emitted paths must use forward slashes (workspace-relative).
    for line in stdout.lines() {
        assert!(
            !line.contains('\\'),
            "path should use forward slashes: {line:?}"
        );
        assert!(
            line.ends_with(".rs"),
            "non-.rs line in suggest output: {line:?}"
        );
    }
}

#[test]
fn suggest_lists_helios_bench_sources() {
    let out = bin()
        .args(["fingerprint", "--suggest", "--package", "helios-bench"])
        .output()
        .expect("spawn");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        stdout.contains("crates/helios-bench/src/lib.rs"),
        "missing lib.rs:\n{stdout}"
    );
}

/// Compute the expected SHA-256 hex digest of a byte slice — used to
/// pin the subcommand output against a ground-truth that's independent
/// of host line-ending behavior.
fn expected_sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

#[test]
fn files_mode_emits_sha256_per_line() {
    let dir = tempdir().unwrap();
    // Byte-exact write (avoids Windows's \r\n translation in writeln!).
    let a = dir.path().join("a.txt");
    let b = dir.path().join("b.txt");
    use std::io::Write as _;
    std::fs::File::create(&a).unwrap().write_all(b"hello\n").unwrap();
    std::fs::File::create(&b).unwrap().write_all(b"world\n").unwrap();

    let list = dir.path().join("files.txt");
    let mut f = std::fs::File::create(&list).unwrap();
    writeln!(f, "{}", a.display()).unwrap();
    writeln!(f, "{}", b.display()).unwrap();
    drop(f);

    let out = bin()
        .args(["fingerprint", "--files", list.to_str().unwrap()])
        .output()
        .expect("spawn");
    assert!(
        out.status.success(),
        "fingerprint --files failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    let lines: Vec<&str> = stdout.lines().collect();
    assert_eq!(lines.len(), 2, "expected 2 hash lines, got: {stdout:?}");

    let expected_a = expected_sha256_hex(b"hello\n");
    let expected_b = expected_sha256_hex(b"world\n");
    assert!(
        lines[0].starts_with(&expected_a),
        "a.txt hash mismatch: got {}, expected prefix {}",
        lines[0],
        expected_a
    );
    assert!(
        lines[1].starts_with(&expected_b),
        "b.txt hash mismatch: got {}, expected prefix {}",
        lines[1],
        expected_b
    );
}

#[test]
fn files_mode_fails_on_missing_file_in_list() {
    let dir = tempdir().unwrap();
    let list = dir.path().join("files.txt");
    std::fs::write(&list, "no-such-file.txt\n").unwrap();
    let out = bin()
        .args(["fingerprint", "--files", list.to_str().unwrap()])
        .output()
        .expect("spawn");
    assert!(!out.status.success(), "expected non-zero exit for missing file");
}

#[test]
fn fingerprint_requires_a_mode() {
    let out = bin().args(["fingerprint"]).output().expect("spawn");
    assert!(!out.status.success(), "expected non-zero exit when neither --suggest nor --files given");
}
