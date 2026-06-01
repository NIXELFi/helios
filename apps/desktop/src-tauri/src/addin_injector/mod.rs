//! Self-healing SOLIDWORKS add-in provisioning, run on every Helios launch.
//!
//! Detects SOLIDWORKS, stages the bundled (version-stamped) `HeliosVault.dll`
//! into a version-specific folder, and writes the per-user (HKCU) add-in + COM
//! registration pointing at it — no RegAsm, no elevation. Because each version
//! gets its own folder, an updated DLL never collides with one a running SW has
//! loaded; SW picks up the new version on its next launch. Everything is
//! best-effort: any failure logs and returns, never blocking app launch.

pub mod registry;
pub mod staging;
pub mod sw_detect;

use tauri::{AppHandle, Manager};

/// Resolve the bundled add-in DLL from Tauri resources (`resources/addin/`).
fn bundled_dll(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .resolve("addin/HeliosVault.dll", tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|p| p.exists())
}

/// Provision the add-in. Returns true if a (re)registration happened this run.
pub fn run(app: &AppHandle) -> bool {
    if sw_detect::solidworks_install_dir().is_none() {
        return false; // SW not installed — nothing to do.
    }
    let Some(dll) = bundled_dll(app) else {
        eprintln!("injector: bundled add-in DLL not found (skipping)");
        return false;
    };
    let Some(version) = staging::dll_file_version(&dll) else {
        eprintln!("injector: couldn't read add-in DLL version");
        return false;
    };

    let changed = staging::staged_version().as_deref() != Some(version.as_str());
    let staged = match staging::stage(&dll, &version) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("injector: stage failed: {e}");
            return false;
        }
    };

    let mut did_something = false;

    // Per-user CLSID + AddInsStartup (no admin) — keep current with the staged DLL.
    if changed || !registry::already_points_at(&staged) {
        if let Err(e) = registry::register_per_user(&staged, &version) {
            eprintln!("injector: per-user register failed: {e}");
            return false;
        }
        did_something = true;
        eprintln!("injector: per-user registration updated → v{version}");
    }
    staging::gc(&version);

    // Machine-wide discovery entry (HKLM) — SOLIDWORKS finds add-ins ONLY here,
    // and it needs elevation. Prompt once if missing; the user can retry from
    // Settings (provision_now) if they decline.
    if !registry::hklm_list_entry_present() && !staging::hklm_attempted() {
        staging::set_hklm_attempted(true);
        match registry::register_hklm_list_elevated() {
            Ok(()) => {
                did_something = true;
                eprintln!("injector: HKLM discovery entry installed");
            }
            Err(e) => eprintln!("injector: HKLM provisioning skipped ({e}) — retry from Settings"),
        }
    }

    if did_something && sw_detect::is_sldworks_running() {
        notify_restart_sw(app);
    }
    did_something
}

/// Force a full (re)install of the add-in registration, prompting for elevation
/// for the HKLM discovery entry. Backs the Settings "Install / repair add-in".
pub fn provision_now(app: &AppHandle) -> Result<(), String> {
    let dll = bundled_dll(app).ok_or("bundled add-in DLL not found")?;
    let version = staging::dll_file_version(&dll).ok_or("couldn't read add-in DLL version")?;
    let staged = staging::stage(&dll, &version).map_err(|e| e.to_string())?;
    registry::register_per_user(&staged, &version).map_err(|e| e.to_string())?;
    registry::register_hklm_list_elevated()?;
    staging::set_hklm_attempted(true);
    Ok(())
}

fn notify_restart_sw(app: &AppHandle) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title("Helios Vault add-in updated")
        .body("Restart SOLIDWORKS to load the Helios add-in.")
        .show();
}
