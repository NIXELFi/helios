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
