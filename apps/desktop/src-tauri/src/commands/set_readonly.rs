//! Toggle the OS read-only bit on a file.
//!
//! The Vault's "real vault" model keeps local working copies read-only until a
//! file is checked out (see docs/superpowers/specs/2026-05-30-vault-real-vault-
//! checkout-design.md). The Tauri `fs` plugin exposes no chmod/set-permissions
//! command, so this small app command provides the primitive.
//!
//! This is an APP command (registered via `generate_handler!`), not a plugin
//! command, so it is invocable from the frontend without a capability/ACL grant
//! — capabilities only gate plugin + core commands. No capabilities change is
//! required for this to work.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

/// Set or clear the read-only attribute on `path`. Cross-platform:
/// `Permissions::set_readonly` maps to the Windows read-only file attribute and
/// to clearing/setting the owner+group+other write bits on Unix.
///
/// `async` in the attribute runs it on Tauri's worker pool instead of the main
/// thread (a plain `fn` command runs on the main thread). Vault sync and bulk
/// check-out/check-in call this once per file, and on the main thread a long
/// burst of them queued ahead of the title bar's minimize/maximize/close
/// calls, which need the main thread too.
#[tauri::command(async)]
pub fn set_path_readonly(path: String, readonly: bool) -> Result<(), String> {
    // Input hardening: reject symlinks and operate on the canonical target.
    // `set_path_readonly` is reachable from any renderer context (it's an app
    // command, not capability-gated — see the module-level note), so a path that
    // is (or traverses) a symlink could be used to flip the read-only bit on a
    // file outside the vault. `symlink_metadata` does NOT follow the final
    // component, so this catches a symlinked leaf; `canonicalize` then resolves
    // any symlinked ancestors and `..` segments to a real, fully-resolved path we
    // operate on (so the byte we touch is exactly the one we validated).
    let lmeta = fs::symlink_metadata(&path).map_err(|e| format!("stat {path}: {e}"))?;
    if lmeta.file_type().is_symlink() {
        return Err(format!("refusing to operate on a symlink: {path}"));
    }
    let canonical = fs::canonicalize(&path).map_err(|e| format!("resolve {path}: {e}"))?;
    let meta = fs::metadata(&canonical).map_err(|e| format!("stat {path}: {e}"))?;
    let mut perm = meta.permissions();
    perm.set_readonly(readonly);
    fs::set_permissions(&canonical, perm)
        .map_err(|e| format!("set_permissions {path}: {e}"))?;
    Ok(())
}

/// Flip an OPEN SOLIDWORKS document's in-session read-only state via the bundled
/// out-of-process helper (`swhelper/HeliosSwReadonly.exe`). The on-disk read-only
/// bit (set above) only governs how SOLIDWORKS opens a file NEXT time; if the
/// file is already open, SOLIDWORKS keeps its session state until reloaded. The
/// SOLIDWORKS add-in normally fixes that in-process — this helper does it
/// WITHOUT the add-in (so a missing / broken / disabled add-in no longer breaks
/// "check out -> editable" / "check in -> read-only").
///
/// Best-effort + fire-and-forget on a background thread + hidden window: it
/// no-ops harmlessly when SOLIDWORKS isn't running, the file isn't open, or the
/// helper is absent. Each call is a thread + a process, so bulk callers should
/// go through the serial queue in `flipSwReadonly` (fs-readonly.ts) rather than
/// fire this per file.
pub fn flip_sw_readonly(app: &AppHandle, path: &str, readonly: bool) {
    let Some(exe) = resolve_sw_helper(app) else { return };
    let path = path.to_string();
    let mode = helper_mode(readonly);
    std::thread::Builder::new()
        .name("helios-sw-readonly".into())
        .spawn(move || {
            run_helper(&exe, &path, mode, HELPER_TIMEOUT);
        })
        .ok();
}

/// Frontend-callable: flip an open SOLIDWORKS document's read-only state. Used
/// by the desktop vault UI (RowActions) on check-out / check-in / cancel so the
/// behavior matches the add-in even when the add-in isn't there.
///
/// Unlike [`flip_sw_readonly`] this resolves only when the helper has EXITED
/// (or been killed after [`HELPER_TIMEOUT`]), which is what lets the frontend
/// queue (`flipSwReadonly` in fs-readonly.ts) keep at most one helper process
/// in flight during a bulk check-out / check-in instead of one per file. The
/// wait runs on the blocking pool, so it never stalls the command executor.
#[tauri::command]
pub async fn sw_flip_readonly(app: AppHandle, path: String, readonly: bool) {
    let Some(exe) = resolve_sw_helper(&app) else { return };
    let mode = helper_mode(readonly);
    let _ = tauri::async_runtime::spawn_blocking(move || {
        run_helper(&exe, &path, mode, HELPER_TIMEOUT);
    })
    .await;
}

/// Longest the helper may run before it is killed. It attaches to a live
/// SOLIDWORKS session over COM, which can hang while SOLIDWORKS is busy; a
/// stuck process must not wedge the frontend's one-at-a-time queue.
const HELPER_TIMEOUT: Duration = Duration::from_secs(20);

fn helper_mode(readonly: bool) -> &'static str {
    if readonly { "ro" } else { "rw" }
}

/// The bundled helper, or None when it isn't shipped / resolvable.
fn resolve_sw_helper(app: &AppHandle) -> Option<PathBuf> {
    match app
        .path()
        .resolve("swhelper/HeliosSwReadonly.exe", tauri::path::BaseDirectory::Resource)
    {
        Ok(p) if p.exists() => Some(p),
        _ => None,
    }
}

/// One file's outcome from a batch flip (see `sw-helper/src/Program.cs`).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwFlipResult {
    pub path: String,
    /// not-open | already | flipped | reloaded | failed-dirty | failed | ambiguous
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwFlipBatch {
    /// False when the helper is missing, couldn't run, or found no running
    /// SOLIDWORKS; `results` is then empty.
    pub sw_running: bool,
    pub results: Vec<SwFlipResult>,
}

impl SwFlipBatch {
    fn none() -> Self {
        SwFlipBatch { sw_running: false, results: Vec::new() }
    }
}

/// Parse the helper's result file: `sw<TAB>running|none`, then
/// `<status><TAB><path>` per input path.
pub fn parse_flip_results(text: &str) -> SwFlipBatch {
    let mut sw_running = false;
    let mut results = Vec::new();
    for line in text.lines() {
        let line = line.trim_start_matches('\u{feff}').trim_end_matches('\r');
        let Some((status, rest)) = line.split_once('\t') else { continue };
        if status == "sw" {
            sw_running = rest.trim() == "running";
        } else if !rest.is_empty() {
            results.push(SwFlipResult { path: rest.to_string(), status: status.to_string() });
        }
    }
    if !sw_running {
        results.clear();
    }
    SwFlipBatch { sw_running, results }
}

/// Frontend-callable batch form: flip every open document among `paths` in ONE
/// helper process (one COM connection) and report what happened to each, so a
/// refused flip reaches the user instead of leaving a checked-out file
/// silently read-only in SOLIDWORKS. Files that aren't open come back as
/// `not-open`. Because one process covers the whole batch, bulk callers no
/// longer pre-filter to files with a SOLIDWORKS `~$` lock file (which a
/// document opened read-only may not have).
#[tauri::command]
pub async fn sw_flip_readonly_batch(app: AppHandle, paths: Vec<String>, readonly: bool) -> SwFlipBatch {
    if paths.is_empty() {
        return SwFlipBatch::none();
    }
    let Some(exe) = resolve_sw_helper(&app) else { return SwFlipBatch::none() };
    let mode = helper_mode(readonly);
    tauri::async_runtime::spawn_blocking(move || {
        let stem = format!("helios-swflip-{}", uuid::Uuid::new_v4());
        let list = std::env::temp_dir().join(format!("{stem}.txt"));
        let out = std::env::temp_dir().join(format!("{stem}.out"));
        if fs::write(&list, paths.join("\n")).is_err() {
            return SwFlipBatch::none();
        }
        // A refused flip retries for ~1.2 s, so scale the limit with the batch.
        let timeout = HELPER_TIMEOUT + Duration::from_millis(1500 * paths.len().min(400) as u64);
        let args = [
            "--batch".to_string(),
            mode.to_string(),
            list.to_string_lossy().into_owned(),
            out.to_string_lossy().into_owned(),
        ];
        run_helper_args(&exe, &args, timeout);
        let parsed = fs::read_to_string(&out)
            .map(|t| parse_flip_results(&t))
            .unwrap_or_else(|_| SwFlipBatch::none());
        let _ = fs::remove_file(&list);
        let _ = fs::remove_file(&out);
        parsed
    })
    .await
    .unwrap_or_else(|_| SwFlipBatch::none())
}

/// Run `exe <path> <mode>` (hidden window on Windows) and wait for it, killing
/// it if it outlives `timeout`. Returns true iff it exited by itself in time.
fn run_helper(exe: &Path, path: &str, mode: &str, timeout: Duration) -> bool {
    run_helper_args(exe, &[path.to_string(), mode.to_string()], timeout)
}

fn run_helper_args(exe: &Path, args: &[String], timeout: Duration) -> bool {
    let mut cmd = std::process::Command::new(exe);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => return false,
    };
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn round_trips_the_readonly_bit() {
        let mut p = std::env::temp_dir();
        p.push(format!("helios_ro_test_{}.bin", std::process::id()));
        {
            let mut f = fs::File::create(&p).unwrap();
            f.write_all(b"x").unwrap();
        }
        let path = p.to_string_lossy().to_string();

        set_path_readonly(path.clone(), true).unwrap();
        assert!(fs::metadata(&p).unwrap().permissions().readonly());

        set_path_readonly(path.clone(), false).unwrap();
        assert!(!fs::metadata(&p).unwrap().permissions().readonly());

        // Must be writable to remove on some platforms; we cleared it above.
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn parses_helper_results() {
        let batch = parse_flip_results(
            "\u{feff}sw\trunning\r\nflipped\tC:\\v\\a.sldprt\r\nnot-open\tC:\\v\\b.sldasm\r\nfailed-dirty\tC:\\v\\c.sldprt\r\n",
        );
        assert!(batch.sw_running);
        let got: Vec<(&str, &str)> =
            batch.results.iter().map(|r| (r.status.as_str(), r.path.as_str())).collect();
        assert_eq!(
            got,
            vec![
                ("flipped", "C:\\v\\a.sldprt"),
                ("not-open", "C:\\v\\b.sldasm"),
                ("failed-dirty", "C:\\v\\c.sldprt"),
            ]
        );
    }

    #[test]
    fn no_solidworks_means_no_results() {
        let batch = parse_flip_results("sw\tnone\nnot-open\tC:\\v\\a.sldprt\n");
        assert!(!batch.sw_running);
        assert!(batch.results.is_empty());
        assert!(!parse_flip_results("").sw_running);
    }

    #[test]
    fn errors_on_missing_path() {
        let missing = "/nonexistent/helios/definitely-not-here.bin".to_string();
        assert!(set_path_readonly(missing, true).is_err());
    }

    #[cfg(unix)]
    mod helper {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        fn script(name: &str, body: &str) -> PathBuf {
            let mut p = std::env::temp_dir();
            p.push(format!("helios_swhelper_{}_{}.sh", name, std::process::id()));
            fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
            p
        }

        #[test]
        fn run_helper_waits_for_the_process_and_passes_path_and_mode() {
            let out = std::env::temp_dir().join(format!("helios_swhelper_out_{}", std::process::id()));
            let exe = script("args", &format!("echo \"$1 $2\" > {}", out.display()));
            // Exec'ing a just-written script can fail with ETXTBSY on Linux when
            // another test thread forks while the write fd is briefly open, so
            // allow a couple of retries before calling it a failure.
            let ok = (0..3).any(|_| {
                run_helper(&exe, "/some/file.sldprt", "rw", Duration::from_secs(5))
                    || {
                        std::thread::sleep(Duration::from_millis(50));
                        false
                    }
            });
            assert!(ok);
            // The helper has exited by the time run_helper returns.
            assert_eq!(fs::read_to_string(&out).unwrap().trim(), "/some/file.sldprt rw");
            let _ = fs::remove_file(&exe);
            let _ = fs::remove_file(&out);
        }

        #[test]
        fn run_helper_kills_a_hung_process_at_the_timeout() {
            let exe = script("hang", "sleep 30");
            let started = Instant::now();
            assert!(!run_helper(&exe, "/x", "ro", Duration::from_millis(200)));
            assert!(started.elapsed() < Duration::from_secs(10));
            let _ = fs::remove_file(&exe);
        }

        #[test]
        fn run_helper_reports_a_missing_executable() {
            assert!(!run_helper(Path::new("/nonexistent/helios/helper"), "/x", "ro", Duration::from_secs(1)));
        }
    }
}
