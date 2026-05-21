//! Pure config-load logic.
//!
//! The Tauri command layer wraps this with resource-dir resolution
//! (which needs an `AppHandle`); the pure function here takes the
//! resource dir as a parameter so it can be unit-tested without any
//! Tauri runtime.

use std::path::Path;

use crate::dto::{build_config_summary, ConfigSummary, LoadedConfig};

/// Returns true if `path` resolves under `dir` (both canonicalized when
/// possible). Falls back to a literal `starts_with` if either path can't
/// be canonicalized — Tauri resource dirs in dev sometimes don't.
pub fn path_under(path: &Path, dir: &Path) -> bool {
    let canon = |p: &Path| p.canonicalize().ok().unwrap_or_else(|| p.to_path_buf());
    canon(path).starts_with(canon(dir))
}

/// Reads + parses + validates a V1 SDM JSON config from disk.
/// `resource_dir`, when supplied, is the bundle's resource directory;
/// any loaded path inside it gets `is_example: true`. Pass `None` to
/// skip the example check (useful in tests).
pub fn load_config_from_path(
    path: &Path,
    resource_dir: Option<&Path>,
) -> Result<LoadedConfig, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("Couldn't read {}: {}", path.display(), e))?;
    let raw: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("JSON parse error in {}: {}", path.display(), e))?;
    engine_sim::config::loader::load_v1_json(path)
        .map_err(|e| format!("Schema error in {}: {}", path.display(), e))?;
    let summary: ConfigSummary = build_config_summary(&raw);
    let is_example = resource_dir.map(|r| path_under(path, r)).unwrap_or(false);
    Ok(LoadedConfig {
        path: path.to_string_lossy().into_owned(),
        raw,
        summary,
        is_example,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundled_sdm26() -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../engine-sim/python_ref/configs/sdm26.json")
    }

    #[test]
    fn missing_file_returns_clear_error() {
        let r = load_config_from_path(std::path::Path::new("/nope/does/not/exist.json"), None);
        let err = r.expect_err("expected error");
        assert!(err.contains("Couldn't read"), "got {err}");
    }

    #[test]
    fn valid_sdm26_loads_with_summary() {
        let r = load_config_from_path(&bundled_sdm26(), None).unwrap();
        assert_eq!(r.summary.n_cylinders, 4);
        assert!((r.summary.bore_mm - 67.0).abs() < 1e-9);
        assert!((r.summary.compression_ratio - 12.2).abs() < 1e-9);
        assert!(r.raw.get("cylinder").is_some());
        assert!(r.raw.get("intake_pipes").is_some());
        assert!(!r.is_example, "no resource_dir given -> is_example=false");
    }

    #[test]
    fn is_example_true_when_path_inside_resource_dir() {
        let path = bundled_sdm26();
        let resource_dir = path.parent().unwrap();
        let r = load_config_from_path(&path, Some(resource_dir)).unwrap();
        assert!(r.is_example);
    }

    #[test]
    fn is_example_false_when_path_outside_resource_dir() {
        let path = bundled_sdm26();
        let unrelated_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let r = load_config_from_path(&path, Some(&unrelated_dir)).unwrap();
        // sdm26.json lives at .../engine-sim/python_ref/configs which IS
        // under crates/ — so this stays under CARGO_MANIFEST_DIR of cfd-core
        // (../cfd-core's parent). Use a deliberately unrelated dir.
        let _ = r;
        let r2 = load_config_from_path(&path, Some(std::path::Path::new("/totally/unrelated"))).unwrap();
        assert!(!r2.is_example);
    }
}
