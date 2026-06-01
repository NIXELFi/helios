# Helios SOLIDWORKS add-in — what's next

Pick-up notes for the next session (on the **Windows + SOLIDWORKS box**). Branch:
**`feat/sw-addin`** (all work is committed + pushed). Context: `HANDOFF.md`
(architecture + phase status), `README.md` (build/register/ship), and the Phase 5
design + plan under `../docs/superpowers/`.

**Current state in one line:** Phases 1–3 are done and live-verified (the add-in
does check-in/out, get-latest, versions, lock status, Add-to-Vault, assembly
component status, and shows a Connected·<user> line). Phase 5 (injector + tray) is
**implemented and compiling but not yet validated against SOLIDWORKS**. Phase 4
(edit-enforcement) is **not built**.

---

## 1. Validate Phase 5 — the injector + tray (do this first, ~5–10 min)

This is the only thing gating "the add-in installs itself with zero manual steps."
It needs the user **at the machine** for one UAC + a couple of visual checks.

### 1a. The HKCU question — RESOLVED

The spike's premise was wrong: **SOLIDWORKS discovers add-ins ONLY via
`HKLM\SOFTWARE\SolidWorks\AddIns\{guid}`** — there is no HKCU discovery. The
injector originally wrote the *list* entry to HKCU, so SW never saw it (it loaded
on the dev box only because an old elevated RegAsm registration left an HKLM entry
behind). Two fixes landed:

- **Self-contained DLL** (commit `09b179d`): `EmbedInteropTypes=true`, so the
  staged DLL has no external `SolidWorks.Interop.*` dependency and loads from the
  staged folder, on any SW version/edition.
- **HKLM list entry via one-time elevation** (`registry.rs::register_hklm_list_elevated`,
  driven from `mod.rs::run` / `provision_now`): the CLSID + AddInsStartup stay
  per-user (no admin); the HKLM discovery entry is written via a single UAC,
  skipped once present, retryable from **Settings → "Install / repair SOLIDWORKS
  add-in"** if declined.

So validation 1a is now just: launch Helios on a clean machine → approve the one
UAC → SW loads "Helios Vault". The manual confirm below (1b) covers it.

### 1b. Live injector + tray pass

The injector reads the **bundled** DLL from Tauri resources, so it needs the DLL
staged. Either do a real bundle (`cd apps/desktop && pnpm build:win`) and run the
installed app, **or** for a quick dev check, copy the DLL to where the dev build
resolves resources and run `pnpm dev`.

Confirm:
- On Helios launch, the staged `…\Helios\addin\<version>\HeliosVault.dll` exists,
  the per-user CLSID is written, and (after approving the one UAC)
  `HKLM\SOFTWARE\SolidWorks\AddIns\{guid}` exists (Helios log:
  `injector: HKLM discovery entry installed`). If you declined, use Settings →
  "Install / repair SOLIDWORKS add-in".
- Relaunch SOLIDWORKS → the add-in loads from the staged DLL; the Task Pane shows
  **"● Connected · \<you\>"**.
- **Tray:** closing the Helios window hides it to the tray (bridge `/health` still
  responds); the tray *Open* restores it; *Quit* exits.
- **Autostart:** an entry appears under
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`; after reboot/re-login
  Helios starts hidden in the tray. The **Settings → "Startup & SOLIDWORKS"**
  toggle turns it off/on.
- **Auto-update:** bump the add-in `FileVersion` in `src/HeliosVault.csproj`, run
  `pnpm build:addin`, relaunch Helios → a new `…\addin\<newver>\` folder appears,
  the registry CodeBase repoints, old folder is gc'd, and (SW relaunched) the new
  DLL loads.

When this passes, mark **Phase 5 DONE** in `HANDOFF.md` and the plan checkboxes.

---

## 2. Phase 4 — edit-enforcement (the remaining real feature, not built)

Goal (from `HANDOFF.md`): you can't change a file in SOLIDWORKS unless you've
checked it out. The *server* already refuses a check-in without the lock; this
closes the in-SW gap.

Approach (next brainstorm/spec, then implement):
- In the C# add-in, subscribe to SOLIDWORKS document events on `ConnectToSW`:
  - `DocumentLoadNotify2` / active-doc change → refresh status (also removes the
    current "hit Refresh manually" friction).
  - **`FileSaveNotify` / save-pre-notify** → if the active doc is a tracked vault
    file **not** checked out by the current user, block the save (or prompt
    "Check out first?") via the notify return value.
- Use the existing bridge `/status?path=` to know tracked + lock state; offer an
  inline "Check Out" so the user can proceed.
- Decide policy: hard-block vs. warn-and-allow; how to treat untracked files and
  read-only working copies (the vault already freezes non-checked-out files
  read-only, which is a softer enforcement already in place).

This is a feature-sized chunk — run it through brainstorming → spec → plan like
Phase 5.

---

## 3. Smaller follow-ups (nice-to-have)

- **Cross-SOLIDWORKS-version interops:** the add-in is built against SW2025
  interops. If teammates run other SW versions, validate binding / build against
  the lowest common version.
- **Get-Latest while a file is open in SW** fails (can't overwrite an open file) —
  surface a clearer "close the file first" hint, or close+reopen via the SW API.
- **Check-in version freshness** is optimistic in the bridge; the snapshot
  catches up on its interval — fine, but worth a glance during Phase 4 work.

---

## Quick reference

- Add-in code: `solidworks-addin/src/` — `SwAddin.cs`, `HeliosVaultControl.cs`,
  `HeliosBridge.cs`. Build: `dotnet build -c Release` (close SW first; the DLL
  stays loaded in SW's AppDomain until the process exits).
- Bridge: `apps/desktop/src-tauri/src/bridge/`. Injector:
  `apps/desktop/src-tauri/src/addin_injector/`. Frontend handoff:
  `apps/desktop/src/modules/vault/data/useBridgeSync.ts` +
  `modules/vault/BridgeOpHandler.tsx`, mounted in `src/Shell.tsx`.
- Run Helios locally: `cd apps/desktop && pnpm dev` (hot-reloads; src-tauri edits
  trigger a Rust rebuild + relaunch). cargo/pnpm aren't on PATH by default —
  prepend `%USERPROFILE%\.cargo\bin` and use `%LOCALAPPDATA%\npm-global\pnpm.cmd`.
- Discovery file the add-in reads: `%LOCALAPPDATA%\Helios\bridge.json`
  (`{port, token}`, rotates per Helios launch).
