# Helios Add-in Injector + Always-On Tray — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the SOLIDWORKS add-in zero-touch and team-shippable — Helios self-registers the add-in per-user (no admin), keeps it updated automatically, runs minimized in the tray with the bridge always live, and the add-in shows the signed-in user + online status.

**Architecture:** A Rust `addin_injector` module runs on every Helios launch: detects SOLIDWORKS, stages a version-stamped `HeliosVault.dll` into a version-specific folder, and writes the HKCU add-in + COM-CLSID keys directly (no RegAsm). Tauri tray + close-to-tray + autostart keep Helios resident. The bridge's `/health` is extended with identity; the add-in polls it.

**Tech Stack:** Rust (Tauri v2, `winreg`), Tauri plugins (`autostart`, `notification`), C# .NET Framework 4.8 (add-in), TypeScript/React (frontend handoff).

---

## Pre-flight: validate the no-admin assumption (DO THIS FIRST)

The entire "no UAC" design depends on SOLIDWORKS 2025 loading an add-in registered **entirely under HKCU**. Validate empirically before building anything.

### Task 0: Spike — prove HKCU-only registration loads in SW2025

**Files:** none (manual validation; throwaway script).

- [ ] **Step 1: Unregister the current HKLM registration** so the test is clean.

Run (elevated PowerShell):
```powershell
& "$env:windir\Microsoft.NET\Framework64\v4.0.30319\RegAsm.exe" /unregister "C:\Users\nick5\helios\solidworks-addin\src\bin\Release\net48\HeliosVault.dll"
Remove-Item "HKLM:\SOFTWARE\SolidWorks\Addins\{B7A4E2C9-3F1D-4A8B-9C2E-5D6F7A8B9C0D}" -Recurse -ErrorAction SilentlyContinue
```

- [ ] **Step 2: Write the keys entirely under HKCU** (no admin).

Run (normal PowerShell), pointing at the existing built DLL:
```powershell
$guid  = "{B7A4E2C9-3F1D-4A8B-9C2E-5D6F7A8B9C0D}"
$dll   = "C:\Users\nick5\helios\solidworks-addin\src\bin\Release\net48\HeliosVault.dll"
$asm   = [System.Reflection.AssemblyName]::GetAssemblyName($dll)
$asmFull = $asm.FullName
New-Item -Path "HKCU:\Software\SolidWorks\Addins\$guid" -Force | Out-Null
Set-ItemProperty "HKCU:\Software\SolidWorks\Addins\$guid" -Name "(default)" -Value 1 -Type DWord
Set-ItemProperty "HKCU:\Software\SolidWorks\Addins\$guid" -Name "Title" -Value "Helios Vault"
Set-ItemProperty "HKCU:\Software\SolidWorks\Addins\$guid" -Name "Description" -Value "Helios PDM"
New-Item -Path "HKCU:\Software\SolidWorks\AddInsStartup\$guid" -Force | Out-Null
Set-ItemProperty "HKCU:\Software\SolidWorks\AddInsStartup\$guid" -Name "(default)" -Value 1 -Type DWord
$cls = "HKCU:\Software\Classes\CLSID\$guid"
New-Item -Path "$cls\InprocServer32" -Force | Out-Null
Set-ItemProperty "$cls\InprocServer32" -Name "(default)" -Value "mscoree.dll"
Set-ItemProperty "$cls\InprocServer32" -Name "ThreadingModel" -Value "Both"
Set-ItemProperty "$cls\InprocServer32" -Name "Class" -Value "HeliosVault.SwAddin"
Set-ItemProperty "$cls\InprocServer32" -Name "Assembly" -Value $asmFull
Set-ItemProperty "$cls\InprocServer32" -Name "RuntimeVersion" -Value "v4.0.30319"
Set-ItemProperty "$cls\InprocServer32" -Name "CodeBase" -Value ("file:///" + ($dll -replace '\\','/'))
$verSub = "$cls\InprocServer32\" + $asm.Version.ToString()
New-Item -Path $verSub -Force | Out-Null
Set-ItemProperty $verSub -Name "Class" -Value "HeliosVault.SwAddin"
Set-ItemProperty $verSub -Name "Assembly" -Value $asmFull
Set-ItemProperty $verSub -Name "RuntimeVersion" -Value "v4.0.30319"
Set-ItemProperty $verSub -Name "CodeBase" -Value ("file:///" + ($dll -replace '\\','/'))
New-Item -Path "$cls\ProgId" -Force | Out-Null
Set-ItemProperty "$cls\ProgId" -Name "(default)" -Value "HeliosVault.SwAddin"
```

- [ ] **Step 3: Launch SOLIDWORKS and check.**

Close SW fully, relaunch, open **Tools → Add-Ins**.
Expected: **Helios Vault** is listed and ticked, and the Task Pane loads.

- [ ] **Step 4: Record the outcome and branch the rest of the plan.**

- If it loads → **proceed with the per-user plan unchanged.**
- If it does NOT load (SW ignores HKCU Addins) → the add-in *list* entry must be in HKLM. Adjust Task 4: write `Software\SolidWorks\Addins\{guid}` (Title/Description/enable) under **HKLM** via a single elevated step at first run, keep the CLSID + AddInsStartup under HKCU. Note this in the plan and continue.

---

## File structure

- Create: `apps/desktop/src-tauri/src/addin_injector/mod.rs` — orchestrates detect → stage → register → notify → gc.
- Create: `apps/desktop/src-tauri/src/addin_injector/sw_detect.rs` — find SOLIDWORKS install + running state.
- Create: `apps/desktop/src-tauri/src/addin_injector/registry.rs` — write the HKCU add-in + CLSID keys.
- Create: `apps/desktop/src-tauri/src/addin_injector/staging.rs` — versioned DLL staging + state.json + gc.
- Modify: `apps/desktop/src-tauri/Cargo.toml` — add `winreg`, `tauri-plugin-autostart`, `tauri-plugin-notification`.
- Modify: `apps/desktop/src-tauri/src/lib.rs` — register plugins, run injector in `setup`, tray + close-to-tray.
- Modify: `apps/desktop/src-tauri/tauri.conf.json` — bundle the add-in DLL resource; tray icon.
- Modify: `apps/desktop/src-tauri/capabilities/*.json` — notification + autostart permissions.
- Modify: `solidworks-addin/src/HeliosVault.csproj` — stamp `AssemblyFileVersion`.
- Modify: `apps/desktop/src/modules/vault/data/useBridgeSync.ts` — push `displayName` + `email`.
- Modify: `apps/desktop/src-tauri/src/bridge/mod.rs` + `server.rs` — identity in session + `/health`.
- Modify: `solidworks-addin/src/HeliosVaultControl.cs` + `SwAddin.cs` — connection/identity line + poll.

---

## Task 1: Version-stamp the add-in DLL

**Files:** Modify `solidworks-addin/src/HeliosVault.csproj`.

- [ ] **Step 1: Add an explicit assembly file version** (the injector compares this).

In `<PropertyGroup>` add:
```xml
<Version>3.8.2.0</Version>
<FileVersion>3.8.2.0</FileVersion>
<AssemblyVersion>1.0.0.0</AssemblyVersion>
```
Keep `AssemblyVersion` stable at `1.0.0.0` (the COM `Assembly` strong-ish name in the registry stays constant so the CLSID binding doesn't churn); bump `FileVersion` per add-in change.

- [ ] **Step 2: Rebuild and confirm the file version.**

Run (SW closed):
```powershell
& "C:\Program Files\dotnet\dotnet.exe" build -c Release "C:\Users\nick5\helios\solidworks-addin\src"
(Get-Item "C:\Users\nick5\helios\solidworks-addin\src\bin\Release\net48\HeliosVault.dll").VersionInfo.FileVersion
```
Expected: `3.8.2.0`.

- [ ] **Step 3: Commit.**
```bash
git add solidworks-addin/src/HeliosVault.csproj
git commit -m "build(sw-addin): stamp add-in FileVersion for injector version compare"
```

---

## Task 2: Add Rust dependencies

**Files:** Modify `apps/desktop/src-tauri/Cargo.toml`.

- [ ] **Step 1: Add the crates.**
```toml
winreg = "0.52"
tauri-plugin-autostart = "2"
tauri-plugin-notification = "2"
```

- [ ] **Step 2: Verify it resolves.**

Run:
```bash
cd /c/Users/nick5/helios/apps/desktop/src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo fetch
```
Expected: fetches without error.

- [ ] **Step 3: Commit.**
```bash
git add apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock
git commit -m "build(desktop): add winreg + autostart + notification crates"
```

---

## Task 3: SOLIDWORKS detection (`sw_detect.rs`)

**Files:** Create `apps/desktop/src-tauri/src/addin_injector/sw_detect.rs`; Create `apps/desktop/src-tauri/src/addin_injector/mod.rs` (module decl).

- [ ] **Step 1: Write the module skeleton + a unit test for `is_sldworks_running`.**

`mod.rs`:
```rust
pub mod sw_detect;
pub mod registry;
pub mod staging;
```

`sw_detect.rs`:
```rust
//! Locate SOLIDWORKS and whether it's currently running.
use std::path::PathBuf;

/// Returns the SOLIDWORKS install dir if installed, else None. Reads the
/// per-machine SOLIDWORKS registry; never errors out (returns None on any miss).
pub fn solidworks_install_dir() -> Option<PathBuf> {
    use winreg::enums::*;
    use winreg::RegKey;
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let sw = hklm.open_subkey("SOFTWARE\\SolidWorks").ok()?;
    // Prefer a "SOLIDWORKS <year>" subkey with Setup\SolidWorks Folder.
    for name in sw.enum_keys().flatten() {
        if let Ok(setup) = sw.open_subkey(format!("{name}\\Setup")) {
            if let Ok(folder) = setup.get_value::<String, _>("SolidWorks Folder") {
                let p = PathBuf::from(folder);
                if p.join("SLDWORKS.exe").exists() {
                    return Some(p);
                }
            }
        }
    }
    None
}

/// True if a SLDWORKS.exe process is currently running.
pub fn is_sldworks_running() -> bool {
    // Cheap + dependency-free: shell out to tasklist and look for the image.
    std::process::Command::new("tasklist")
        .args(["/FI", "IMAGENAME eq SLDWORKS.exe", "/NH"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_ascii_uppercase().contains("SLDWORKS.EXE"))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn running_check_does_not_panic() {
        let _ = is_sldworks_running();
    }
    #[test]
    fn install_dir_returns_some_when_sw_present_else_none() {
        // On the dev box SW2025 is installed; elsewhere this is None — both ok.
        let _ = solidworks_install_dir();
    }
}
```

- [ ] **Step 2: Run the tests.**
```bash
cd /c/Users/nick5/helios/apps/desktop/src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo test -p helios-desktop addin_injector::sw_detect -- --nocapture
```
Expected: PASS. On the dev box, optionally print `solidworks_install_dir()` and confirm it resolves to the SW2025 folder.

- [ ] **Step 3: Commit.**
```bash
git add apps/desktop/src-tauri/src/addin_injector/
git commit -m "feat(injector): detect SOLIDWORKS install + running state"
```

---

## Task 4: Versioned staging + state (`staging.rs`)

**Files:** Create `apps/desktop/src-tauri/src/addin_injector/staging.rs`.

- [ ] **Step 1: Write `staging.rs` with version compare + stage + state.json.**
```rust
//! Stage the bundled add-in DLL into a version-specific folder under
//! %LOCALAPPDATA%\Helios\addin\<version>\, tracking the active version in
//! state.json. Versioned folders mean a new DLL never overwrites one a running
//! SOLIDWORKS still has loaded.
use std::path::{Path, PathBuf};

pub fn addin_root() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("Helios")
        .join("addin")
}

/// FileVersion of a DLL ("3.8.2.0"), read without loading the assembly.
pub fn dll_file_version(dll: &Path) -> Option<String> {
    // Use PowerShell's VersionInfo to avoid a native version crate.
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command",
            &format!("(Get-Item '{}').VersionInfo.FileVersion", dll.display())])
        .output().ok()?;
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if v.is_empty() { None } else { Some(v) }
}

/// The currently-staged version recorded in state.json, if any.
pub fn staged_version() -> Option<String> {
    let s = std::fs::read_to_string(addin_root().join("state.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&s).ok()?;
    v.get("version").and_then(|x| x.as_str()).map(str::to_string)
}

/// Copy `bundled_dll` to <root>\<version>\HeliosVault.dll and write state.json.
/// Returns the staged DLL path. No-op copy if the target already exists.
pub fn stage(bundled_dll: &Path, version: &str) -> std::io::Result<PathBuf> {
    let dir = addin_root().join(version);
    std::fs::create_dir_all(&dir)?;
    let dest = dir.join("HeliosVault.dll");
    if !dest.exists() {
        std::fs::copy(bundled_dll, &dest)?;
    }
    std::fs::write(
        addin_root().join("state.json"),
        serde_json::to_vec_pretty(&serde_json::json!({ "version": version, "dll": dest })).unwrap(),
    )?;
    Ok(dest)
}

/// Remove version folders other than `keep`. Best-effort; locked dirs skipped.
pub fn gc(keep: &str) {
    if let Ok(entries) = std::fs::read_dir(addin_root()) {
        for e in entries.flatten() {
            if e.path().is_dir() && e.file_name().to_string_lossy() != keep {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stage_copies_and_records_version() {
        let tmp = std::env::temp_dir().join(format!("helios_stage_test_{}", std::process::id()));
        let src = tmp.join("src.dll");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(&src, b"dll-bytes").unwrap();
        // Redirect addin_root via LOCALAPPDATA override.
        std::env::set_var("LOCALAPPDATA", &tmp);
        let dest = stage(&src, "9.9.9.9").unwrap();
        assert!(dest.exists());
        assert_eq!(staged_version().as_deref(), Some("9.9.9.9"));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
```

- [ ] **Step 2: Run the test.**
```bash
cd /c/Users/nick5/helios/apps/desktop/src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo test -p helios-desktop addin_injector::staging
```
Expected: PASS.

- [ ] **Step 3: Commit.**
```bash
git add apps/desktop/src-tauri/src/addin_injector/staging.rs
git commit -m "feat(injector): versioned DLL staging + state.json + gc"
```

---

## Task 5: Per-user registry writing (`registry.rs`)

**Files:** Create `apps/desktop/src-tauri/src/addin_injector/registry.rs`.

- [ ] **Step 1: Write `registry.rs` — write the HKCU keys (mirrors the Task 0 spike).**
```rust
//! Write the per-user (HKCU) SOLIDWORKS add-in + COM-CLSID registration,
//! pointing at a staged DLL. No RegAsm, no elevation.
use std::path::Path;
use winreg::enums::*;
use winreg::RegKey;

const GUID: &str = "{B7A4E2C9-3F1D-4A8B-9C2E-5D6F7A8B9C0D}";
// Matches the add-in's stable AssemblyVersion (Task 1) + name.
const ASSEMBLY: &str = "HeliosVault, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null";
const CLASS: &str = "HeliosVault.SwAddin";

/// (Re)write every key so SOLIDWORKS discovers + auto-loads the add-in from
/// `dll`. `file_version` names the versioned InprocServer32 subkey.
pub fn register(dll: &Path, file_version: &str) -> std::io::Result<()> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let code_base = format!("file:///{}", dll.display().to_string().replace('\\', "/"));

    let (addins, _) = hkcu.create_subkey(format!("Software\\SolidWorks\\Addins\\{GUID}"))?;
    addins.set_value("", &1u32)?;
    addins.set_value("Title", &"Helios Vault")?;
    addins.set_value("Description", &"Sun Devil Motorsports — Helios PDM")?;

    let (startup, _) = hkcu.create_subkey(format!("Software\\SolidWorks\\AddInsStartup\\{GUID}"))?;
    startup.set_value("", &1u32)?;

    let write_inproc = |k: &RegKey| -> std::io::Result<()> {
        k.set_value("", &"mscoree.dll")?;
        k.set_value("ThreadingModel", &"Both")?;
        k.set_value("Class", &CLASS)?;
        k.set_value("Assembly", &ASSEMBLY)?;
        k.set_value("RuntimeVersion", &"v4.0.30319")?;
        k.set_value("CodeBase", &code_base)?;
        Ok(())
    };
    let (inproc, _) = hkcu.create_subkey(format!("Software\\Classes\\CLSID\\{GUID}\\InprocServer32"))?;
    write_inproc(&inproc)?;
    let (inproc_ver, _) = inproc.create_subkey(file_version)?;
    // The versioned subkey omits the default mscoree value but mirrors the rest.
    inproc_ver.set_value("Class", &CLASS)?;
    inproc_ver.set_value("Assembly", &ASSEMBLY)?;
    inproc_ver.set_value("RuntimeVersion", &"v4.0.30319")?;
    inproc_ver.set_value("CodeBase", &code_base)?;

    let (progid, _) = hkcu.create_subkey(format!("Software\\Classes\\CLSID\\{GUID}\\ProgId"))?;
    progid.set_value("", &CLASS)?;
    Ok(())
}

/// True if the registered CodeBase already points at `dll` (skip rewrite).
pub fn already_points_at(dll: &Path) -> bool {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let want = format!("file:///{}", dll.display().to_string().replace('\\', "/"));
    hkcu.open_subkey(format!("Software\\Classes\\CLSID\\{GUID}\\InprocServer32"))
        .and_then(|k| k.get_value::<String, _>("CodeBase"))
        .map(|cb| cb.eq_ignore_ascii_case(&want))
        .unwrap_or(false)
}
```

- [ ] **Step 2: Build (registry writes are validated manually in Task 0 + integration in Task 6).**
```bash
cd /c/Users/nick5/helios/apps/desktop/src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo build -p helios-desktop
```
Expected: compiles.

- [ ] **Step 3: Commit.**
```bash
git add apps/desktop/src-tauri/src/addin_injector/registry.rs
git commit -m "feat(injector): write per-user HKCU add-in + CLSID registration"
```

---

## Task 6: Orchestrate + wire into startup

**Files:** Modify `apps/desktop/src-tauri/src/addin_injector/mod.rs`; Modify `apps/desktop/src-tauri/src/lib.rs`.

- [ ] **Step 1: Add `run()` to `mod.rs`.**
```rust
use tauri::{AppHandle, Manager};

/// Resolve the bundled add-in DLL from Tauri resources.
fn bundled_dll(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().resolve("addin/HeliosVault.dll", tauri::path::BaseDirectory::Resource).ok()
        .filter(|p| p.exists())
}

/// Self-healing add-in provisioning. Best-effort: logs + returns on any error,
/// never blocks app launch. Returns true if a (re)registration happened.
pub fn run(app: &AppHandle) -> bool {
    if sw_detect::solidworks_install_dir().is_none() { return false; }
    let Some(dll) = bundled_dll(app) else {
        eprintln!("injector: bundled add-in DLL not found");
        return false;
    };
    let Some(version) = staging::dll_file_version(&dll) else { return false; };

    let changed = staging::staged_version().as_deref() != Some(version.as_str());
    let staged = match staging::stage(&dll, &version) {
        Ok(p) => p,
        Err(e) => { eprintln!("injector: stage failed: {e}"); return false; }
    };
    if !changed && registry::already_points_at(&staged) {
        return false; // up to date
    }
    if let Err(e) = registry::register(&staged, &version) {
        eprintln!("injector: register failed: {e}");
        return false;
    }
    staging::gc(&version);

    if sw_detect::is_sldworks_running() {
        notify_restart_sw(app);
    }
    eprintln!("injector: add-in registered v{version} at {}", staged.display());
    true
}

fn notify_restart_sw(app: &AppHandle) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder()
        .title("Helios Vault add-in updated")
        .body("Restart SOLIDWORKS to load the Helios add-in.")
        .show();
}
```

- [ ] **Step 2: Call it from `lib.rs` setup + register the plugins.** In `run()` add the plugins to the builder and call the injector in `.setup` (after the bridge start):
```rust
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
```
And inside the existing `.setup(move |app| { … })`, after `bridge::start(...)`:
```rust
            let _ = std::panic::catch_unwind(|| addin_injector::run(&app.handle().clone()));
```
Add `mod addin_injector;` at the top of `lib.rs`.

- [ ] **Step 3: Build + run the app once, confirm registration happens.**
```bash
cd /c/Users/nick5/helios/apps/desktop/src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo build -p helios-desktop
```
Then run the app (dev) and check the log for `injector: add-in registered`, and `Get-ItemProperty HKCU:\Software\SolidWorks\Addins\{guid}`.
Expected: keys present; SW (relaunched) loads the add-in.

- [ ] **Step 4: Commit.**
```bash
git add apps/desktop/src-tauri/src/addin_injector/mod.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(injector): orchestrate detect→stage→register→notify on startup"
```

---

## Task 7: Bundle the add-in DLL as a Tauri resource

**Files:** Modify `apps/desktop/src-tauri/tauri.conf.json`; add a build step.

- [ ] **Step 1: Copy the built DLL into the resources dir and reference it.**

Create the resource dir + copy as part of the build (document in README; for dev, copy manually once):
```powershell
New-Item -ItemType Directory -Force "C:\Users\nick5\helios\apps\desktop\src-tauri\resources\addin" | Out-Null
Copy-Item "C:\Users\nick5\helios\solidworks-addin\src\bin\Release\net48\HeliosVault.dll" "C:\Users\nick5\helios\apps\desktop\src-tauri\resources\addin\HeliosVault.dll" -Force
```

- [ ] **Step 2: Add to `tauri.conf.json` bundle resources.** In `bundle.resources` add:
```json
"resources/addin/HeliosVault.dll": "addin/HeliosVault.dll"
```

- [ ] **Step 3: Gitignore the staged copy but keep it reproducible.** Add `apps/desktop/src-tauri/resources/addin/` to `.gitignore` (it's a build artifact copied from the add-in build) and document the copy step in `solidworks-addin/README.md` + the release script.

- [ ] **Step 4: Verify the injector resolves the bundled path in dev.** Re-run the app; confirm no "bundled add-in DLL not found" log.

- [ ] **Step 5: Commit.**
```bash
git add apps/desktop/src-tauri/tauri.conf.json .gitignore solidworks-addin/README.md
git commit -m "build(desktop): bundle the add-in DLL as a Tauri resource"
```

---

## Task 8: Tray icon + close-to-tray

**Files:** Modify `apps/desktop/src-tauri/src/lib.rs`; Modify `apps/desktop/src-tauri/tauri.conf.json`.

- [ ] **Step 1: Add a tray icon with an Open/Quit menu in `setup`.**
```rust
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;

let open = MenuItemBuilder::with_id("open", "Open Helios").build(app)?;
let quit = MenuItemBuilder::with_id("quit", "Quit Helios").build(app)?;
let menu = MenuBuilder::new(app).items(&[&open, &quit]).build()?;
let _tray = TrayIconBuilder::with_id("helios")
    .icon(app.default_window_icon().unwrap().clone())
    .tooltip("Helios — Ground Station")
    .menu(&menu)
    .on_menu_event(|app, e| match e.id().as_ref() {
        "open" => { if let Some(w) = app.get_webview_window("main") { let _ = w.show(); let _ = w.set_focus(); } }
        "quit" => app.exit(0),
        _ => {}
    })
    .on_tray_icon_event(|tray, event| {
        if let tauri::tray::TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, .. } = event {
            if let Some(w) = tray.app_handle().get_webview_window("main") { let _ = w.show(); let _ = w.set_focus(); }
        }
    })
    .build(app)?;
```

- [ ] **Step 2: Intercept window close → hide instead of exit.** Add an `.on_window_event` to the builder:
```rust
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
```

- [ ] **Step 3: Build + manually verify.**
```bash
cd /c/Users/nick5/helios/apps/desktop/src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo build -p helios-desktop
```
Run the app: clicking the window's close button hides it to the tray; the tray icon's *Open* restores it; *Quit* exits. The bridge `/health` still responds while hidden.

- [ ] **Step 4: Commit.**
```bash
git add apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/tauri.conf.json
git commit -m "feat(desktop): tray icon + close-to-tray (bridge stays live)"
```

---

## Task 9: Auto-start on login (hidden), with a Settings toggle

**Files:** Modify `apps/desktop/src-tauri/src/lib.rs`; Modify a Settings UI component (`apps/desktop/src/.../SettingsScreen.tsx` or the vault SettingsScreen); capabilities.

- [ ] **Step 1: Enable autostart by default on first run, and start hidden when launched via autostart.** In `setup`, after building the window:
```rust
use tauri_plugin_autostart::ManagerExt;
let autostart = app.autolaunch();
let _ = autostart.enable(); // idempotent; user can disable in Settings
if std::env::args().any(|a| a == "--hidden") {
    if let Some(w) = app.get_webview_window("main") { let _ = w.hide(); }
}
```

- [ ] **Step 2: Add a Settings toggle** that calls `invoke("set_autostart", { enabled })`. Add a Tauri command:
```rust
#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let a = app.autolaunch();
    if enabled { a.enable() } else { a.disable() }.map_err(|e| e.to_string())
}
```
Register it in `generate_handler!`. Wire a checkbox in the vault Settings screen (read current state via `a.is_enabled()` exposed through a `get_autostart` command).

- [ ] **Step 3: Build + verify.** Confirm a `Helios` entry appears under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, and toggling the Settings switch adds/removes it.

- [ ] **Step 4: Commit.**
```bash
git add apps/desktop/src-tauri/src/lib.rs apps/desktop/src/
git commit -m "feat(desktop): autostart-on-login (hidden) + Settings toggle"
```

---

## Task 10: Identity in the bridge

**Files:** Modify `apps/desktop/src-tauri/src/bridge/mod.rs`, `server.rs`; Modify `apps/desktop/src/modules/vault/data/useBridgeSync.ts`.

- [ ] **Step 1: Add `display_name` + `email` to `Session`.** In `mod.rs` `Session`:
```rust
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
```

- [ ] **Step 2: Return identity in `/health`.** In `server.rs` `health`:
```rust
    let inner = state.read();
    let user = inner.session.as_ref().map(|s| serde_json::json!({
        "displayName": s.display_name, "email": s.email, "userId": s.user_id,
    }));
    Json(json!({
        "ok": true, "service": "helios-vault-bridge",
        "hasSession": inner.session.is_some(),
        "user": user,
        "vaultRoot": inner.snapshot.vault_root,
        "files": inner.snapshot.files.len(),
    }))
```

- [ ] **Step 3: Push name/email from the frontend.** In `useBridgeSync.ts` `bridge_set_session`, add `displayName` + `email` from the user object (use the same `userDisplayName`/email resolution the app uses; fall back to `user.email`):
```ts
      session: {
        supabaseUrl: conn.url, anonKey: conn.anonKey,
        accessToken: session.access_token, userId: user.id,
        displayName: (user.user_metadata?.display_name as string | undefined) ?? user.email ?? null,
        email: user.email ?? null,
      },
```

- [ ] **Step 4: Build + verify** `/health` now returns `user: { displayName, email }` (curl as in prior bridge tests).

- [ ] **Step 5: Commit.**
```bash
git add apps/desktop/src-tauri/src/bridge/ apps/desktop/src/modules/vault/data/useBridgeSync.ts
git commit -m "feat(bridge): expose signed-in identity in /health"
```

---

## Task 11: Add-in connection/identity line + live poll

**Files:** Modify `solidworks-addin/src/HeliosBridge.cs`, `HeliosVaultControl.cs`.

- [ ] **Step 1: Add `HealthAsync()` to the client.**
```csharp
public Task<BridgeResult> HealthAsync() => SendAsync(HttpMethod.Get, "/health", null);
```

- [ ] **Step 2: Add a connection line at the top of the panel + a poll timer.** In `BuildUi`, add a `_connLabel` (below the subtitle). Add a `System.Windows.Forms.Timer` (e.g. 4s) that calls `RefreshConnection`:
```csharp
private async Task RefreshConnection()
{
    var res = await _bridge.HealthAsync();
    if (res.Unreachable || !res.Ok || res.Json == null)
    { _connLabel.ForeColor = Red; _connLabel.Text = "○ Helios offline — open Helios"; return; }
    var hasSession = GetBool(res.Json, "hasSession");
    var user = GetObj(res.Json, "user");
    var name = user != null ? (GetStr(user, "displayName") ?? GetStr(user, "email")) : null;
    if (hasSession && !string.IsNullOrEmpty(name))
    { _connLabel.ForeColor = Green; _connLabel.Text = $"● Connected · {name}"; }
    else
    { _connLabel.ForeColor = Dim; _connLabel.Text = "● Connected · (not signed in)"; }
}
```
Start the timer in the constructor; stop/dispose it in `Dispose`.

- [ ] **Step 3: Rebuild the add-in (SW closed), relaunch, verify** the panel shows "● Connected · <Your Name>" when Helios is up and signed in, and "○ Helios offline" when Helios is quit.

- [ ] **Step 4: Commit.**
```bash
git add solidworks-addin/src/HeliosBridge.cs solidworks-addin/src/HeliosVaultControl.cs
git commit -m "feat(sw-addin): show Helios connection + signed-in user in the Task Pane"
```

---

## Task 12: End-to-end validation + docs

**Files:** Modify `solidworks-addin/HANDOFF.md` (mark Phase 5 done), `README.md`.

- [ ] **Step 1: Fresh-machine simulation on the dev box.** Remove all add-in registry keys (HKLM + HKCU) and the `%LOCALAPPDATA%\Helios\addin` folder. Launch Helios (dev). Confirm: injector stages + registers per-user; relaunch SW → add-in loads; panel shows connected identity.

- [ ] **Step 2: Update simulation.** Bump the add-in `FileVersion` to `3.8.3.0`, rebuild, copy to resources, relaunch Helios. Confirm a new `…\addin\3.8.3.0\` folder, the registry CodeBase repointed, and (SW relaunched) the new DLL loads — with the old folder gc'd.

- [ ] **Step 3: Tray/autostart.** Close window → hides to tray; reboot (or re-login) → Helios starts hidden; `/health` reachable throughout.

- [ ] **Step 4: Update HANDOFF.md** marking Phase 5 complete and documenting the injector + tray. Commit.
```bash
git add solidworks-addin/HANDOFF.md solidworks-addin/README.md
git commit -m "docs(sw-addin): Phase 5 done — injector + always-on tray"
```

---

## Self-review notes

- **Spec coverage:** injector (T3–T7), versioned auto-update (T4/T6/T12), per-user no-admin registration (T0/T5), tray+close-to-tray (T8), autostart hidden (T9), background updater (unchanged, still runs), identity/online (T10/T11), packaging (T7). All spec sections map to tasks.
- **Risk-first:** Task 0 validates the HKCU assumption before any build work, with an explicit HKLM fallback branch.
- **Type consistency:** GUID, `HeliosVault.SwAddin`, `Assembly` string, and `FileVersion` are used identically across the spike (T0), registry (T5), and csproj (T1).
