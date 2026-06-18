//! Self-healing SOLIDWORKS add-in provisioning, run on every Helios launch.
//!
//! Detects SOLIDWORKS, stages the bundled (version-stamped) `HeliosVault.dll`
//! into a version-specific folder, and writes the per-user (HKCU) add-in + COM
//! registration pointing at it — no RegAsm, no elevation. Because each version
//! gets its own folder, an updated DLL never collides with one a running SW has
//! loaded; SW picks up the new version on its next launch. Everything is
//! best-effort: any failure logs and returns, never blocking app launch.

pub mod registry;
pub mod shell;
pub mod staging;
pub mod sw_detect;

use tauri::{AppHandle, Manager};

/// Write `content` to a freshly-created, per-invocation temp subdirectory and run
/// an elevated `reg import` (one UAC) on it by absolute path, then clean up.
///
/// The subdirectory is created with `create_new` (exclusive create) under a
/// random name so the path can't be predicted and pre-created by another local
/// user between write and import — closing the TOCTOU local-privesc window that a
/// fixed, predictable temp path under an elevated `reg.exe` would open. Returns
/// the elevated process exit status (success ≠ the keys necessarily landed —
/// callers still verify the keys exist).
pub(crate) fn elevated_reg_import(content: &str) -> Result<bool, String> {
    // Unique-enough per-invocation name: pid + a high-res clock. create_new below
    // makes the directory creation itself the exclusivity guarantee (fails if the
    // path somehow already exists) so we never import from an attacker-seeded dir.
    let nonce = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let dir = std::env::temp_dir().join(format!("helios-reg-{nonce}"));
    std::fs::create_dir(&dir).map_err(|e| format!("create temp dir: {e}"))?;
    let path = dir.join("import.reg");
    let write_res = std::fs::File::options()
        .write(true)
        .create_new(true)
        .open(&path)
        .and_then(|mut f| std::io::Write::write_all(&mut f, content.as_bytes()));
    if let Err(e) = write_res {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(format!("write reg file: {e}"));
    }

    // Start-Process … -Verb RunAs triggers the UAC; -Wait so a decline (which
    // throws) surfaces as a non-zero exit. Import by absolute path.
    let ps = format!(
        "$ErrorActionPreference='Stop'; Start-Process -FilePath reg.exe \
         -ArgumentList @('import', '{}') -Verb RunAs -Wait",
        path.display().to_string().replace('\'', "''")
    );
    let status = std::process::Command::new("powershell")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &ps])
        .status()
        .map_err(|e| format!("spawn elevation: {e}"));
    let _ = std::fs::remove_dir_all(&dir);
    Ok(status?.success())
}

/// Resolve the bundled add-in DLL from Tauri resources (`resources/addin/`).
fn bundled_dll(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .resolve("addin/HeliosVault.dll", tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|p| p.exists())
}

/// Resolve the bundled Explorer shell-extension DLL (`resources/shell/`).
fn bundled_shell_dll(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .resolve("shell/HeliosShell.dll", tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|p| p.exists())
}

/// Provision the Explorer shell extension: stage the bundled DLL into a
/// version folder + register the per-user CLSID + context-menu handler. Picked
/// up by Explorer on the next right-click (no restart for the context menu).
/// Best-effort — any failure logs and returns, never blocking launch.
fn provision_shell(app: &AppHandle) {
    let Some(dll) = bundled_shell_dll(app) else { return };
    let Some(version) = staging::dll_file_version(&dll) else {
        eprintln!("injector: couldn't read shell-ext DLL version");
        return;
    };
    let changed = shell::staged_version().as_deref() != Some(version.as_str());
    let staged = match shell::stage(&dll, &version) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("injector: shell-ext stage failed: {e}");
            return;
        }
    };
    if changed || !shell::already_registered(&staged) {
        match shell::register_shell_per_user(&staged, &version) {
            Ok(()) => eprintln!("injector: shell extension registered -> v{version}"),
            Err(e) => eprintln!("injector: shell-ext register failed: {e}"),
        }
    }
    shell::gc(&version);
}

/// Provision the add-in. Returns true if a (re)registration happened this run.
pub fn run(app: &AppHandle) -> bool {
    // The Explorer shell extension is independent of SOLIDWORKS — provision it
    // every launch regardless of whether SW is installed.
    provision_shell(app);

    if sw_detect::solidworks_install_dir().is_none() {
        return false; // SW not installed — no add-in to provision.
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
        // Latch "attempted" only AFTER a successful elevated write. Latching
        // before (or on failure) would let one transient failure — a declined
        // UAC, a policy block, a flaky elevation spawn — permanently suppress the
        // auto-prompt, leaving the add-in undiscoverable until the user finds the
        // manual "Install / repair" in Settings.
        match registry::register_hklm_list_elevated() {
            Ok(()) => {
                staging::set_hklm_attempted(true);
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

    // Also enable the Explorer icon overlays — their ShellIconOverlayIdentifiers
    // entry is HKLM-only, so it needs the same elevated "repair" gesture (never
    // the auto-startup path, which can't pop a UAC unattended). Per-user CLSIDs
    // are already registered at launch by provision_shell. The user must restart
    // Explorer afterward for the overlays to appear.
    if let Some(sdll) = bundled_shell_dll(app) {
        if let Some(sv) = staging::dll_file_version(&sdll) {
            let sstaged = shell::stage(&sdll, &sv).map_err(|e| e.to_string())?;
            shell::register_shell_per_user(&sstaged, &sv).map_err(|e| e.to_string())?;
            if !shell::overlay_hklm_present() {
                shell::register_overlays_hklm_elevated()?;
            }
        }
    }
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
