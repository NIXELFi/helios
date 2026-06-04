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

// Icon-overlay handlers (guid, class). Registered per-user as CLSIDs here; the
// actual ShellIconOverlayIdentifiers entry is HKLM (elevated) — see
// register_overlays_hklm_elevated. Names get a leading space to win one of
// Explorer's ~15 overlay slots.
const OVERLAYS: [(&str, &str, &str); 3] = [
    ("{8F2A6C14-9B3D-4E57-A1C2-D4E5F6070802}", "HeliosShell.HeliosOverlayOutMe", " HeliosVaultOutMe"),
    ("{8F2A6C14-9B3D-4E57-A1C2-D4E5F6070803}", "HeliosShell.HeliosOverlayOutOther", " HeliosVaultOutOther"),
    ("{8F2A6C14-9B3D-4E57-A1C2-D4E5F6070804}", "HeliosShell.HeliosOverlayAvailable", " HeliosVaultAvailable"),
];
const INFOTIP_GUID: &str = "{8F2A6C14-9B3D-4E57-A1C2-D4E5F6070805}";
const INFOTIP_CLASS: &str = "HeliosShell.HeliosInfoTip";
// The IQueryInfo (info-tip) shell-extension handler interface id.
const IQUERYINFO: &str = "{00021500-0000-0000-C000-000000000046}";
const OVERLAY_ROOT: &str =
    "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\ShellIconOverlayIdentifiers";

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

    // CLSIDs for every handler (context menu, overlays, info-tip) — all per-user,
    // no elevation. Overlays stay inert until the HKLM identifiers exist.
    register_managed_clsid(&hkcu, CTX_GUID, CTX_CLASS, dll, file_version)?;
    register_managed_clsid(&hkcu, INFOTIP_GUID, INFOTIP_CLASS, dll, file_version)?;
    for (guid, class, _) in OVERLAYS.iter() {
        register_managed_clsid(&hkcu, guid, class, dll, file_version)?;
    }

    // Context-menu handler for all files. CanShowMenu() gates it to vault files.
    let (ctx, _) =
        hkcu.create_subkey("Software\\Classes\\*\\shellex\\ContextMenuHandlers\\HeliosVault")?;
    ctx.set_value("", &CTX_GUID)?;

    // Info-tip (IQueryInfo) handler for all files — GetInfo() returns null for
    // non-vault files so Explorer keeps its default tooltip.
    let (tip, _) =
        hkcu.create_subkey(format!("Software\\Classes\\*\\shellex\\{IQUERYINFO}"))?;
    tip.set_value("", &INFOTIP_GUID)?;
    Ok(())
}

/// True if all three overlay identifiers are present under HKLM (so we can skip
/// re-prompting for elevation).
pub fn overlay_hklm_present() -> bool {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    OVERLAYS.iter().all(|(_, _, name)| {
        hklm.open_subkey(format!("{OVERLAY_ROOT}\\{name}")).is_ok()
    })
}

/// Register the three icon-overlay identifiers under HKLM via an elevated `reg
/// import` (one UAC). Explorer reads overlay handlers ONLY from HKLM, so this
/// can't be per-user. Call from the on-demand "install / repair" path (never
/// auto-startup) so a missing UAC-clicker can't wedge launch. The user must
/// restart Explorer afterward for the overlays to load.
pub fn register_overlays_hklm_elevated() -> Result<(), String> {
    let mut content = String::from("REGEDIT4\r\n\r\n");
    for (guid, _, name) in OVERLAYS.iter() {
        content.push_str(&format!(
            "[HKEY_LOCAL_MACHINE\\{OVERLAY_ROOT}\\{name}]\r\n@=\"{guid}\"\r\n\r\n"
        ));
    }
    let path = std::env::temp_dir().join("helios_overlays_hklm.reg");
    std::fs::write(&path, content).map_err(|e| format!("write reg file: {e}"))?;
    let ps = format!(
        "$ErrorActionPreference='Stop'; Start-Process -FilePath reg.exe \
         -ArgumentList @('import', '{}') -Verb RunAs -Wait",
        path.display().to_string().replace('\'', "''")
    );
    let status = std::process::Command::new("powershell")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &ps])
        .status()
        .map_err(|e| format!("spawn elevation: {e}"))?;
    let _ = std::fs::remove_file(&path);
    if status.success() {
        Ok(())
    } else {
        Err("elevation was declined or the overlay registry import failed".into())
    }
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
