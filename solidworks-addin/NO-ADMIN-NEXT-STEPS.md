# SOLIDWORKS add-in — no-admin blocker & next steps

## TL;DR

The HKLM injector fix (commit `1ee5209`) is correct, but it cannot complete on a
machine where the user lacks admin rights. SOLIDWORKS discovers add-ins **only**
from `HKLM\SOFTWARE\SolidWorks\AddIns\{guid}`, and that key is writable only by
Administrators here. There is **no per-user (HKCU) add-in discovery** in
SOLIDWORKS, so a standard user cannot self-register an in-process add-in. We must
either get a one-time admin authorization, or switch to an out-of-process design.

## What we verified on this machine (2026-06-01)

- User: `foresighttech\nmurray`, **not** elevated, **not** in Administrators.
- ACL on `HKLM\SOFTWARE\SolidWorks\AddIns`: write granted only to
  `BUILTIN\Administrators`, `NT AUTHORITY\SYSTEM`, `CREATOR OWNER`.
- Non-elevated write of our list entry → **Access denied**.
- The injector's per-user steps DO succeed without admin:
  - `HKCU\Software\Classes\CLSID\{B7A4E2C9-…}\InprocServer32` (mscoree shim) ✅
  - `HKCU\Software\SolidWorks\AddInsStartup\{B7A4E2C9-…}` = 1 ✅
- The elevated `reg import` UAC fired and was declined → logged
  `HKLM provisioning skipped … retry from Settings`, and `state.json`
  `hklmAttempted=true` (so it won't auto-prompt again; Settings retry still works).
- Two SOLIDWORKS versions installed (2023 + 2025); the self-contained DLL
  (`EmbedInteropTypes=true`, commit `09b179d`) is version-agnostic and would load
  in both once discovery is in place.

## Why there's no pure-code bypass

- SOLIDWORKS enumerates only the HKLM AddIns key for discovery — confirmed
  empirically (our HKCU `Addins` entry was ignored).
- The HKLM ACL is admin-only on this machine; `CREATOR OWNER` doesn't help
  because creating the subkey first requires `CreateSubKey` on the parent, which
  standard users don't have.
- No 32/64-bit view trick: SW is 64-bit and reads the native HKLM view.

## Options (pick a direction)

### Option A — one-time admin authorization (keeps the in-SW task pane)
The logged-in user need not be an admin. On a standard account the UAC prompt is
a **credential** prompt — an admin (IT, over-the-shoulder or remote) types their
password once via **Settings ▸ Install / repair SOLIDWORKS add-in**
(`provision_now` → `register_hklm_list_elevated`). After that the HKLM entry
persists and the per-user pieces self-maintain on every launch.

- Pros: full add-in UX (docked task pane, toolbar/menu), minimal new code (already
  built in `1ee5209`).
- Cons: needs one admin touch per machine; blocked entirely if no admin is ever
  available.
- Optional polish: have IT push the HKLM entry once via GPO/SCCM/login script, or
  ship a tiny signed `.reg` they can apply. Then the app only manages per-user.

### Option B — out-of-process COM automation (never needs admin)
Drop the in-process `ISwAddin` add-in. SOLIDWORKS's own COM server is registered
machine-wide by its installer, so Helios can attach to a **running** SW instance
out-of-process — `Marshal.GetActiveObject("SldWorks.Application")` (or
`CreateObject` to launch) — and perform all vault operations the task-pane control
does today.

- Reuse the existing logic from `solidworks-addin/src/SwAddin.cs` /
  `HeliosVaultControl.cs`: `GetActivePath` (`IActiveDoc2.GetPathName`),
  `GetActiveComponentPaths` (assembly `GetComponents`), `SaveActiveDoc`
  (`Save3`), plus the bridge check-in/out / get-latest already wired in.
- Host it where it fits the architecture: a small sidecar process the Helios
  desktop app launches, or fold it into the bridge. UI moves into the Helios
  window (no docked SW panel; no in-SW toolbar/menu).
- Pros: zero registration, zero admin, unblocks a standard user solo; works
  across SW 2023 + 2025.
- Cons: no in-SW docked panel / ribbon buttons; needs a COM-interop host process
  (.NET) or equivalent; must handle "SW not running" and ROT attach/retry.
- Risks to spike first: confirm `GetActiveObject("SldWorks.Application")` attaches
  to the running instance under this user; confirm event/callback needs (live
  document-change tracking) are satisfiable out-of-process or acceptably polled.

## Recommended next step

Spike Option B feasibility (attach to the running SW via `GetActiveObject` and
read the active doc path) — it's the only path that unblocks a no-admin user
without external help. Keep Option A as the path for machines where IT can
authorize once and the in-SW panel is wanted. Decide based on whether IT can do a
one-time per-machine authorization at the deployment scale you need.

## Pointers

- Injector: `apps/desktop/src-tauri/src/addin_injector/{mod,registry,staging}.rs`
- Elevation entry: `registry::register_hklm_list_elevated` + `provision_now`
- Settings retry button: `apps/desktop/src/modules/vault/screens/SettingsScreen.tsx`
- Add-in source to reuse for Option B: `solidworks-addin/src/SwAddin.cs`,
  `HeliosVaultControl.cs`, `HeliosBridge.cs`
- GUID `{B7A4E2C9-3F1D-4A8B-9C2E-5D6F7A8B9C0D}`, class `HeliosVault.SwAddin`
