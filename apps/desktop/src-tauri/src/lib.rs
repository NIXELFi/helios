mod commands;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::load_csv::load_csv
        ])
        .run(tauri::generate_context!())
        .expect("error while running Helios");
}
