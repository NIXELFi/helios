mod commands;

use std::sync::Mutex;
use tauri::{Emitter, Manager};

pub struct PendingOpenFiles(pub Mutex<Vec<String>>);

#[tauri::command]
fn get_pending_open_files(state: tauri::State<'_, PendingOpenFiles>) -> Vec<String> {
    let mut guard = state.0.lock().unwrap();
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

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
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
                    state.0.lock().unwrap().extend(helios_paths);
                }
            } else if let Some(window) = app.get_webview_window("main") {
                // No .helios paths in argv — just bring the existing window
                // forward (the user clicked the app icon while it was running).
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }))
        .manage(pending)
        .on_page_load(|window, _payload| {
            let app = window.app_handle();
            let state = app.state::<PendingOpenFiles>();
            let mut guard = state.0.lock().unwrap();
            if guard.is_empty() {
                return;
            }
            let drained: Vec<String> = guard.drain(..).collect();
            let _ = window.emit("helios://open-files", drained);
        })
        .invoke_handler(tauri::generate_handler![
            commands::load_csv::load_csv,
            commands::restart::helios_relaunch,
            get_pending_open_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Helios");
}
