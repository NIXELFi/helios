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
            &format!("(Get-Item -LiteralPath '{}').VersionInfo.FileVersion", dll.display()),
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

/// The currently-staged version recorded in state.json, if any.
pub fn staged_version() -> Option<String> {
    let s = std::fs::read_to_string(addin_root().join("state.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&s).ok()?;
    v.get("version").and_then(|x| x.as_str()).map(str::to_string)
}

/// Copy `bundled_dll` to <root>\<version>\HeliosVault.dll and record it in
/// state.json. No-op copy if the target already exists. Returns the staged path.
pub fn stage(bundled_dll: &Path, version: &str) -> std::io::Result<PathBuf> {
    let dir = addin_root().join(version);
    std::fs::create_dir_all(&dir)?;
    let dest = dir.join("HeliosVault.dll");
    if !dest.exists() {
        std::fs::copy(bundled_dll, &dest)?;
    }
    std::fs::write(
        addin_root().join("state.json"),
        serde_json::to_vec_pretty(&serde_json::json!({ "version": version, "dll": dest }))
            .unwrap(),
    )?;
    Ok(dest)
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
