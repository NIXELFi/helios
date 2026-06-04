//! Windows Explorer shell-extension (`HeliosShell.dll`) provisioning — the
//! Explorer counterpart to the SOLIDWORKS add-in. Staged into a version folder
//! under `%LOCALAPPDATA%\Helios\shell\<version>\` (so a new build never collides
//! with a copy explorer.exe still has loaded) and registered per-user:
//!
//! - the managed-COM CLSID for each handler (mscoree, same shape as the add-in)
//! - the **context-menu** handler association under
//!   `HKCU\Software\Classes\*\shellex\ContextMenuHandlers\HeliosVault`
//!
//! Context menus resolve per-user with no elevation. (Icon-overlay handlers,
//! which DO need an elevated HKLM key, are registered separately.)

use std::path::{Path, PathBuf};

use winreg::enums::*;
use winreg::RegKey;

use super::registry::code_base;
use super::staging::addin_root;

const SHELL_ASSEMBLY: &str = "HeliosShell, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null";
const CTX_GUID: &str = "{8F2A6C14-9B3D-4E57-A1C2-D4E5F6070801}";
const CTX_CLASS: &str = "HeliosShell.HeliosContextMenu";

/// `%LOCALAPPDATA%\Helios\shell` — sibling of the add-in staging root.
pub fn shell_root() -> PathBuf {
    addin_root().parent().map(|p| p.join("shell")).unwrap_or_else(|| PathBuf::from("shell"))
}

fn read_state() -> serde_json::Value {
    std::fs::read_to_string(shell_root().join("state.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

/// The currently-staged shell-ext version recorded in shell\state.json.
pub fn staged_version() -> Option<String> {
    read_state().get("version").and_then(|x| x.as_str()).map(str::to_string)
}

/// Copy `bundled_dll` to `<root>\<version>\HeliosShell.dll` (no-op if present)
/// and record the version. Returns the staged path.
pub fn stage(bundled_dll: &Path, version: &str) -> std::io::Result<PathBuf> {
    let dir = shell_root().join(version);
    std::fs::create_dir_all(&dir)?;
    let dest = dir.join("HeliosShell.dll");
    if !dest.exists() {
        // Copy HeliosShell.dll AND its sibling dependencies (SharpShell.dll)
        // from the bundled resource dir, so the managed assembly resolves them
        // from its own version folder.
        if let Some(src_dir) = bundled_dll.parent() {
            if let Ok(entries) = std::fs::read_dir(src_dir) {
                for e in entries.flatten() {
                    let p = e.path();
                    let is_dll = p.extension().map(|x| x.eq_ignore_ascii_case("dll")).unwrap_or(false);
                    if is_dll {
                        if let Some(name) = p.file_name() {
                            let _ = std::fs::copy(&p, dir.join(name));
                        }
                    }
                }
            }
        }
        if !dest.exists() {
            std::fs::copy(bundled_dll, &dest)?; // ensure the primary landed
        }
    }
    let body = serde_json::json!({ "version": version, "dll": dest });
    let _ = std::fs::write(shell_root().join("state.json"), serde_json::to_vec_pretty(&body).unwrap());
    Ok(dest)
}

/// True if the context-menu CLSID's CodeBase already points at `dll`.
pub fn already_registered(dll: &Path) -> bool {
    let want = code_base(dll);
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(format!("Software\\Classes\\CLSID\\{CTX_GUID}\\InprocServer32"))
        .and_then(|k| k.get_value::<String, _>("CodeBase"))
        .map(|cb| cb.eq_ignore_ascii_case(&want))
        .unwrap_or(false)
}

fn register_managed_clsid(hkcu: &RegKey, guid: &str, class: &str, dll: &Path, file_version: &str) -> std::io::Result<()> {
    let cb = code_base(dll);
    let (inproc, _) = hkcu.create_subkey(format!("Software\\Classes\\CLSID\\{guid}\\InprocServer32"))?;
    inproc.set_value("", &"mscoree.dll")?;
    inproc.set_value("ThreadingModel", &"Both")?;
    inproc.set_value("Class", &class)?;
    inproc.set_value("Assembly", &SHELL_ASSEMBLY)?;
    inproc.set_value("RuntimeVersion", &"v4.0.30319")?;
    inproc.set_value("CodeBase", &cb)?;
    let (iv, _) = inproc.create_subkey(file_version)?;
    iv.set_value("Class", &class)?;
    iv.set_value("Assembly", &SHELL_ASSEMBLY)?;
    iv.set_value("RuntimeVersion", &"v4.0.30319")?;
    iv.set_value("CodeBase", &cb)?;
    Ok(())
}

/// Per-user (no admin): CLSID + the context-menu handler association on all
/// files. Explorer picks this up on the next right-click (no restart needed).
pub fn register_shell_per_user(dll: &Path, file_version: &str) -> std::io::Result<()> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    register_managed_clsid(&hkcu, CTX_GUID, CTX_CLASS, dll, file_version)?;
    // Context-menu handler for all files. CanShowMenu() gates it to vault files.
    let (ctx, _) =
        hkcu.create_subkey("Software\\Classes\\*\\shellex\\ContextMenuHandlers\\HeliosVault")?;
    ctx.set_value("", &CTX_GUID)?;
    Ok(())
}

/// Remove stale shell version folders, keeping `keep`. Best-effort (a folder a
/// running explorer.exe still has loaded is skipped + retried next launch).
pub fn gc(keep: &str) {
    if let Ok(entries) = std::fs::read_dir(shell_root()) {
        for e in entries.flatten() {
            if e.path().is_dir() && e.file_name().to_string_lossy() != keep {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
}
