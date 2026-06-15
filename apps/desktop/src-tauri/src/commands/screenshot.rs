//! Native screenshot for the in-app bug report. Captures the real window pixels
//! (incl. WebGL/canvas content the DOM doesn't expose) and returns PNG bytes.
use std::io::Cursor;
use tauri::{command, Window};

#[command]
pub fn capture_app_screenshot(window: Window) -> Result<Vec<u8>, String> {
    let target = window.title().unwrap_or_default();
    let windows = xcap::Window::all().map_err(|e| format!("enumerate windows: {e}"))?;
    // Prefer the window whose title matches ours; fall back to the first Helios
    // window, then bail with a clear error the UI degrades on.
    let win = windows
        .iter()
        .find(|w| !target.is_empty() && w.title() == target)
        .or_else(|| windows.iter().find(|w| w.app_name().to_lowercase().contains("helios")))
        .ok_or_else(|| "Helios window not found for capture".to_string())?;
    let img = win.capture_image().map_err(|e| format!("capture: {e}"))?; // RgbaImage
    let mut bytes: Vec<u8> = Vec::new();
    // RgbaImage has no direct write_to; wrap in DynamicImage first. `image` is
    // re-exported by xcap so no separate dependency is needed.
    xcap::image::DynamicImage::ImageRgba8(img)
        .write_to(&mut Cursor::new(&mut bytes), xcap::image::ImageFormat::Png)
        .map_err(|e| format!("encode png: {e}"))?;
    Ok(bytes)
}
