# Task: Fix the Helios SOLIDWORKS add-in injector so the add-in actually loads

## Context

- **Repo:** `C:\Users\nmurray\Documents\Helios` (Rust + Tauri desktop app, pnpm/turbo workspace).
- **Branch:** `feat/vault-sw-integration` (integration of `feat/sw-addin`, `feat/vault-perf-3.8.2`, `feat/always-on-vault-sync`). The add-in work lives on `feat/sw-addin`.
- **Feature:** On every Helios launch, a Rust "injector" provisions a SOLIDWORKS COM add-in ("Helios Vault") with no RegAsm and (by design) no elevation. It stages a bundled, version-stamped `HeliosVault.dll` into a per-version folder and writes the registry keys so SOLIDWORKS auto-loads it.
- **Add-in identity:** GUID `{B7A4E2C9-3F1D-4A8B-9C2E-5D6F7A8B9C0D}`, COM class `HeliosVault.SwAddin`, ProgId `HeliosVault.SwAddin`.

## Symptom

The injector logs `injector: add-in registered v3.8.2.0 ...` successfully, but **"Helios Vault" never appears in SOLIDWORKS** (not in Tools ▸ Add-Ins, no task pane) — on either installed version (SOLIDWORKS 2023 and 2025 are both on this machine).

## Root cause (already diagnosed — verified against the live registry)

The injector writes the add-in **list entry to the wrong registry hive.**

- SOLIDWORKS discovers add-ins **only** by enumerating `HKLM\SOFTWARE\SolidWorks\AddIns\{GUID}`.
- The Rust injector writes that list entry to **`HKCU\Software\SolidWorks\Addins\{GUID}`** instead — see `apps/desktop/src-tauri/src/addin_injector/registry.rs`, the `register()` fn (the `create_subkey("Software\\SolidWorks\\Addins\\{GUID}")` call on `HKEY_CURRENT_USER`).
- There is **no per-user (HKCU) add-in discovery** in SOLIDWORKS. HKCU only holds the per-user enable flag at `HKCU\Software\SolidWorks\AddInsStartup\{GUID}`.
- Therefore SOLIDWORKS never sees the add-in in its list and never activates the (otherwise correct) CLSID.

Evidence gathered on this machine:
- `HKLM\SOFTWARE\SolidWorks\AddIns\{B7A4E2C9-…}` → **does NOT exist** (this is where SW looks).
- `HKCU\Software\SolidWorks\Addins\{B7A4E2C9-…}` → **exists** (where the injector wrongly put it; SW ignores it).
- All 9 working add-ins on the machine (SOLIDWORKS PDM, Composer, 3Dconnexion, Mastercam, etc.) have their list entry in `HKLM\SOFTWARE\SolidWorks\AddIns`, with their CLSID in `HKLM\SOFTWARE\Classes\CLSID`.
- The add-in's OWN C# registration (`solidworks-addin/src/SwAddin.cs`, `[ComRegisterFunction] RegisterFunction`) already does it correctly via `Registry.LocalMachine` → HKLM. The Rust port reimplemented this step under HKCU. The risk was even called out in a comment at the top of `registry.rs`.

## What is already correct (do NOT change)

- The per-user **CLSID** at `HKCU\Software\Classes\CLSID\{GUID}\InprocServer32` is correct: `(default)=mscoree.dll`, `ThreadingModel=Both`, `Class=HeliosVault.SwAddin`, `Assembly=HeliosVault, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null`, `RuntimeVersion=v4.0.30319`, `CodeBase=file:///…/HeliosVault.dll`. Per-user COM resolves fine via the HKCR merge as long as SOLIDWORKS runs non-elevated as the same user. This can stay no-admin.
- The per-user enable flag `HKCU\Software\SolidWorks\AddInsStartup\{GUID}=1` (DWORD) is correct.
- The staged DLL is valid: 33,280-byte self-contained .NET assembly (interop types embedded via `EmbedInteropTypes=true`, commit `09b179d`), valid PE (`MZ`) header, `mscoree.dll` present.
- The DLL stages under `%TEMP%\Helios\addin\<version>\HeliosVault.dll` (NOT `%LOCALAPPDATA%`) because `LOCALAPPDATA` isn't set in the dev-spawned process env; `addin_root()` falls back to `temp_dir()`. This is cosmetic, not the bug.

## The fix

Move the add-in **list entry** write from HKCU to **HKLM** (`HKLM\SOFTWARE\SolidWorks\AddIns\{GUID}`), keeping:
- `(default)` = DWORD (use `1` to match the reference add-ins, or `0` + rely on the HKCU AddInsStartup flag — either loads since AddInsStartup=1),
- `Title` = `"Helios Vault"`,
- `Description` = `"Sun Devil Motorsports — Helios PDM"`.

Leave `AddInsStartup\{GUID}` in HKCU and leave the CLSID per-user in HKCU.

### Key constraint: HKLM needs elevation

`HKLM\SOFTWARE\SolidWorks\AddIns` is not user-writable, so the no-admin premise cannot hold for the list entry. Pick and implement one:

1. **One-time elevated provisioning step** — on first launch (or from Settings), spawn an elevated helper (UAC prompt) that writes just the HKLM list entry. The CLSID + AddInsStartup stay per-user/no-admin. (This is what the `registry.rs` comment proposed: only `register_addins_list` moves to an elevated step.)
2. **Elevated installer step** — write the HKLM list entry during install (NSIS already runs elevated), and have the runtime injector only manage the per-user CLSID + staging + AddInsStartup.

Prefer option 1 if the app must self-provision without a reinstall; option 2 if an installer pass is acceptable. Detect whether the HKLM entry already exists and skip re-prompting (don't UAC every launch).

### Files to touch

- `apps/desktop/src-tauri/src/addin_injector/registry.rs` — the `register()` and `already_points_at()` logic; split the HKLM list write from the per-user writes.
- `apps/desktop/src-tauri/src/addin_injector/mod.rs` — orchestration / detecting whether elevation is needed.
- Possibly a small elevated helper (or `runas`/ShellExecute "runas" verb) and NSIS config if going the installer route.
- Update `solidworks-addin/README.md` / `NEXT-STEPS.md` to reflect that the list entry is HKLM + elevation.

## Verification

1. **Isolate the DLL first (manual, no code):** in an **elevated** PowerShell, add only the HKLM list entry, then restart SOLIDWORKS:
   ```powershell
   $guid = '{B7A4E2C9-3F1D-4A8B-9C2E-5D6F7A8B9C0D}'
   New-Item -Path "HKLM:\SOFTWARE\SolidWorks\AddIns\$guid" -Force | Out-Null
   Set-ItemProperty "HKLM:\SOFTWARE\SolidWorks\AddIns\$guid" -Name '(default)'  -Value 1 -Type DWord
   Set-ItemProperty "HKLM:\SOFTWARE\SolidWorks\AddIns\$guid" -Name 'Title'       -Value 'Helios Vault'
   Set-ItemProperty "HKLM:\SOFTWARE\SolidWorks\AddIns\$guid" -Name 'Description' -Value 'Sun Devil Motorsports — Helios PDM'
   ```
   The HKCU AddInsStartup flag and per-user CLSID are already present, so this list entry is the only missing piece. If "Helios Vault" now loads, the DLL is good and the only real change is the hive in `registry.rs` + elevation handling.
2. After the code change: clear the stale staged folder (`Remove-Item "$env:TEMP\Helios\addin" -Recurse -Force`), relaunch `pnpm dev` from the repo root, restart SOLIDWORKS, confirm the add-in loads and the task pane shows the active document.
3. Confirm it loads in **both** SOLIDWORKS 2023 and 2025 (the embedded interop types are version-agnostic, so one DLL should cover both).

## Notes / gotchas

- Don't bump the DLL FileVersion expecting a re-stage; `staging::stage()` only copies when the dest path doesn't exist, and `staged_version()` short-circuits when the version matches. To force a fresh stage during testing, delete `%TEMP%\Helios\addin\`.
- SOLIDWORKS must be fully restarted to pick up add-in registry changes.
- Tangential: there's a harmless Tailwind warning (`content` glob matching `node_modules`) and an unused `std::path::PathBuf` import in `apps/desktop/src-tauri/src/commands/restart.rs:50` — not related to this bug.
