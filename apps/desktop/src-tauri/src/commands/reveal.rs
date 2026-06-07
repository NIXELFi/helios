//! Reveal a file in the OS file manager with the file pre-selected.
use std::path::Path;

#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err("file does not exist locally".into());
    }
    #[cfg(target_os = "windows")]
    {
        // `explorer /select,"<path>"` opens the parent folder with the file
        // highlighted. Explorer wants backslashes — and the argument must be
        // passed RAW: std's Command quotes the whole arg when it contains
        // spaces (`"/select,C:\a b\f.txt"`), which Explorer misparses and
        // falls back to opening a default folder. raw_arg lets us quote just
        // the path portion the way Explorer expects.
        use std::os::windows::process::CommandExt;
        let win = path.replace('/', "\\");
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{win}\""))
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Err("reveal not supported on this platform".into())
    }
}
