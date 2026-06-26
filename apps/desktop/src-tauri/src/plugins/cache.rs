// Tauri-coupled half of the plugin install cache. The traversal-safe path logic
// lives in the `plugin-host` crate (no Tauri dep, so it stays unit-testable); this
// file only resolves the app-data cache root and applies the segment guard to the
// untrusted plugin id + version.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub use plugin_host::path::{is_safe_segment, resolve};

/// Root of the installed-plugin cache: `<app_data_dir>/plugins`.
pub fn cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("plugins"))
        .map_err(|e| e.to_string())
}

/// Directory holding one installed plugin version's unpacked files:
/// `<cache_root>/<plugin_id>/<version>`. Rejects ids/versions that are not safe
/// single path segments (a `..` id would otherwise escape the cache root).
pub fn version_dir(app: &AppHandle, plugin_id: &str, version: &str) -> Result<PathBuf, String> {
    if !is_safe_segment(plugin_id) {
        return Err(format!("unsafe plugin id: {plugin_id:?}"));
    }
    if !is_safe_segment(version) {
        return Err(format!("unsafe plugin version: {version:?}"));
    }
    Ok(cache_root(app)?.join(plugin_id).join(version))
}
