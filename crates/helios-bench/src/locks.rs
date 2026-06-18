//! Source-file lock ledger and orchestrator mutex per spec C3.
//!
//! Two primitives:
//!
//! - [`Manifest`] — one JSON file per active investigation under
//!   `.physics_locks/NNNN-<slug>.lock`. Lists every source file the
//!   spawned agent may modify.
//! - [`OrchestratorMutex`] — `.physics_locks/_orchestrator.mutex`
//!   acquired by O_EXCL create (POSIX) or `FileMode::CreateNew`
//!   (Windows). Released on `Drop`. Stale-mutex reclaim: file
//!   mtime older than [`MUTEX_STALE_SECS`] AND recorded `pid` not
//!   running.
//!
//! plan-review-v1 #11: `helios-bench locks parse-manifest <path>`
//! reads a `.lock` JSON and prints each `files[]` entry on its own
//! line. The pre-commit hook calls this — no python/jq dependency
//! on Windows.

use anyhow::{anyhow, bail, Context, Result};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Lock files older than this AND with a dead pid are reclaimable.
pub const MUTEX_STALE_SECS: u64 = 120;

/// Who spawned this investigation. Audit-only — both share the mutex.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpawnedBy {
    /// Interactive orchestrator session.
    Manual,
    /// Scheduled / batched orchestrator run.
    Cron,
}

/// One write-claim manifest. See `.physics_locks/README.md` for field semantics.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    pub id: u32,
    pub slug: String,
    pub worktree_path: String,
    pub spawned_by: SpawnedBy,
    pub spawned_at: String,
    /// Exhaustive list of repo-relative file paths the agent may modify.
    pub files: Vec<String>,
}

impl Manifest {
    /// Load a manifest from a `.lock` JSON file.
    pub fn load(path: &Path) -> Result<Self> {
        let body = std::fs::read_to_string(path)
            .with_context(|| format!("read manifest {}", path.display()))?;
        serde_json::from_str(&body)
            .with_context(|| format!("parse manifest {}", path.display()))
    }
}

/// Return any manifests in `existing` that overlap on at least one
/// `files[]` entry with `candidate`. The collision check is purely
/// path-string equality — orchestrator must normalize paths (forward
/// slashes, repo-relative) before invoking.
pub fn collisions_against(candidate: &Manifest, existing: &[Manifest]) -> Vec<Manifest> {
    use std::collections::HashSet;
    let cand: HashSet<&str> = candidate.files.iter().map(String::as_str).collect();
    existing
        .iter()
        .filter(|m| m.files.iter().any(|f| cand.contains(f.as_str())))
        .cloned()
        .collect()
}

/// O_EXCL mutex over the `.physics_locks/` directory. Acquired before
/// any orchestrator read/modify/write cycle. Released on `Drop`.
pub struct OrchestratorMutex {
    path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MutexContent {
    pid: u32,
    hostname: String,
    acquired_at: String,
}

impl OrchestratorMutex {
    /// Acquire the mutex. If a stale mutex (old mtime + dead pid) is
    /// present, reclaim it and re-acquire. Otherwise return an error
    /// describing who holds it.
    pub fn acquire(locks_dir: &Path) -> Result<Self> {
        match Self::try_acquire(locks_dir) {
            Ok(m) => Ok(m),
            Err(_) => {
                Self::reclaim_if_stale(locks_dir)
                    .context("reclaim stale mutex")?;
                Self::try_acquire(locks_dir).context("acquire after stale reclaim")
            }
        }
    }

    /// One-shot acquire attempt. No stale-reclaim. Fails if the
    /// mutex file already exists.
    pub fn try_acquire(locks_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(locks_dir)
            .with_context(|| format!("create_dir_all {}", locks_dir.display()))?;
        let path = locks_dir.join("_orchestrator.mutex");
        // create_new => O_EXCL on POSIX, FileMode::CreateNew on Windows.
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| anyhow!("acquire mutex {}: {}", path.display(), e))?;
        let content = MutexContent {
            pid: std::process::id(),
            hostname: gethostname(),
            acquired_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
        };
        let body = serde_json::to_string(&content)?;
        f.write_all(body.as_bytes())?;
        f.flush()?;
        Ok(Self { path })
    }

    fn reclaim_if_stale(locks_dir: &Path) -> Result<()> {
        let path = locks_dir.join("_orchestrator.mutex");
        if !path.exists() {
            return Ok(());
        }
        let meta = std::fs::metadata(&path)
            .with_context(|| format!("stat mutex {}", path.display()))?;
        let mtime = meta.modified().context("mtime")?;
        let age_secs = std::time::SystemTime::now()
            .duration_since(mtime)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let body = std::fs::read_to_string(&path).context("read mutex")?;
        let content: MutexContent =
            serde_json::from_str(&body).context("parse mutex content")?;
        let pid_alive = pid_is_running(content.pid);
        if age_secs > MUTEX_STALE_SECS && !pid_alive {
            std::fs::remove_file(&path).context("unlink stale mutex")?;
            Ok(())
        } else {
            bail!(
                "mutex held: pid {} ({}s old, alive={})",
                content.pid,
                age_secs,
                pid_alive
            );
        }
    }
}

impl Drop for OrchestratorMutex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn gethostname() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .or_else(|| std::env::var("HOSTNAME").ok())
        .unwrap_or_else(|| "unknown".into())
}

#[cfg(windows)]
fn pid_is_running(pid: u32) -> bool {
    // Win32 OpenProcess(SYNCHRONIZE, false, pid) — succeeds iff the
    // process handle table still has this pid. GetExitCodeProcess
    // returning STILL_ACTIVE (259) confirms it hasn't exited.
    use std::os::windows::raw::HANDLE;
    type Bool = i32;
    extern "system" {
        fn OpenProcess(desired_access: u32, inherit_handle: Bool, pid: u32) -> HANDLE;
        fn GetExitCodeProcess(handle: HANDLE, exit_code: *mut u32) -> Bool;
        fn CloseHandle(handle: HANDLE) -> Bool;
        fn GetLastError() -> u32;
    }
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const STILL_ACTIVE: u32 = 259;
    // OpenProcess can fail for two very different reasons. ERROR_INVALID_PARAMETER
    // means there is no such process (dead). ERROR_ACCESS_DENIED means the
    // process IS alive but owned by another user, so we must NOT treat it as
    // dead — otherwise a live mutex holder gets its lock reclaimed out from
    // under it.
    const ERROR_INVALID_PARAMETER: u32 = 87;
    // SAFETY: All pointers passed to Win32 are valid for the call's
    // lifetime; we close the handle before returning.
    unsafe {
        let h = OpenProcess(SYNCHRONIZE, 0, pid);
        if h.is_null() {
            // Distinguish "no such process" from "alive but not ours".
            let err = GetLastError();
            // Only ERROR_INVALID_PARAMETER (no such pid) counts as not running.
            // ERROR_ACCESS_DENIED means the process IS alive but owned by another
            // user (ERROR_ACCESS_DENIED == 5); any other failure likewise means
            // it's present. Err on the side of "alive" so a live mutex holder is
            // never reclaimed.
            return err != ERROR_INVALID_PARAMETER;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(h, &mut code) != 0;
        CloseHandle(h);
        ok && code == STILL_ACTIVE
    }
}

#[cfg(unix)]
fn pid_is_running(pid: u32) -> bool {
    // kill(pid, 0) returns 0 if the process exists and we can signal it.
    // SAFETY: kill with signal 0 is side-effect-free.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_serde_field_names() {
        let m = Manifest {
            id: 7,
            slug: "x".into(),
            worktree_path: "w".into(),
            spawned_by: SpawnedBy::Cron,
            spawned_at: "t".into(),
            files: vec!["a.rs".into()],
        };
        let v: serde_json::Value = serde_json::to_value(&m).unwrap();
        assert_eq!(v["spawned_by"], "cron");
        assert_eq!(v["worktree_path"], "w");
        assert_eq!(v["files"][0], "a.rs");
    }
}
