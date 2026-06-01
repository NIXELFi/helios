//! Locate SOLIDWORKS and whether it's currently running. All functions are
//! best-effort and return None/false rather than erroring.

use std::path::PathBuf;

/// The SOLIDWORKS install dir if installed, else None. Reads the per-machine
/// SOLIDWORKS registry (readable without admin) and confirms SLDWORKS.exe exists.
pub fn solidworks_install_dir() -> Option<PathBuf> {
    use winreg::enums::*;
    use winreg::RegKey;
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let sw = hklm.open_subkey("SOFTWARE\\SolidWorks").ok()?;
    // Prefer a "SOLIDWORKS <year>" subkey exposing Setup\SolidWorks Folder.
    for name in sw.enum_keys().flatten() {
        if let Ok(setup) = sw.open_subkey(format!("{name}\\Setup")) {
            if let Ok(folder) = setup.get_value::<String, _>("SolidWorks Folder") {
                let p = PathBuf::from(folder);
                if p.join("SLDWORKS.exe").exists() {
                    return Some(p);
                }
            }
        }
    }
    None
}

/// True if a SLDWORKS.exe process is currently running.
pub fn is_sldworks_running() -> bool {
    std::process::Command::new("tasklist")
        .args(["/FI", "IMAGENAME eq SLDWORKS.exe", "/NH"])
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .to_ascii_uppercase()
                .contains("SLDWORKS.EXE")
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn running_check_does_not_panic() {
        let _ = is_sldworks_running();
    }

    #[test]
    fn install_dir_does_not_panic() {
        // Some(dir) on a box with SW installed, None otherwise — both fine.
        let _ = solidworks_install_dir();
    }
}
