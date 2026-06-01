# Helios add-in injector + always-on tray — design

Date: 2026-06-01 · Branch: `feat/sw-addin`

## Goal

Make the SOLIDWORKS add-in zero-touch for the whole team. A teammate installs
Helios on a Windows box with SOLIDWORKS and, with **no manual steps and no admin
prompt**, the add-in is installed, kept up to date, and connected to a Helios
that runs minimized in the tray. The add-in visibly shows who is signed in and
whether Helios is online.

This is Phase 5 from `solidworks-addin/HANDOFF.md`.

## Non-goals

- No MSI/MSIX or HKLM machine-wide install. Per-user only.
- No forcing a *running* SOLIDWORKS to load a freshly-registered add-in (not
  possible via the SW API) — we register so it auto-loads on the next SW launch
  and notify the user.
- No mixed-SOLIDWORKS-version matrix work in v1 (see Risks).

## Architecture — four parts

### 1. Injector (`src-tauri`, runs on every Helios launch)

A new Rust module (`src-tauri/src/addin_injector/`) that self-heals the add-in
registration on startup. Best-effort: any failure logs and never blocks app
launch, and it no-ops cleanly when SOLIDWORKS isn't installed.

Steps each launch:

1. **Detect SOLIDWORKS** from the registry (`HKLM\SOFTWARE\SolidWorks\SOLIDWORKS
   <year>\Setup\SolidWorks Folder`, falling back to scanning `SOFTWARE\SolidWorks`
   subkeys). No SW → no-op.
2. **Compare versions.** The bundled add-in DLL is version-stamped (its
   `AssemblyFileVersion`, tied to the Helios release). Compare against the
   currently-staged/registered version recorded in
   `%LOCALAPPDATA%\Helios\addin\state.json`.
3. **Stage on change.** If the bundled version is newer (or nothing is staged),
   copy the DLL to a **version-specific folder**
   `%LOCALAPPDATA%\Helios\addin\<version>\HeliosVault.dll`. Versioned folders mean
   a new DLL never overwrites one a running SOLIDWORKS still has loaded (no
   file-lock failure). The old version loads until SW restarts; the new path is
   registered for the next launch.
4. **Register per-user (no admin), writing the keys directly from Rust** — no
   RegAsm, no `[ComRegisterFunction]`, no elevation:
   - `HKCU\Software\SolidWorks\Addins\{B7A4E2C9-…}` → default DWORD `1`, `Title`
     = "Helios Vault", `Description`.
   - `HKCU\Software\SolidWorks\AddInsStartup\{guid}` → default DWORD `1`.
   - `HKCU\Software\Classes\CLSID\{guid}\InprocServer32` → `(default)` =
     `mscoree.dll`, plus `Class` = `HeliosVault.SwAddin`, `Assembly`,
     `RuntimeVersion` = `v4.0.30319`, `ThreadingModel` = `Both`, `CodeBase` =
     `file:///…\<version>\HeliosVault.dll`; and a versioned `InprocServer32\<ver>`
     subkey mirroring it (managed-COM shape RegAsm produces).
   - `HKCU\Software\Classes\CLSID\{guid}\ProgId` → `HeliosVault.SwAddin`.
   - Record the staged version + path in `state.json`.
5. **Notify if SW is running.** If `SLDWORKS.exe` is running and the add-in
   version just changed (or was newly installed), post an OS/tray notification:
   "Restart SOLIDWORKS to load the Helios add-in."
6. **Garbage-collect** old `%LOCALAPPDATA%\Helios\addin\<version>\` folders except
   the currently-registered one (best-effort; locked ones are skipped and retried
   next launch).

Auto-update flow end to end: edit the add-in → bump its version → it ships in the
next Helios release → Tauri updater installs Helios → injector stages the new
versioned DLL and repoints `CodeBase` → SOLIDWORKS loads it on its next launch.

### 2. Tray / always-on / background

- **Tray icon** (Helios icon) with tooltip reflecting connection state and a menu:
  *Open Helios* / *Quit Helios*. Left-click restores/focuses the window.
- **Close → hide to tray.** Intercept the window close request and hide instead
  of exit; a true quit happens only from the tray menu. The localhost bridge keeps
  running while hidden, so the add-in stays connected.
- **Auto-start on login** via `tauri-plugin-autostart` (per-user registry Run
  key), with a Settings toggle to disable. First launch from autostart starts
  **hidden** (straight to tray).
- The existing Tauri **updater** keeps checking/installing in the background while
  tray-resident.

### 3. Identity / online-status propagation

- The frontend pushes `displayName` + `email` alongside the session in
  `bridge_set_session` (already sends `userId`).
- Bridge extends the existing `/health` response with the signed-in identity →
  `{ ok, hasSession, user: { displayName, email } | null, … }` (no new endpoint).
  The add-in already reads `/health`.
- The Task Pane shows a header connection line:
  - **"● Connected · &lt;Name&gt;"** (green) when the bridge + a session are live.
  - **"○ Helios offline — open Helios"** (dim/red) when the bridge is unreachable
    or there's no session.
  - Polled (e.g. every few seconds) so it stays live without user action.

### 4. Packaging / build pipeline

- The Helios installer bundles **only `HeliosVault.dll`** as a Tauri resource (the
  SW interop dependencies are resolved at runtime from the user's own SOLIDWORKS
  install — do not bundle version-specific interops).
- Build order: `dotnet build -c Release` (add-in) → copy the DLL into the Tauri
  resources dir → `tauri build`. Wire this into the release script so the bundled
  DLL is always current with the Helios version.
- The add-in's `[ComRegisterFunction]` hooks stay for **dev** convenience (manual
  `regasm` during development) but are unused by the shipped per-user injector.

## Error handling

- SW not installed / registry unreadable → injector no-ops, logs, app continues.
- Registry write denied → log + surface a one-line status; never crash.
- Staged DLL copy fails because the target version folder is locked → that
  version is already staged/loaded; skip. New versions always go to a fresh
  folder, so this is benign.
- Bridge offline (Helios quit) → add-in shows "Helios offline"; tray relaunch
  restores it.

## Testing

- Unit: version compare, registry-key construction (against a sandbox HKCU path),
  SW-detection parsing, garbage-collection selection.
- Manual on the dev box: fresh-register (no prior keys) → SW loads it; bump
  version → injector repoints, SW loads new on relaunch; quit Helios → add-in
  shows offline; autostart hidden-to-tray; identity line shows the signed-in user.

## Risks / to validate first

- **HKCU add-in loading (highest risk).** Confirm SOLIDWORKS 2025 actually loads
  an add-in registered entirely under `HKCU` (Addins list + per-user CLSID). If SW
  requires the Addins entry in HKLM, fall back to a **one-time elevated**
  registration (a single UAC at first run) while keeping CLSID per-user. Validate
  this before building the rest.
- **Cross-SW-version interop binding.** The DLL is built against SW2025 interops;
  assumes the team is on SW2025+. Mixed-version handling is a follow-up.
- **Notification channel.** Use the tray/OS notification API available to Tauri;
  confirm it works while the window is hidden.
