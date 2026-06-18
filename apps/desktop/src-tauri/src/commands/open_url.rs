//! Open an external http(s) URL in the user's default browser. Used by PM task
//! links. Kept std-only (no Tauri opener plugin) to avoid adding a dependency +
//! capability to the release build. Mirrors the OS-shell approach in reveal.rs.

/// Open `url` in the default browser. Rejects anything that isn't http/https so
/// a stored `file://`, `javascript:`, or shell-looking value can never be handed
/// to the OS shell.
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("only http(s) URLs can be opened".into());
    }
    #[cfg(target_os = "windows")]
    {
        // rundll32 url.dll,FileProtocolHandler hands the URL to the registered
        // browser and, unlike `cmd /c start`, does NOT mis-handle `&` in query
        // strings. The URL is passed as a single argument, not via the shell.
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}
