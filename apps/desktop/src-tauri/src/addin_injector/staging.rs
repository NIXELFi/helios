//! Stage the bundled add-in DLL into a version-specific folder under
//! %LOCALAPPDATA%\Helios\addin\<version>\, tracking the active version in
//! state.json. Versioned folders mean a new DLL never overwrites one a running
//! SOLIDWORKS still has loaded (no "file is locked" failure on update).

use std::path::{Path, PathBuf};

pub fn addin_root() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("Helios")
        .join("addin")
}

/// FileVersion of a DLL ("3.8.2.0") read without loading the assembly. Uses
/// PowerShell's VersionInfo to avoid a native version-resource crate; the
/// injector runs once at startup so the spawn cost is fine.
pub fn dll_file_version(dll: &Path) -> Option<String> {
    let out = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            &format!(
                "(Get-Item -LiteralPath '{}').VersionInfo.FileVersion",
                ps_single_quote_escape(&dll.display().to_string()),
            ),
        ])
        .output()
        .ok()?;
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

/// Escape a value for interpolation inside a PowerShell single-quoted string:
/// the only special character is the single quote itself, doubled. Without
/// this, a profile path containing an apostrophe (C:\Users\O'Brien\…) breaks
/// the command and version detection silently returns None.
fn ps_single_quote_escape(s: &str) -> String {
    s.replace('\'', "''")
}

/// The currently-staged version recorded in state.json, if any.
pub fn staged_version() -> Option<String> {
    let s = std::fs::read_to_string(addin_root().join("state.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&s).ok()?;
    v.get("version").and_then(|x| x.as_str()).map(str::to_string)
}

fn read_state() -> serde_json::Value {
    std::fs::read_to_string(addin_root().join("state.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

fn write_state(v: &serde_json::Value) {
    // Atomic: write a sibling .tmp then rename over state.json. A crash mid-write
    // must never leave a truncated/half-written state.json — gc() trusts the
    // recorded "version" to decide which version folder to keep, so a corrupt
    // read (→ no version) would let gc() delete the live folder out from under a
    // running SOLIDWORKS. rename within the same dir is atomic on Windows/NTFS.
    let dir = addin_root();
    let final_path = dir.join("state.json");
    let tmp = dir.join("state.json.tmp");
    let bytes = serde_json::to_vec_pretty(v).unwrap();
    if std::fs::write(&tmp, &bytes).is_ok() {
        // Windows rename fails if the destination exists; fall back to a
        // remove+rename, then to a direct write as a last resort.
        if std::fs::rename(&tmp, &final_path).is_err() {
            let _ = std::fs::remove_file(&final_path);
            if std::fs::rename(&tmp, &final_path).is_err() {
                let _ = std::fs::write(&final_path, &bytes);
                let _ = std::fs::remove_file(&tmp);
            }
        }
    }
}

/// Is the already-staged `dest` byte-for-byte the DLL we're about to stage?
///
/// This used to compare byte LENGTH only, which is exactly the case it needed to
/// catch: a rebuilt HeliosVault.dll whose FileVersion resource didn't change
/// (so the version-folder path is the same) and whose size happens to land on
/// the same number of bytes is a routine outcome of editing a few instructions.
/// Length-equality then said "up to date", the copy was skipped, and SOLIDWORKS
/// kept loading the OLD add-in forever while state.json claimed current — an
/// undebuggable "my fix isn't in the build". A sha256 of the two files is the
/// only comparison that actually answers the question. The DLL is a few hundred
/// KB and this runs once at startup, so the read+hash is free in practice.
///
/// Zero-length `dest` (or `src`) is never "up to date": an empty staged DLL is a
/// prior crashed copy that SW can't load.
fn up_to_date(src_bytes: &[u8], dest: &Path) -> bool {
    if src_bytes.is_empty() {
        return false;
    }
    let Ok(dest_bytes) = std::fs::read(dest) else {
        return false; // missing or unreadable → re-stage
    };
    if dest_bytes.len() != src_bytes.len() {
        return false; // cheap reject before hashing
    }
    plugin_host::verify::sha256_hex(&dest_bytes) == plugin_host::verify::sha256_hex(src_bytes)
}

/// Stage `src` to `dest` crash-safely, re-copying only when needed.
///
/// Skips the copy only when `dest` is byte-for-byte identical to `src`
/// (sha256 — see `up_to_date`). Otherwise — `dest` missing, zero-length (a
/// prior crashed copy), truncated, or a same-version-different-bytes rebuild —
/// copies to a temp file in the SAME directory and atomically renames it over
/// `dest`, so a crash mid-copy can never leave a half-written DLL that SW would
/// fail to load. Verifies the final file is non-empty.
pub(crate) fn stage_file(src: &Path, dest: &Path) -> std::io::Result<()> {
    let src_bytes = std::fs::read(src)?;
    if up_to_date(&src_bytes, dest) {
        return Ok(());
    }

    let dir = dest.parent().unwrap_or_else(|| Path::new("."));
    let tmp = dir.join(format!(
        "{}.tmp-{}",
        dest.file_name().and_then(|n| n.to_str()).unwrap_or("staged"),
        std::process::id()
    ));
    let _ = std::fs::remove_file(&tmp);
    std::fs::copy(src, &tmp)?;
    // Windows rename fails if dest exists — remove the stale copy first. dest is
    // version-folder-scoped, so a running SW has THIS version loaded only when the
    // bytes already matched (handled by the early return above); a mismatch means
    // the staged copy was never a good load target.
    let _ = std::fs::remove_file(dest);
    if let Err(e) = std::fs::rename(&tmp, dest) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    if std::fs::metadata(dest).map(|m| m.len() == 0).unwrap_or(true) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            "staged DLL is empty after copy",
        ));
    }
    Ok(())
}

/// Copy `bundled_dll` to <root>\<version>\HeliosVault.dll and record it in
/// state.json (merging — preserves other flags like `hklmAttempted`). Refreshes
/// the copy whenever the staged file isn't byte-identical to the bundled DLL —
/// missing, empty, truncated, or a same-version-different-bytes rebuild.
/// Returns the staged path.
pub fn stage(bundled_dll: &Path, version: &str) -> std::io::Result<PathBuf> {
    let dir = addin_root().join(version);
    std::fs::create_dir_all(&dir)?;
    let dest = dir.join("HeliosVault.dll");
    stage_file(bundled_dll, &dest)?;
    let mut v = read_state();
    v["version"] = serde_json::json!(version);
    v["dll"] = serde_json::json!(dest);
    write_state(&v);
    Ok(dest)
}

/// Has the one-time HKLM (elevated) provisioning already been attempted? Tracked
/// so we don't pop a UAC on every launch.
pub fn hklm_attempted() -> bool {
    read_state()
        .get("hklmAttempted")
        .and_then(|x| x.as_bool())
        .unwrap_or(false)
}

/// Record that the HKLM provisioning has been attempted (so it isn't re-prompted
/// automatically — the user can still retry from Settings).
pub fn set_hklm_attempted(done: bool) {
    let mut v = read_state();
    v["hklmAttempted"] = serde_json::json!(done);
    write_state(&v);
}

/// Remove version folders other than `keep`. Best-effort; locked dirs (a running
/// SW still has that DLL loaded) are skipped and retried on a later launch.
pub fn gc(keep: &str) {
    if let Ok(entries) = std::fs::read_dir(addin_root()) {
        for e in entries.flatten() {
            if e.path().is_dir() && e.file_name().to_string_lossy() != keep {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ps_escape_doubles_single_quotes() {
        assert_eq!(
            ps_single_quote_escape(r"C:\Users\O'Brien\app.dll"),
            r"C:\Users\O''Brien\app.dll"
        );
        assert_eq!(ps_single_quote_escape("no quotes"), "no quotes");
    }

    /// The bug this replaced a length check for: a rebuilt DLL with the same
    /// FileVersion (same version folder) and the same size must still re-stage,
    /// or SOLIDWORKS keeps loading the stale add-in.
    #[test]
    fn restages_a_same_size_but_different_dll() {
        let tmp = std::env::temp_dir().join(format!("helios_stage_hash_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("src.dll");
        let dest = tmp.join("dest.dll");

        std::fs::write(&src, b"AAAAAAAA").unwrap();
        stage_file(&src, &dest).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"AAAAAAAA");

        // Same byte length, different content — must be re-copied.
        std::fs::write(&src, b"BBBBBBBB").unwrap();
        assert!(!up_to_date(b"BBBBBBBB", &dest), "same-size-different-bytes is NOT up to date");
        stage_file(&src, &dest).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"BBBBBBBB");

        // Identical bytes are up to date (the steady-state skip still works).
        assert!(up_to_date(b"BBBBBBBB", &dest));
        // A zero-length staged copy (crashed prior copy) is never up to date.
        std::fs::write(&dest, b"").unwrap();
        assert!(!up_to_date(b"BBBBBBBB", &dest));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn stage_copies_and_records_version() {
        let tmp = std::env::temp_dir().join(format!("helios_stage_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let src = tmp.join("src.dll");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(&src, b"dll-bytes").unwrap();
        std::env::set_var("LOCALAPPDATA", &tmp);

        let dest = stage(&src, "9.9.9.9").unwrap();
        assert!(dest.exists());
        assert_eq!(staged_version().as_deref(), Some("9.9.9.9"));

        // gc keeps the active version folder, drops others.
        std::fs::create_dir_all(addin_root().join("1.0.0.0")).unwrap();
        gc("9.9.9.9");
        assert!(addin_root().join("9.9.9.9").exists());
        assert!(!addin_root().join("1.0.0.0").exists());

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
