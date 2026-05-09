# Helios Vault — Plan 7: `pdm-shell-ext` (Windows Shell Extension)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Native Windows Explorer integration for the Vault folder. Files inside `%LOCALAPPDATA%\Helios\Vault\working\` show overlay icons reflecting their state (latest / out-of-date / locked-by-me / locked-by-other) and offer a right-click context menu (Check Out, Check In, Cancel Check-Out, Get Latest, View History).

**Architecture:** A Rust DLL (`pdm-shell-ext.dll`) implementing two Windows shell COM interfaces:
- `IShellIconOverlayIdentifier` — provides overlay icons.
- `IExplorerCommand` — provides the right-click context menu items.

Both interfaces delegate every decision to `pdm-sync-daemon` via IPC. The shell extension is intentionally inert: no I/O, no parsing, no Supabase calls. Crashes here would freeze `explorer.exe`, so robustness > features.

**Tech Stack:** Rust 2021, `windows-rs` (COM bindings), `pdm-core` (Plan 2), MSI / NSIS installer registers the DLL via `regsvr32`.

**Spec:** [`docs/superpowers/specs/2026-05-07-helios-vault-design.md`](../specs/2026-05-07-helios-vault-design.md)
**Roadmap:** [`docs/superpowers/plans/2026-05-07-helios-vault-roadmap.md`](2026-05-07-helios-vault-roadmap.md)
**Depends on:** Plan 6 (sync daemon must respond to `GetOverlayState` and context-menu IPC).
**Build target:** Windows only.

---

## File Structure

### New crate

```
apps/pdm-shell-ext/
  Cargo.toml
  build.rs                          ← embed icon resources, link to ole32 etc.
  resources/
    overlay-latest.ico
    overlay-outdated.ico
    overlay-locked-me.ico
    overlay-locked-other.ico
    pdm-shell-ext.rc                ← Windows resource script
  src/
    lib.rs                          ← DllMain / DllGetClassObject / DllRegisterServer
    factory.rs                      ← IClassFactory implementation
    overlay.rs                      ← IShellIconOverlayIdentifier impl (4 classes — one per state)
    command.rs                      ← IExplorerCommand impl (one per menu item)
    ipc_client.rs                   ← thin named-pipe client
    register.rs                     ← regsvr32-driven HKCU/HKLM key writes
  tests/
    ipc_client.rs                   ← unit tests for the named-pipe client
    overlay_state_decoder.rs        ← unit tests for state-decoding helpers
```

### Build constraints

- Compile target: `x86_64-pc-windows-msvc` only.
- Crate type: `cdylib` (produces a DLL).
- The `windows` crate is heavy; gate behind `#[cfg(target_os = "windows")]` so non-Windows builds skip cleanly.

---

## Task overview

1. **Scaffold crate** with `cdylib` + minimal `lib.rs` exporting `DllMain`. Build on Windows.
2. **`ipc_client.rs`** — connect to `\\.\pipe\helios-pdm`, send a request, read a response. TDD with mock pipe (the real pipe is only available when the daemon is running).
3. **Overlay state cache** — in-process LRU keyed by file path, invalidated by daemon push notifications. TDD purely on the data structure.
4. **`IShellIconOverlayIdentifier` impl** — four COM classes (one per state). Each `IsMemberOf(path)` calls the daemon's `GetOverlayState(path)` IPC and returns `S_OK` if the state matches.
5. **Context menu — `IExplorerCommand` impl** — one class per menu item (Check Out, Check In, Cancel, Get Latest, View History). `GetState(path)` decides whether to show / hide / disable each item; `Invoke(path)` calls the corresponding daemon IPC method.
6. **`DllRegisterServer` / `DllUnregisterServer`** — write registry keys under `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\ShellIconOverlayIdentifiers\`, the file-class CLSIDs for SolidWorks file types (`.sldprt`, `.sldasm`, `.slddrw`), and the COM class registrations.
7. **Build with embedded resources** — `build.rs` runs `embed-resource` to compile the `.rc` into the DLL.
8. **Manual install/test on Windows** — `regsvr32 pdm-shell-ext.dll`, browse the local Vault folder in Explorer, verify icons + context menu.
9. **Plan-completion review.**

---

## Conventions

- **Every COM method is wrapped in `catch_unwind`** so panics never reach `explorer.exe`. Failure → log to `%LOCALAPPDATA%\Helios\Vault\shell-ext.log` and return a benign HRESULT.
- **IPC timeout: 1 second.** Slow daemon → neutral icon, "daemon not running" menu fallback.
- **No allocations on the hot path.** Overlay-icon `IsMemberOf` is called for every file rendered in Explorer — keep it fast (single IPC call, cached in-process).
- **Local commits only. No push.** Plan 7 is downstream of Plan 6, both gated by Windows availability.

---

## Key design decisions to lock in during execution

- **CLSIDs:** generate fresh GUIDs (one per overlay icon, one per context menu item). Hardcode them in `register.rs` and `lib.rs::DllGetClassObject`. Document them in the README.
- **Overlay icon priority:** Windows shows at most ~15 overlay icons system-wide and there's a quirk where they're sorted alphabetically by registry key name. Prefix the registry keys with a string that sorts early (e.g., `   Helios-...` with leading spaces) — same trick Dropbox / OneDrive use. Test in real Explorer.
- **Context menu activation:** trigger only when right-clicking inside the local Vault folder (path starts with `%LOCALAPPDATA%\Helios\Vault\working\`). All other paths → menu items hidden.
- **Cache invalidation:** daemon pushes `OverlayInvalidate(path)` notifications via the named pipe; the shell ext maintains a worker thread that reads notifications and clears the in-process cache + asks Explorer to refresh the icon (`SHChangeNotify`).

---

## What this plan does NOT include

- **Cross-platform shell integration.** Mac shell extensions are not in scope (Mac is read-only Vault).
- **In-Explorer dialogs for check-in comments.** v1 opens the comment dialog in the Helios desktop app instead — clicking "Check In…" in the Explorer menu launches Helios with the file pre-selected and focused. v2 might add an in-Explorer hosted dialog, but it's a footgun.
- **Drag-and-drop integration.** Out of scope.

---

## Manual verification checklist (post-implementation, on a real Windows machine)

- [ ] After installation, the Vault folder shows overlay icons on every file in `working/`.
- [ ] Files I have checked out have the "locked by me" overlay; others' files have "locked by other".
- [ ] Files matching the latest server version show "latest"; older copies show "out of date".
- [ ] Right-click context menu appears with the appropriate items, depending on file state.
- [ ] Clicking Check Out → file becomes writable, overlay flips to "locked by me", appears in Helios's "Who has what" view live.
- [ ] Clicking Check In → Helios opens with the file pre-selected and a comment dialog.
- [ ] Stopping the daemon → overlays go neutral, context menu shows "Helios sync daemon not running".
- [ ] Restart the daemon → overlays repopulate without an Explorer restart.

---

## What Plan 8 picks up

Plan 8 builds the Windows MSI installer that bundles `helios.exe` + `pdm-sync-daemon.exe` + `pdm-shell-ext.dll` together, runs `regsvr32` on install, and the Mac DMG (which ships only `Helios.app`).
