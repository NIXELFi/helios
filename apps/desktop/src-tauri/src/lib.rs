// Windows-only: SOLIDWORKS add-in injection + registry (winreg). Gated so
// helios-desktop still compiles for the macOS/Linux release builds.
#[cfg(windows)]
mod addin_injector;
mod bridge;
mod cfd;
mod commands;
mod plugins;

use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

pub struct PendingOpenFiles(pub Mutex<Vec<String>>);

/// Show + focus the main window (from the tray).
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Marker file recording that the first-run autostart default has been applied.
/// Its presence means the user has an explicit launch-on-login preference (either
/// the default we set on first launch, or a later Settings toggle), so `.setup`
/// must NOT re-enable autostart and clobber a user who turned it off.
///
/// Resolved through Tauri's path API so it lands in the app's own local-data
/// directory on every platform. It used to read %LOCALAPPDATA% directly and fall
/// back to `temp_dir()` — but that env var is Windows-only, so macOS/Linux wrote
/// the marker into a temp dir that the OS purges (macOS after ~3 days, Linux on
/// reboot). Once it vanished, `.setup` saw "no preference" and silently
/// re-enabled launch-on-login for a user who had turned it off.
fn autostart_marker(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|dir| dir.join("autostart.applied"))
}

/// Pre-fix marker location (%LOCALAPPDATA%\Helios\autostart.applied). Still
/// honoured on read so existing Windows users who disabled launch-on-login
/// don't get it re-enabled once by the move to the new path.
fn legacy_autostart_marker() -> Option<std::path::PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|local| {
        std::path::PathBuf::from(local)
            .join("Helios")
            .join("autostart.applied")
    })
}

/// True when the user already has an explicit launch-on-login preference.
fn autostart_preference_recorded(app: &tauri::AppHandle) -> bool {
    autostart_marker(app).is_some_and(|p| p.exists())
        || legacy_autostart_marker().is_some_and(|p| p.exists())
}

/// Record that the user now has an explicit autostart preference, so the
/// first-run default in `.setup` won't override it on the next launch.
fn mark_autostart_preference_set(app: &tauri::AppHandle) {
    let Some(path) = autostart_marker(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&path, b"1");
}

/// Enable/disable launch-on-login (Settings toggle).
#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let a = app.autolaunch();
    if enabled { a.enable() } else { a.disable() }.map_err(|e| e.to_string())?;
    // The user made an explicit choice — stop the first-run default from
    // re-enabling autostart on the next launch.
    mark_autostart_preference_set(&app);
    Ok(())
}

/// Current launch-on-login state (for the Settings toggle).
#[tauri::command]
fn get_autostart(app: tauri::AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// Force-install / repair the SOLIDWORKS add-in registration. Prompts once for
/// elevation to write the machine-wide (HKLM) discovery entry; the per-user
/// CLSID stays no-admin. Backs the Settings "Install / repair add-in" action.
#[tauri::command]
fn provision_sw_addin(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        addin_injector::provision_now(&app)
    }
    // The add-in is a Windows-only SOLIDWORKS integration; on other platforms
    // the command exists (so the frontend can call it) but is a no-op error.
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("The SOLIDWORKS add-in is only available on Windows.".into())
    }
}

#[tauri::command]
fn get_pending_open_files(state: tauri::State<'_, PendingOpenFiles>) -> Vec<String> {
    // Recover from a poisoned mutex instead of crashing the IPC command —
    // any panic in a holder is non-fatal; the queue is just a Vec<String>.
    let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let drained: Vec<String> = guard.drain(..).collect();
    drained
}

fn extract_helios_paths<I: IntoIterator<Item = String>>(args: I) -> Vec<String> {
    args.into_iter()
        .filter(|s| {
            let p = std::path::Path::new(s);
            p.extension().map(|e| e.to_ascii_lowercase()) == Some("helios".into())
        })
        .collect()
}

pub fn run() {
    let first_launch_paths: Vec<String> = extract_helios_paths(std::env::args().skip(1));
    let pending = PendingOpenFiles(Mutex::new(first_launch_paths));

    // Shared state for the SOLIDWORKS add-in bridge. Started in `.setup` once the
    // app is up; the frontend feeds it the session + vault snapshot over IPC.
    let bridge_state = Arc::new(bridge::BridgeState::new());

    tauri::Builder::default()
        // MUST be the first plugin registered (Tauri's own requirement). A second
        // launch runs every plugin registered before this one to completion before
        // the callback below bails the process — including autostart's enable
        // side-effect. Registered last, a stray double-launch could re-apply
        // launch-on-login behind the user's back.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let helios_paths: Vec<String> = extract_helios_paths(argv.into_iter().skip(1));
            if !helios_paths.is_empty() {
                if let Some(window) = app.get_webview_window("main") {
                    // Common path: window exists, emit directly to it (window-
                    // scoped, not app.emit which broadcasts to every window).
                    // show() first: the window may be HIDDEN (closed-to-tray /
                    // --hidden autostart), and focus/unminimize on a hidden
                    // window is a no-op — the relaunch would appear to do
                    // nothing.
                    let _ = window.emit("helios://open-files", &helios_paths);
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                } else if let Some(state) = app.try_state::<PendingOpenFiles>() {
                    // Edge case: a 2nd launch arrived before this 1st instance
                    // finished booting. Queue the paths into PendingOpenFiles
                    // so on_page_load drains them when the window is ready.
                    state
                        .0
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .extend(helios_paths);
                }
            } else {
                // No .helios paths in argv — the user launched Helios (Start
                // menu / Explorer) while it was already running in the tray.
                // Bring the window back: show + unminimize + focus, same as
                // the tray's "Open" action (show_main).
                show_main(app);
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .manage(pending)
        .manage(cfd::CfdState::default())
        .manage(bridge_state.clone())
        // Active installed-plugin versions, read by the `plugin://` asset protocol
        // (populated by the install command in a later phase).
        .manage(plugins::ActiveVersions::default())
        // `plugin://<id>/<path>` serves installed bundles from the local cache with
        // the strict plugin CSP attached as a response header. Registering it is
        // inert until a plugin is installed (the A dev example still uses srcDoc).
        .register_uri_scheme_protocol("plugin", plugins::protocol::handle)
        .setup(move |app| {
            // Best-effort: a bridge failure (e.g. port bind) must never stop the
            // app from launching. The add-in degrades to "Helios not reachable".
            if let Err(e) = bridge::start(app.handle().clone(), bridge_state.clone()) {
                eprintln!("helios-vault-bridge failed to start: {e}");
            }

            // Rebuild the active-plugin-version map from the on-disk install cache
            // (it doesn't survive a restart); without it an installed plugin would
            // 404 from the plugin:// protocol until reinstalled.
            plugins::cache::restore_active_versions(app.handle());
            plugins::cache::sweep_publish_staging(app.handle());

            // Provision / refresh the SOLIDWORKS add-in (per-user, no admin).
            // Best-effort; never block launch. Windows-only (SOLIDWORKS + registry).
            #[cfg(windows)]
            {
                let ah = app.handle().clone();
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    addin_injector::run(&ah);
                }));
            }

            // System tray — keeps Helios resident so the bridge stays live even
            // when the window is closed-to-tray.
            {
                use tauri::menu::{MenuBuilder, MenuItemBuilder};
                use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
                let open = MenuItemBuilder::with_id("open", "Open Helios").build(app)?;
                let quit = MenuItemBuilder::with_id("quit", "Quit Helios").build(app)?;
                let menu = MenuBuilder::new(app).items(&[&open, &quit]).build()?;
                let mut tray = TrayIconBuilder::with_id("helios")
                    .tooltip("Helios — Ground Station")
                    .menu(&menu)
                    .on_menu_event(|app, e| match e.id().as_ref() {
                        "open" => show_main(app),
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
                            show_main(tray.app_handle());
                        }
                    });
                if let Some(icon) = app.default_window_icon() {
                    tray = tray.icon(icon.clone());
                }
                let _ = tray.build(app)?;
            }

            // Auto-start on login: enabled by default ONLY on first run. Once a
            // preference has been recorded (the first-run default, or a later
            // Settings toggle), respect it — re-enabling here every launch would
            // silently undo a user who turned launch-on-login off in Settings.
            {
                use tauri_plugin_autostart::ManagerExt;
                if !autostart_preference_recorded(app.handle()) {
                    let _ = app.autolaunch().enable();
                    mark_autostart_preference_set(app.handle());
                }
            }
            if std::env::args().any(|a| a == "--hidden") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Close → hide to tray (real quit only from the tray menu), so the
            // localhost bridge keeps serving the SOLIDWORKS add-in.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .on_page_load(|window, _payload| {
            let app = window.app_handle();
            let state = app.state::<PendingOpenFiles>();
            let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
            if guard.is_empty() {
                return;
            }
            let drained: Vec<String> = guard.drain(..).collect();
            let _ = window.emit("helios://open-files", drained);
        })
        .invoke_handler(tauri::generate_handler![
            commands::load_csv::load_csv,
            commands::restart::helios_relaunch,
            commands::set_readonly::set_path_readonly,
            commands::set_readonly::sw_flip_readonly,
            commands::parse_refs::parse_sw_refs,
            commands::parse_refs::parse_sw_properties,
            commands::reveal::reveal_in_explorer,
            commands::open_url::open_external_url,
            bridge::bridge_set_session,
            bridge::bridge_clear_session,
            bridge::bridge_set_snapshot,
            bridge::bridge_respond,
            bridge::bridge_addin_active,
            set_autostart,
            get_autostart,
            provision_sw_addin,
            get_pending_open_files,
            cfd::commands::cfd_load_config,
            cfd::commands::cfd_save_config,
            cfd::commands::cfd_default_save_dir,
            cfd::commands::cfd_list_examples,
            cfd::commands::cfd_start_job,
            cfd::commands::cfd_cancel_job,
            cfd::commands::cfd_list_jobs,
            cfd::commands::cfd_load_capture,
            cfd::commands::cfd_load_waves,
            cfd::commands::cfd_get_parameter_schema,
            cfd::commands::cfd_data_usage_bytes,
            cfd::commands::cfd_clear_data,
            plugins::commands::install_plugin_bundle,
            plugins::commands::pack_plugin_bundle,
            plugins::commands::inspect_plugin_bundle,
            plugins::commands::discard_staged_bundle,
            plugins::commands::remove_plugin_bundle,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Helios")
        .run(|_app, _event| {
            // macOS counterpart of the Windows single-instance relaunch: a
            // Dock-icon click while the window is hidden-to-tray fires Reopen
            // (no second process), and without this the click does nothing.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                show_main(_app);
            }
        });
}
