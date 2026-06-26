// Tauri-coupled half of the plugin install cache. The traversal-safe path logic
// lives in the `plugin-host` crate (no Tauri dep, so it stays unit-testable); this
// file only resolves the app-data cache root and applies the segment guard to the
// untrusted plugin id + version.

use std::path::PathBuf;
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
