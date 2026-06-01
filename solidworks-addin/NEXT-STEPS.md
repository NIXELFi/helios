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

### 1a. The HKCU spike (the one risk)

The whole no-admin design assumes SOLIDWORKS 2025 will load an add-in registered
**entirely under HKCU**. Prove it:

1. Close SOLIDWORKS.
2. **(needs one UAC)** Remove the old machine-wide registration so the test is
   isolated:
   ```powershell
   $g="{B7A4E2C9-3F1D-4A8B-9C2E-5D6F7A8B9C0D}"
   reg delete "HKLM\SOFTWARE\SolidWorks\Addins\$g" /f
   reg delete "HKLM\SOFTWARE\Classes\CLSID\$g" /f
   ```
   (Run from an elevated prompt.)
3. Write the HKCU-only keys — use the script in the plan, **Task 0 / Step 2**
   (`../docs/superpowers/plans/2026-06-01-helios-addin-injector-tray.md`), pointing
   at `src/bin/Release/net48/HeliosVault.dll`. No admin needed.
4. Launch SOLIDWORKS → **Tools → Add-Ins**.
   - **Loads + ticked** → the no-admin design holds. Done; continue to 1b.
   - **Not listed** → SW needs the *Addins list* entry in HKLM. Fallback: in
     `src-tauri/src/addin_injector/registry.rs`, move only the
     `Software\SolidWorks\Addins\{guid}` write to a one-time elevated step (single
     UAC on first run); keep the CLSID + AddInsStartup under HKCU. Then re-test.

### 1b. Live injector + tray pass

The injector reads the **bundled** DLL from Tauri resources, so it needs the DLL
staged. Either do a real bundle (`cd apps/desktop && pnpm build:win`) and run the
installed app, **or** for a quick dev check, copy the DLL to where the dev build
resolves resources and run `pnpm dev`.

Confirm:
- On Helios launch, `%LOCALAPPDATA%\Helios\addin\<version>\HeliosVault.dll` exists
  and `HKCU\Software\SolidWorks\Addins\{guid}` is written (check the Helios log for
  `injector: add-in registered …`).
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
