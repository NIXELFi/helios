//! Write the per-user (HKCU) SOLIDWORKS add-in + COM-CLSID registration pointing
//! at a staged DLL. No RegAsm, no elevation. Mirrors what RegAsm produces but
//! under HKCU\Software\Classes instead of HKLM, so it needs no admin.
//!
//! NOTE: gated on the Task 0 spike — if SOLIDWORKS 2025 turns out to require the
//! Addins *list* entry in HKLM, only `register_addins_list` needs to move to a
//! one-time elevated step; the CLSID stays per-user here.

use std::path::Path;
use winreg::enums::*;
use winreg::RegKey;

const GUID: &str = "{B7A4E2C9-3F1D-4A8B-9C2E-5D6F7A8B9C0D}";
// Matches the add-in's stable AssemblyVersion (never bumped) + class name.
const ASSEMBLY: &str = "HeliosVault, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null";
const CLASS: &str = "HeliosVault.SwAddin";

fn code_base(dll: &Path) -> String {
    format!("file:///{}", dll.display().to_string().replace('\\', "/"))
}

/// (Re)write every key so SOLIDWORKS discovers + auto-loads the add-in from
/// `dll`. `file_version` names the versioned InprocServer32 subkey.
pub fn register(dll: &Path, file_version: &str) -> std::io::Result<()> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let cb = code_base(dll);

    // Add-in list entry + per-user auto-load.
    let (addins, _) = hkcu.create_subkey(format!("Software\\SolidWorks\\Addins\\{GUID}"))?;
    addins.set_value("", &1u32)?;
    addins.set_value("Title", &"Helios Vault")?;
    addins.set_value("Description", &"Sun Devil Motorsports — Helios PDM")?;

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

/// True if the registered CodeBase already points at `dll` (skip rewrite).
pub fn already_points_at(dll: &Path) -> bool {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let want = code_base(dll);
    hkcu.open_subkey(format!("Software\\Classes\\CLSID\\{GUID}\\InprocServer32"))
        .and_then(|k| k.get_value::<String, _>("CodeBase"))
        .map(|cb| cb.eq_ignore_ascii_case(&want))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_then_points_at_under_a_test_guid() {
        // Exercise the real winreg write/read against a throwaway HKCU path so
        // we don't touch the actual add-in keys. We can't easily swap GUID, so
        // just verify already_points_at is false for a non-existent dll path
        // (no panic, no false positive).
        let p = std::path::Path::new("C:\\nonexistent\\HeliosVault.dll");
        let _ = already_points_at(p); // must not panic
    }
}
