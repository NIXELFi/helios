//! SOLIDWORKS add-in registration, split by privilege:
//!
//! - **Per-user (no admin):** the managed-COM CLSID under
//!   `HKCU\Software\Classes\CLSID\{guid}` and the per-user enable flag
//!   `HKCU\Software\SolidWorks\AddInsStartup\{guid}`. Per-user COM resolves via
//!   the HKCR merge as long as SOLIDWORKS runs non-elevated as the same user.
//! - **Machine-wide (needs elevation):** the **list entry**
//!   `HKLM\SOFTWARE\SolidWorks\AddIns\{guid}`. SOLIDWORKS discovers add-ins
//!   ONLY by enumerating that HKLM key — there is no HKCU discovery — so this
//!   one entry can't be per-user. Written once via an elevated `reg import`
//!   (single UAC), then skipped when already present.

use std::path::Path;
use winreg::enums::*;
use winreg::RegKey;

const GUID: &str = "{B7A4E2C9-3F1D-4A8B-9C2E-5D6F7A8B9C0D}";
// Matches the add-in's stable AssemblyVersion (never bumped) + class name.
const ASSEMBLY: &str = "HeliosVault, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null";
const CLASS: &str = "HeliosVault.SwAddin";
const TITLE: &str = "Helios Vault";
const DESCRIPTION: &str = "Sun Devil Motorsports - Helios PDM";

pub(crate) fn code_base(dll: &Path) -> String {
    format!("file:///{}", dll.display().to_string().replace('\\', "/"))
}

/// Write the per-user parts (no admin): the managed-COM CLSID pointing at `dll`
/// and the per-user auto-load flag. SOLIDWORKS still won't *load* it until the
/// HKLM list entry exists (see `register_hklm_list_elevated`).
pub fn register_per_user(dll: &Path, file_version: &str) -> std::io::Result<()> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let cb = code_base(dll);

    // Per-user auto-load flag (HKCU is the ONLY place this lives).
    let (startup, _) = hkcu.create_subkey(format!("Software\\SolidWorks\\AddInsStartup\\{GUID}"))?;
    startup.set_value("", &1u32)?;

    // Managed-COM CLSID (per-user).
    let (inproc, _) =
        hkcu.create_subkey(format!("Software\\Classes\\CLSID\\{GUID}\\InprocServer32"))?;
    inproc.set_value("", &"mscoree.dll")?;
    inproc.set_value("ThreadingModel", &"Both")?;
    inproc.set_value("Class", &CLASS)?;
    inproc.set_value("Assembly", &ASSEMBLY)?;
    inproc.set_value("RuntimeVersion", &"v4.0.30319")?;
    inproc.set_value("CodeBase", &cb)?;

    let (inproc_ver, _) = inproc.create_subkey(file_version)?;
    inproc_ver.set_value("Class", &CLASS)?;
    inproc_ver.set_value("Assembly", &ASSEMBLY)?;
    inproc_ver.set_value("RuntimeVersion", &"v4.0.30319")?;
    inproc_ver.set_value("CodeBase", &cb)?;

    let (progid, _) = hkcu.create_subkey(format!("Software\\Classes\\CLSID\\{GUID}\\ProgId"))?;
    progid.set_value("", &CLASS)?;
    Ok(())
}

/// True if the registered CLSID CodeBase already points at `dll` (skip rewrite).
pub fn already_points_at(dll: &Path) -> bool {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let want = code_base(dll);
    hkcu.open_subkey(format!("Software\\Classes\\CLSID\\{GUID}\\InprocServer32"))
        .and_then(|k| k.get_value::<String, _>("CodeBase"))
        .map(|cb| cb.eq_ignore_ascii_case(&want))
        .unwrap_or(false)
}

/// True if the machine-wide discovery entry exists (readable without admin).
pub fn hklm_list_entry_present() -> bool {
    RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(format!("SOFTWARE\\SolidWorks\\AddIns\\{GUID}"))
        .is_ok()
}

/// Write the HKLM list entry via an elevated `reg import` (one UAC). Returns
/// Err if the user declines the prompt or the import fails. We use a .reg file +
/// `reg import` to avoid quoting issues, and REGEDIT4 (ANSI) so the ASCII
/// content needs no UTF-16 encoding.
pub fn register_hklm_list_elevated() -> Result<(), String> {
    let content = format!(
        "REGEDIT4\r\n\r\n[HKEY_LOCAL_MACHINE\\SOFTWARE\\SolidWorks\\AddIns\\{GUID}]\r\n\
         @=dword:00000001\r\n\"Title\"=\"{TITLE}\"\r\n\"Description\"=\"{DESCRIPTION}\"\r\n"
    );
    // Write into a freshly-created random per-invocation temp subdir and import
    // by absolute path — a fixed, predictable path under an elevated reg.exe is a
    // TOCTOU local-privesc vector (see addin_injector::elevated_reg_import).
    if !super::elevated_reg_import(&content)? {
        return Err("elevation was declined or the registry import failed".into());
    }
    // reg.exe exiting 0 doesn't guarantee the key landed (policy software can
    // swallow the write, and Start-Process success only proves the process
    // ran). Verify before reporting success — callers latch a one-shot
    // "attempted" flag on Ok, and latching it on a phantom success would leave
    // the add-in undiscoverable with no retry.
    if !hklm_list_entry_present() {
        return Err("registry import reported success but the HKLM entry is missing — retry from Settings".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookups_do_not_panic() {
        let _ = hklm_list_entry_present();
        let _ = already_points_at(std::path::Path::new("C:\\nope\\HeliosVault.dll"));
    }
}
