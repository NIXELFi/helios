// Tauri-coupled half of the plugin install cache. The traversal-safe path logic
// lives in the `plugin-host` crate (no Tauri dep, so it stays unit-testable); this
// file only resolves the app-data cache root and applies the segment guard to the
// untrusted plugin id + version.

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub use plugin_host::path::{is_safe_segment, resolve};

use super::ActiveVersions;

/// Root of the installed-plugin cache: `<app_data_dir>/plugins`.
pub fn cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("plugins"))
        .map_err(|e| e.to_string())
}

/// A plugin's cache directory: `<cache_root>/<plugin_id>` (holds the single
/// installed version subdir). Rejects an unsafe id.
pub fn plugin_root(app: &AppHandle, plugin_id: &str) -> Result<PathBuf, String> {
    if !is_safe_segment(plugin_id) {
        return Err(format!("unsafe plugin id: {plugin_id:?}"));
    }
    Ok(cache_root(app)?.join(plugin_id))
}

/// Directory holding one installed plugin version's unpacked files:
/// `<cache_root>/<plugin_id>/<version>`. Rejects ids/versions that are not safe
/// single path segments (a `..` id would otherwise escape the cache root).
pub fn version_dir(app: &AppHandle, plugin_id: &str, version: &str) -> Result<PathBuf, String> {
    if !is_safe_segment(version) {
        return Err(format!("unsafe plugin version: {version:?}"));
    }
    Ok(plugin_root(app, plugin_id)?.join(version))
}

/// Name of the staging area inside the cache root. Deliberately starts with `~`,
/// which `is_safe_segment` REJECTS, so `restore_active_versions` (and any other
/// scan over the cache root) can never mistake it for an installed plugin.
const STAGING_DIR_NAME: &str = "~staging";
/// Suffix for the "old version parked during a swap" directory. Also unsafe as a
/// segment, for the same reason.
const BACKUP_SUFFIX: &str = "~old";

/// Root of the install staging area: `<cache_root>/~staging`.
pub fn staging_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(cache_root(app)?.join(STAGING_DIR_NAME))
}

/// Where a plugin's NEW version is unpacked and verified before it replaces the
/// installed one: `<cache_root>/~staging/<plugin_id>`. Rejects an unsafe id.
pub fn staging_dir(app: &AppHandle, plugin_id: &str) -> Result<PathBuf, String> {
    if !is_safe_segment(plugin_id) {
        return Err(format!("unsafe plugin id: {plugin_id:?}"));
    }
    Ok(staging_root(app)?.join(plugin_id))
}

/// Where the PREVIOUS install is parked for the duration of the swap:
/// `<cache_root>/~staging/<plugin_id>~old`. Rejects an unsafe id.
pub fn backup_dir(app: &AppHandle, plugin_id: &str) -> Result<PathBuf, String> {
    if !is_safe_segment(plugin_id) {
        return Err(format!("unsafe plugin id: {plugin_id:?}"));
    }
    Ok(staging_root(app)?.join(format!("{plugin_id}{BACKUP_SUFFIX}")))
}

/// Atomically-ish replace `plugin_root` with a fully-verified `staging` dir.
///
/// The order is chosen so that the plugin is never simply *gone*: the old install
/// is RENAMED aside (not deleted) first, so at every instant the bytes of at least
/// one complete version exist on disk, and the only crash window is between the two
/// renames — which `recover_staging` repairs on the next launch.
///
///   1. plugin_root -> backup   (rename; skipped when nothing is installed)
///   2. staging     -> plugin_root
///   3. delete backup
///
/// If step 2 fails, step 1 is rolled back so the PREVIOUS version stays installed.
pub fn swap_into_place(staging: &Path, plugin_root: &Path, backup: &Path) -> Result<(), String> {
    // A stale backup from an earlier interrupted swap would make step 1 fail on
    // Windows (rename onto an existing dir); it has already been superseded.
    if backup.exists() {
        let _ = std::fs::remove_dir_all(backup);
    }
    let had_previous = plugin_root.exists();
    if had_previous {
        std::fs::rename(plugin_root, backup)
            .map_err(|e| format!("could not park the previous version: {e}"))?;
    }
    if let Err(e) = std::fs::rename(staging, plugin_root) {
        // Put the previous version back — a failed update must be a no-op.
        if had_previous {
            let _ = std::fs::rename(backup, plugin_root);
        }
        return Err(format!("could not activate the new version: {e}"));
    }
    if had_previous {
        let _ = std::fs::remove_dir_all(backup);
    }
    Ok(())
}

/// Repair the staging area at launch. Two kinds of leftovers can exist:
///
/// - `<id>~old` — a swap was interrupted. If `<cache_root>/<id>` is missing the
///   crash landed BETWEEN the two renames, so restore the previous version (a
///   failed update leaves the old version installed). Otherwise the swap actually
///   completed and the backup is just garbage.
/// - `<id>` — an unpack/verification that never reached the swap. The install did
///   not happen; delete it.
///
/// Best-effort: every failure is ignored, since a leftover directory is inert (the
/// staging root is not a valid plugin segment, so nothing ever serves from it).
pub fn recover_staging(cache_root: &Path, staging_root: &Path) {
    let entries = match std::fs::read_dir(staging_root) {
        Ok(e) => e,
        Err(_) => return, // no staging area → nothing to repair
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        match name.strip_suffix(BACKUP_SUFFIX) {
            Some(plugin_id) if is_safe_segment(plugin_id) => {
                let dest = cache_root.join(plugin_id);
                if dest.exists() {
                    let _ = std::fs::remove_dir_all(&path);
                } else {
                    let _ = std::fs::rename(&path, &dest);
                }
            }
            // Either an abandoned unpack, or something we don't recognise — in
            // both cases it is not an install, so it should not linger.
            _ => {
                let _ = std::fs::remove_dir_all(&path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    // A throwaway directory under the OS temp dir. Deliberately dependency-free
    // (no `tempfile` dev-dep just for these tests); uniqueness comes from the pid
    // plus a counter, and the tests clean up after themselves.
    static N: AtomicU32 = AtomicU32::new(0);
    fn tmpdir(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "helios-plugin-cache-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_version(dir: &Path, version: &str, marker: &str) {
        let v = dir.join(version);
        std::fs::create_dir_all(&v).unwrap();
        std::fs::write(v.join("manifest.json"), marker).unwrap();
    }

    fn marker(plugin_root: &Path, version: &str) -> String {
        std::fs::read_to_string(plugin_root.join(version).join("manifest.json")).unwrap()
    }

    #[test]
    fn staging_area_name_is_never_a_valid_plugin_segment() {
        // The whole reason the restore-on-launch scan can ignore it for free.
        assert!(!is_safe_segment(STAGING_DIR_NAME));
        assert!(!is_safe_segment(&format!("aero.tool{BACKUP_SUFFIX}")));
    }

    #[test]
    fn swap_replaces_the_previous_version_and_clears_the_backup() {
        let root = tmpdir("swap-ok");
        let plugin_root = root.join("aero.tool");
        let staging = root.join("~staging").join("aero.tool");
        let backup = root.join("~staging").join("aero.tool~old");
        write_version(&plugin_root, "1.0.0", "old");
        write_version(&staging, "2.0.0", "new");

        swap_into_place(&staging, &plugin_root, &backup).unwrap();

        assert_eq!(marker(&plugin_root, "2.0.0"), "new");
        assert!(!plugin_root.join("1.0.0").exists());
        assert!(!backup.exists());
        assert!(!staging.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn swap_into_a_clean_slot_installs_without_a_backup() {
        let root = tmpdir("swap-fresh");
        let plugin_root = root.join("aero.tool");
        let staging = root.join("~staging").join("aero.tool");
        let backup = root.join("~staging").join("aero.tool~old");
        write_version(&staging, "1.0.0", "new");

        swap_into_place(&staging, &plugin_root, &backup).unwrap();

        assert_eq!(marker(&plugin_root, "1.0.0"), "new");
        assert!(!backup.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn recover_restores_the_previous_version_after_a_crash_mid_swap() {
        // The exact state a crash between the two renames leaves behind: the old
        // version parked in the backup, the new one still staged, no plugin root.
        let root = tmpdir("recover-crash");
        let staging_root = root.join("~staging");
        write_version(&staging_root.join("aero.tool~old"), "1.0.0", "old");
        write_version(&staging_root.join("aero.tool"), "2.0.0", "new");

        recover_staging(&root, &staging_root);

        assert_eq!(marker(&root.join("aero.tool"), "1.0.0"), "old");
        assert!(!staging_root.join("aero.tool").exists());
        assert!(!staging_root.join("aero.tool~old").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn recover_drops_an_abandoned_unpack_and_a_superseded_backup() {
        let root = tmpdir("recover-garbage");
        let staging_root = root.join("~staging");
        write_version(&root.join("aero.tool"), "2.0.0", "new"); // swap completed
        write_version(&staging_root.join("aero.tool~old"), "1.0.0", "old");
        write_version(&staging_root.join("other.tool"), "1.0.0", "never installed");

        recover_staging(&root, &staging_root);

        assert_eq!(marker(&root.join("aero.tool"), "2.0.0"), "new");
        assert!(!staging_root.join("aero.tool~old").exists());
        assert!(!staging_root.join("other.tool").exists());
        assert!(!root.join("other.tool").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn recover_is_a_no_op_without_a_staging_area() {
        let root = tmpdir("recover-none");
        recover_staging(&root, &root.join("~staging"));
        assert!(!root.join("~staging").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}

/// Rebuild the in-memory active-version map from what's on disk. The map
/// (`ActiveVersions`) does not survive a restart, so without this an installed
/// plugin would 404 from `plugin://` until reinstalled. Install keeps exactly one
/// version dir per plugin, so the lone subdir is unambiguous. Best-effort: any
/// unreadable/oddly-shaped entry is skipped.
pub fn restore_active_versions(app: &AppHandle) {
    let root = match cache_root(app) {
        Ok(r) => r,
        Err(_) => return,
    };
    // Repair any interrupted install BEFORE the scan, so a crash mid-swap surfaces
    // as "the previous version is still installed" rather than "the plugin vanished".
    recover_staging(&root, &root.join(STAGING_DIR_NAME));
    let plugin_dirs = match std::fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return, // cache dir doesn't exist yet → nothing installed
    };
    let active = app.state::<ActiveVersions>();
    for plugin_entry in plugin_dirs.flatten() {
        if !plugin_entry.path().is_dir() {
            continue;
        }
        let pid = plugin_entry.file_name().to_string_lossy().to_string();
        // Also what keeps `~staging` out of the map: `~` is not a safe segment.
        if !is_safe_segment(&pid) {
            continue;
        }
        if let Ok(versions) = std::fs::read_dir(plugin_entry.path()) {
            for v in versions.flatten() {
                if !v.path().is_dir() {
                    continue;
                }
                let ver = v.file_name().to_string_lossy().to_string();
                if is_safe_segment(&ver) {
                    active.set(pid.clone(), ver);
                    break; // exactly one version dir per plugin
                }
            }
        }
    }
}
