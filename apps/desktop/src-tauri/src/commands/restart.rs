//! Custom relaunch command. Tauri's built-in `relaunch` plugin spawns the
//! new process and `exit(0)`s synchronously, which races with macOS
//! LaunchServices and frequently leaves the new app launched-but-not-focused
//! after an auto-update. The user sees the old window vanish and the new one
//! never appears — the textbook "auto-update did nothing" bug.
//!
//! This command does the same job with three corrections:
//!  1. Strips com.apple.quarantine xattrs from the bundle so macOS doesn't
//!     run the new app under App Translocation (which silently fails for
//!     some bundles after an in-place replace).
//!  2. Uses `open -na <Bundle.app>` — `-n` for new instance, `-a` to
//!     resolve as an Application (gives proper focus + LaunchServices
//!     registration), unlike the plain `open -n` Tauri uses.
//!  3. Sleeps briefly between spawn and exit so LaunchServices has time
//!     to register the launch before the parent process disappears.
//!
//! Windows and Linux fall through to the standard self-spawn path which
//! works fine on those platforms.
//!
//! SECURITY TODO (ultrareview-2026-05-11, finding M19): this command is
//! registered via `invoke_handler!` and is therefore invocable from any
//! renderer context — including injected content if an XSS ever reaches
//! the WebView. A renderer can call `helios_relaunch` to terminate the
//! process at will.
//!
//! NOTE on why no capability-gate exists here: Tauri 2's capability /
//! permission ACL system gates *plugin*-defined commands only. App-defined
//! `#[tauri::command]` functions registered via `tauri::generate_handler!`
//! are not subject to capability filtering by default — they would need an
//! app-side permission manifest under `src-tauri/permissions/*.toml` plus
//! corresponding wiring in `tauri.conf.json` (`app.security.capabilities`).
//! That refactor is tracked separately; the new `capabilities/updates.json`
//! file added alongside this change is a first step (it isolates the
//! updater plugin's IPC surface so it can be revoked or rescoped without
//! touching the always-on capability).
//!
//! Narrowing `helios_relaunch` itself needs one of:
//!   1. Add `apps/desktop/src-tauri/permissions/allow-relaunch.toml`
//!      defining `allow-helios-relaunch`, declare it under
//!      `tauri.conf.json` -> `app.security.capabilities`, and grant it
//!      ONLY from the `updates` capability (so it shares the updater's
//!      gate and can be revoked together). Requires editing tauri.conf.json.
//!   2. OR replace this with a direct invocation from the Rust-side
//!      updater hook so no IPC surface exists at all.
//! Until then we accept the gap because (a) the renderer is bundled, not
//! remote, so XSS surface is low, and (b) breaking the post-update relaunch
//! UX would be worse than the current exposure. Revisit when the updater
//! flow is refactored.

use std::path::PathBuf;
use std::process::Command;
use std::thread;
use std::time::Duration;

use tauri::AppHandle;

#[tauri::command]
pub fn helios_relaunch(app: AppHandle) {
    if let Err(e) = perform_relaunch(&app) {
        eprintln!("[helios] relaunch failed: {e}");
    }
    // Whether or not the new instance fired, exit. The user will at worst
    // need to launch from /Applications manually — same as today.
    app.exit(0);
}

#[cfg(target_os = "macos")]
fn perform_relaunch(_app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let bundle = bundle_path()?;
    // Defense in depth: if the bundle picked up a quarantine xattr from the
    // updater download, clear it before LaunchServices sees the new path.
    let _ = Command::new("xattr").args(["-cr"]).arg(&bundle).output();
    Command::new("open").args(["-na"]).arg(&bundle).spawn()?;
    // 800 ms is empirically enough for LaunchServices to register the new
    // process and bring its window to the foreground; less than that
    // produces the "ghost launch" the bug report describes.
    thread::sleep(Duration::from_millis(800));
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn perform_relaunch(_app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let exe = std::env::current_exe()?;
    Command::new(exe).spawn()?;
    thread::sleep(Duration::from_millis(200));
    Ok(())
}

#[cfg(target_os = "macos")]
fn bundle_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    // `current_exe()` on macOS = .../Helios.app/Contents/MacOS/helios-desktop
    // Walk up three levels to reach the .app bundle directory.
    let exe = std::env::current_exe()?;
    let bundle = exe
        .parent() // MacOS
        .and_then(|p| p.parent()) // Contents
        .and_then(|p| p.parent()) // Helios.app
        .ok_or("could not derive bundle path from current_exe")?;
    Ok(bundle.to_path_buf())
}
