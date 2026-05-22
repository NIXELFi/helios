//! Lock-ledger semantics per spec C3.
//!
//! Validates:
//! - `Manifest` JSON roundtrip
//! - `collisions_against` returns overlapping manifests on shared files
//! - `OrchestratorMutex` is exclusive (O_EXCL create) and self-cleans on drop
//! - Stale mutex (old mtime + dead pid) is reclaimable

use helios_bench::locks::*;
use std::process::Command;
use tempfile::tempdir;

#[test]
fn manifest_roundtrip() {
    let m = Manifest {
        id: 42,
        slug: "woschni-c1-c2".into(),
        worktree_path: "worktrees/agent-0042-woschni-c1-c2".into(),
        spawned_by: SpawnedBy::Manual,
        spawned_at: "2026-05-22T12:00:00Z".into(),
        files: vec!["crates/engine-sim/src/cylinder/heat.rs".into()],
    };
    let s = serde_json::to_string(&m).unwrap();
    let m2: Manifest = serde_json::from_str(&s).unwrap();
    assert_eq!(m, m2);
}

#[test]
fn spawned_by_serializes_lowercase() {
    let s = serde_json::to_string(&SpawnedBy::Cron).unwrap();
    assert_eq!(s, "\"cron\"");
    let s = serde_json::to_string(&SpawnedBy::Manual).unwrap();
    assert_eq!(s, "\"manual\"");
}

#[test]
fn no_collision_when_disjoint_files() {
    let a = Manifest {
        id: 1,
        slug: "a".into(),
        worktree_path: "w/a".into(),
        spawned_by: SpawnedBy::Manual,
        spawned_at: "t".into(),
        files: vec!["foo.rs".into()],
    };
    let b = Manifest {
        id: 2,
        slug: "b".into(),
        worktree_path: "w/b".into(),
        spawned_by: SpawnedBy::Manual,
        spawned_at: "t".into(),
        files: vec!["bar.rs".into()],
    };
    let collisions = collisions_against(&b, std::slice::from_ref(&a));
    assert!(collisions.is_empty(), "disjoint files should not collide");
}

#[test]
fn collision_when_overlapping_file() {
    let a = Manifest {
        id: 1,
        slug: "a".into(),
        worktree_path: "w/a".into(),
        spawned_by: SpawnedBy::Manual,
        spawned_at: "t".into(),
        files: vec!["foo.rs".into(), "shared.rs".into()],
    };
    let b = Manifest {
        id: 2,
        slug: "b".into(),
        worktree_path: "w/b".into(),
        spawned_by: SpawnedBy::Manual,
        spawned_at: "t".into(),
        files: vec!["bar.rs".into(), "shared.rs".into()],
    };
    let collisions = collisions_against(&b, std::slice::from_ref(&a));
    assert_eq!(collisions.len(), 1);
    assert_eq!(collisions[0].id, 1);
}

#[test]
fn mutex_o_excl_creates_exclusively_and_drops_clean() {
    let dir = tempdir().unwrap();
    let m1 = OrchestratorMutex::try_acquire(dir.path()).unwrap();
    // Second try while first is held: must fail.
    let r = OrchestratorMutex::try_acquire(dir.path());
    assert!(
        r.is_err(),
        "second try_acquire while first held should fail: {:?}",
        r.err()
    );
    drop(m1);
    // After drop, the mutex file should be gone.
    let path = dir.path().join("_orchestrator.mutex");
    assert!(!path.exists(), "mutex file should be removed on Drop");
    let _m2 = OrchestratorMutex::try_acquire(dir.path()).unwrap();
}

#[test]
fn mutex_stale_reclaim_after_old_mtime_and_dead_pid() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("_orchestrator.mutex");
    // Write a stale mutex file with a pid that's almost certainly dead.
    std::fs::write(
        &path,
        r#"{"pid":4294967294,"hostname":"x","acquired_at":"2000-01-01T00:00:00Z"}"#,
    )
    .unwrap();
    // Force an old mtime (very far in the past).
    let old = filetime::FileTime::from_unix_time(946_684_800, 0); // 2000-01-01
    filetime::set_file_mtime(&path, old).unwrap();
    // `acquire` should reclaim the stale mutex and re-acquire it.
    let _m = OrchestratorMutex::acquire(dir.path()).expect("stale mutex should be reclaimable");
}

#[test]
fn parse_manifest_subcommand_emits_files_one_per_line() {
    // Write a manifest JSON to a tempdir and pipe it through the CLI.
    let dir = tempdir().unwrap();
    let lock_path = dir.path().join("0001-demo.lock");
    let manifest = Manifest {
        id: 1,
        slug: "demo".into(),
        worktree_path: "worktrees/agent-0001-demo".into(),
        spawned_by: SpawnedBy::Manual,
        spawned_at: "2026-05-22T00:00:00Z".into(),
        files: vec![
            "crates/engine-sim/src/cylinder/heat.rs".into(),
            "crates/cfd-core/tests/regressions_0001_demo.rs".into(),
        ],
    };
    std::fs::write(&lock_path, serde_json::to_string_pretty(&manifest).unwrap()).unwrap();

    let out = Command::new(env!("CARGO_BIN_EXE_helios-bench"))
        .args(["locks", "parse-manifest", lock_path.to_str().unwrap()])
        .output()
        .expect("spawn");
    assert!(
        out.status.success(),
        "parse-manifest failed: stderr={}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    let lines: Vec<&str> = stdout.lines().collect();
    assert_eq!(lines.len(), 2, "expected 2 file lines, got {lines:?}");
    assert_eq!(lines[0], "crates/engine-sim/src/cylinder/heat.rs");
    assert_eq!(lines[1], "crates/cfd-core/tests/regressions_0001_demo.rs");
}

#[test]
fn parse_manifest_subcommand_fails_on_missing_file() {
    let out = Command::new(env!("CARGO_BIN_EXE_helios-bench"))
        .args(["locks", "parse-manifest", "definitely-not-a-file.lock"])
        .output()
        .expect("spawn");
    assert!(!out.status.success(), "expected non-zero exit");
}

#[test]
fn parse_manifest_subcommand_fails_on_invalid_json() {
    let dir = tempdir().unwrap();
    let p = dir.path().join("bad.lock");
    std::fs::write(&p, "not json").unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_helios-bench"))
        .args(["locks", "parse-manifest", p.to_str().unwrap()])
        .output()
        .expect("spawn");
    assert!(!out.status.success(), "expected non-zero exit on bad JSON");
}
