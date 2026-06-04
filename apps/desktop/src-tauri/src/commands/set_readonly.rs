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

use tauri::{AppHandle, Manager};

/// Set or clear the read-only attribute on `path`. Cross-platform:
/// `Permissions::set_readonly` maps to the Windows read-only file attribute and
/// to clearing/setting the owner+group+other write bits on Unix.
#[tauri::command]
pub fn set_path_readonly(path: String, readonly: bool) -> Result<(), String> {
    let meta = fs::metadata(&path).map_err(|e| format!("stat {path}: {e}"))?;
    let mut perm = meta.permissions();
    perm.set_readonly(readonly);
    fs::set_permissions(&path, perm).map_err(|e| format!("set_permissions {path}: {e}"))?;
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
/// helper is absent. NEVER call this in a bulk loop (e.g. auto-sync) — only on
/// an explicit single-file check-out / check-in / cancel.
pub fn flip_sw_readonly(app: &AppHandle, path: &str, readonly: bool) {
    let exe = match app
        .path()
        .resolve("swhelper/HeliosSwReadonly.exe", tauri::path::BaseDirectory::Resource)
    {
        Ok(p) if p.exists() => p,
        _ => return, // helper not bundled / resolvable — nothing to do
    };
    let path = path.to_string();
    let mode = if readonly { "ro" } else { "rw" };
    std::thread::Builder::new()
        .name("helios-sw-readonly".into())
        .spawn(move || {
            let mut cmd = std::process::Command::new(&exe);
            cmd.arg(&path).arg(mode);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }
            let _ = cmd.status();
        })
        .ok();
}

/// Frontend-callable: flip an open SOLIDWORKS document's read-only state. Used
/// by the desktop vault UI (RowActions) on check-out / check-in / cancel so the
/// behavior matches the add-in even when the add-in isn't there.
#[tauri::command]
pub fn sw_flip_readonly(app: AppHandle, path: String, readonly: bool) {
    flip_sw_readonly(&app, &path, readonly);
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
    fn errors_on_missing_path() {
        let missing = "/nonexistent/helios/definitely-not-here.bin".to_string();
        assert!(set_path_readonly(missing, true).is_err());
    }
}
