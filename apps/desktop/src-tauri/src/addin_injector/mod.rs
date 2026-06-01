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
    if !changed && registry::already_points_at(&staged) {
        return false; // already up to date
    }
    if let Err(e) = registry::register(&staged, &version) {
        eprintln!("injector: register failed: {e}");
        return false;
    }
    staging::gc(&version);

    if sw_detect::is_sldworks_running() {
        notify_restart_sw(app);
    }
    eprintln!("injector: add-in registered v{version} at {}", staged.display());
    true
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
