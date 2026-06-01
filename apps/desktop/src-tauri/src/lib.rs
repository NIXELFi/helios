mod addin_injector;
mod bridge;
mod cfd;
mod commands;

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

/// Enable/disable launch-on-login (Settings toggle).
#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let a = app.autolaunch();
    if enabled { a.enable() } else { a.disable() }.map_err(|e| e.to_string())
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
    addin_injector::provision_now(&app)
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let helios_paths: Vec<String> = extract_helios_paths(argv.into_iter().skip(1));
            if !helios_paths.is_empty() {
                if let Some(window) = app.get_webview_window("main") {
                    // Common path: window exists, emit directly to it (window-
                    // scoped, not app.emit which broadcasts to every window).
                    let _ = window.emit("helios://open-files", &helios_paths);
                    let _ = window.set_focus();
                    let _ = window.unminimize();
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
            } else if let Some(window) = app.get_webview_window("main") {
                // No .helios paths in argv — just bring the existing window
                // forward (the user clicked the app icon while it was running).
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }))
        .manage(pending)
        .manage(cfd::CfdState::default())
        .manage(bridge_state.clone())
        .setup(move |app| {
            // Best-effort: a bridge failure (e.g. port bind) must never stop the
            // app from launching. The add-in degrades to "Helios not reachable".
            if let Err(e) = bridge::start(app.handle().clone(), bridge_state.clone()) {
                eprintln!("helios-vault-bridge failed to start: {e}");
            }

            // Provision / refresh the SOLIDWORKS add-in (per-user, no admin).
            // Best-effort; never block launch.
            let ah = app.handle().clone();
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                addin_injector::run(&ah);
            }));

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

            // Auto-start on login (enabled by default; user can disable in
            // Settings). When launched via autostart (--hidden), go to the tray.
            {
                use tauri_plugin_autostart::ManagerExt;
                let _ = app.autolaunch().enable();
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
            commands::parse_refs::parse_sw_refs,
            commands::parse_refs::parse_sw_properties,
            bridge::bridge_set_session,
            bridge::bridge_clear_session,
            bridge::bridge_set_snapshot,
            bridge::bridge_respond,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Helios");
}
