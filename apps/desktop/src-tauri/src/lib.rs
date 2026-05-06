mod commands;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::load_csv::load_csv,
            commands::restart::helios_relaunch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Helios");
}
