//! NDJSON writer + environment capture (Task 3). Spec C4: every NDJSON
//! result file MUST have an environment block as its first line.

use helios_bench::ndjson::ResultWriter;
use helios_bench::study::Environment;
use serde_json::json;
use std::fs::File;
use std::io::{BufRead, BufReader};
use tempfile::NamedTempFile;

fn env() -> Environment {
    Environment {
        target_triple: "x86_64-pc-windows-msvc".into(),
        rustc_version: "1.78.0".into(),
        rayon_threads: 1,
        libm_source: "rust-builtin".into(),
    }
}

#[test]
fn first_line_is_environment() {
    let tmp = NamedTempFile::new().unwrap();
    let mut w = ResultWriter::create(tmp.path(), &env(), Some(7), "abc123").unwrap();
    w.write(&json!({"trial": 1, "imep_bar": 9.5})).unwrap();
    w.finish().unwrap();

    let r = BufReader::new(File::open(tmp.path()).unwrap());
    let lines: Vec<String> = r.lines().filter_map(|l| l.ok()).collect();
    assert_eq!(lines.len(), 2);
    let env_line: serde_json::Value = serde_json::from_str(&lines[0]).unwrap();
    assert_eq!(env_line["kind"], "environment");
    assert_eq!(env_line["env"]["target_triple"], "x86_64-pc-windows-msvc");
    assert_eq!(env_line["seed"], 7);
    assert_eq!(env_line["commit_hash"], "abc123");
    // plan-review-v1 #12: timestamp uses chrono RFC3339 with 'Z' suffix.
    let ts = env_line["timestamp_utc"].as_str().expect("timestamp_utc present");
    assert!(ts.ends_with('Z'), "timestamp must be UTC ISO8601 with Z: {ts}");

    let trial: serde_json::Value = serde_json::from_str(&lines[1]).unwrap();
    assert_eq!(trial["trial"], 1);
}

#[test]
fn drop_without_finish_still_has_env_line() {
    let tmp = NamedTempFile::new().unwrap();
    {
        let mut w = ResultWriter::create(tmp.path(), &env(), Some(7), "abc").unwrap();
        w.write(&json!({"trial": 1})).unwrap();
        // drop without finish
    }
    // File exists; flush-on-each-write means env line + 1 trial line.
    let r = BufReader::new(File::open(tmp.path()).unwrap());
    let lines: Vec<String> = r.lines().filter_map(|l| l.ok()).collect();
    assert!(!lines.is_empty(), "env block must be present");
    let env_line: serde_json::Value = serde_json::from_str(&lines[0]).unwrap();
    assert_eq!(env_line["kind"], "environment");
}

#[test]
fn environment_capture_reports_real_target_triple() {
    // build.rs writes HELIOS_BENCH_TARGET_TRIPLE; smoke-check it's non-empty.
    let t = helios_bench::environment::target_triple();
    assert!(!t.is_empty(), "target_triple must be populated by build.rs");
    let v = helios_bench::environment::rustc_version();
    assert!(v.contains("rustc"), "rustc_version should contain 'rustc': {v}");
}
