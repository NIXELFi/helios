# Helios Vault — Plan 6: `pdm-sync-daemon` (Windows)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Windows tray-mode daemon (`pdm-sync-daemon.exe`) that owns the local working copy under `%LOCALAPPDATA%\Helios\Vault\`, brokers IPC requests from the Helios desktop app and the shell extension, and queues offline operations. After this plan, a designer using Helios can right-click a file in the in-app Vault module → Check Out / Check In, and the daemon performs the upload + Supabase calls.

**Architecture:** New `apps/pdm-sync-daemon/` Tauri-style Rust binary (no GUI; tray icon via `tray-icon` crate). IPC server over a Windows named pipe (`\\.\pipe\helios-pdm`) using a small framed JSON-RPC protocol. Local state in SQLite (`meta.sqlite`) mirroring `pdm.files` / `pdm.versions` / `pdm.locks`. Supabase Realtime subscription via `pdm-client` (Plan 2) keeps the local state in sync. Offline queue persisted to JSON files under `%LOCALAPPDATA%\Helios\Vault\queue\`.

**Tech Stack:** Rust 2021, `tokio`, `tray-icon`, `windows-rs` (named-pipe server), `rusqlite`, `pdm-core` + `pdm-client` (Plan 2), `serde_json`, `directories` (for `%LOCALAPPDATA%` lookup).

**Spec:** [`docs/superpowers/specs/2026-05-07-helios-vault-design.md`](../specs/2026-05-07-helios-vault-design.md)
**Roadmap:** [`docs/superpowers/plans/2026-05-07-helios-vault-roadmap.md`](2026-05-07-helios-vault-roadmap.md)
**Depends on:** Plan 2 (`pdm-core`, `pdm-client`).
**Build target:** Windows only. CI for non-Windows runners must skip this crate.

---

## File Structure

### New crate

```
apps/pdm-sync-daemon/
  Cargo.toml
  src/
    main.rs                     ← startup, tray icon, run-loop
    ipc/
      mod.rs                    ← named pipe server, frame protocol
      protocol.rs               ← request / response enums (serde tagged)
      handlers.rs               ← one fn per IPC method
    cache/
      mod.rs                    ← LocalCache struct
      sqlite.rs                 ← schema + queries
      working.rs                ← local working-copy file ops
    sync/
      mod.rs                    ← Realtime subscription, refresh loop
      offline_queue.rs          ← persisted queue of pending ops
    config.rs                   ← path resolution (%LOCALAPPDATA%\Helios\Vault\...)
  tests/
    ipc_protocol.rs             ← serde round-trips for the protocol
    offline_queue.rs            ← queue persistence
```

### Modified files

```
Cargo.toml                       ← add apps/pdm-sync-daemon to workspace.members (with cfg(windows))
.github/workflows/*              ← (if any) ensure non-Windows CI skips this crate
```

### Build constraints

- Add `#![cfg(target_os = "windows")]` at the top of `main.rs`. On other targets, the crate compiles to a no-op stub or is excluded via `#[cfg(...)]` from the workspace.
- Alternatively, exclude from default workspace: list under `[workspace] exclude` and require `cargo build -p pdm-sync-daemon --target x86_64-pc-windows-msvc` from a Windows host.

---

## Task overview (high-level — each becomes a granular task during execution)

1. **Scaffold crate + main.rs stub** that prints "daemon starting" and exits. Wire into workspace.
2. **Path resolution / config.rs** — `%LOCALAPPDATA%\Helios\Vault\{working,queue}\` and `meta.sqlite`. TDD with mock paths.
3. **SQLite schema + LocalCache** — files, versions, locks, sync_state, queue rows. TDD against an in-memory SQLite.
4. **IPC protocol types** — `Request` enum (`AcquireLock`, `ReleaseLock`, `CheckIn`, `GetLatest`, `GetOverlayState`, ...) and `Response` enum. Serde round-trip tests.
5. **Named-pipe server skeleton** — accept connections, parse one request, echo response. TDD with a hand-driven client. Use `tokio` + `windows-rs::Win32::System::Pipes`.
6. **Auth handshake** — daemon reads `%LOCALAPPDATA%\Helios\daemon-auth.json` for the IPC token. Reject calls with wrong / missing token.
7. **Acquire-lock handler** — calls `pdm-client::acquire_lock`, downloads bytes, writes to `working/`, flips read-only bit off, updates `meta.sqlite`, returns lock id.
8. **Check-in handler** — hashes file, uploads via signed URL, calls `pdm_check_in` RPC, flips read-only bit on, updates `meta.sqlite`.
9. **Cancel-checkout handler** — calls `pdm_cancel_checkout`, marks file read-only, no upload.
10. **Get-latest handler** — downloads latest version of a file, writes to `working/`.
11. **Get-overlay-state handler** — fast read from `meta.sqlite`. Used by shell extension (Plan 7).
12. **Realtime subscription** — connect to Supabase Realtime, subscribe to `pdm.locks` and `pdm.versions` change feeds, update `meta.sqlite` on events.
13. **Offline queue** — when network ops fail, persist a queue entry; on reconnect, drain in order. Conflict path: surface to UI when queued check-in fails because lock was force-released.
14. **Integrity check on launch** — verify each cached file's sha256 matches the version metadata; flag mismatches in `meta.sqlite`.
15. **Tray icon** — visible status: synced / syncing / offline / error. Right-click menu: Show Helios, Force-resync, Quit.
16. **Wire startup / shutdown** — Tauri integration: when `helios.exe` starts, it spawns the daemon if not running, or connects to existing.
17. **Plan-completion review** — manual smoke test on Windows: launch daemon + Helios, check out a file from the in-app Vault module, see file appear locally, check in, see it disappear.

---

## Conventions

- Each task: failing test → implementation → passing test → commit.
- All IPC tests use named-pipe round-trips between in-process spawned tasks (no actual `helios.exe`).
- Local commits only. **No push.** Plan 6 is part of "after Plan 4" Windows-native rollout; remote pushes still gated until later.
- Cargo workspace builds the daemon only on Windows; non-Windows CI skips.

---

## Key design decisions to lock in during execution

- **IPC framing:** length-prefixed JSON. Each frame is `<u32 LE length><JSON bytes>`. Simple, well-defined, robust.
- **Handler state:** each connection gets its own task; shared state (LocalCache, Supabase client) wrapped in `Arc<Mutex<...>>`.
- **Token auth on IPC:** every request includes a `token` field whose value must match the contents of `daemon-auth.json`. The token is generated at first daemon launch and written there with mode 0600 (NTFS ACL set to user-only).
- **Lock heartbeats:** none. The server is the source of truth; the daemon reads lock state from Realtime / Postgres, not heuristics.
- **Working-copy isolation:** one local cache directory per Windows user. Documented; not enforced.

---

## What this plan does NOT include

- **Mac equivalent of the daemon.** Mac is read-only Vault per the spec.
- **Auto-update for the daemon.** Plan 8 (installer) handles bundle updates.
- **GUI configuration of cache paths.** v1 uses the default (`%LOCALAPPDATA%\Helios\Vault\`); a Settings UI is Plan 4b.

---

## Manual verification checklist (post-implementation, on a real Windows machine)

After all tasks land and one Windows installer build is produced (Plan 8):

- [ ] Install Helios. Launch. Confirm `pdm-sync-daemon.exe` appears in Task Manager and a tray icon is visible.
- [ ] Sign in to Vault. Confirm the daemon picks up the session.
- [ ] In Helios Vault → Browse, right-click a file → Check Out (or use the equivalent button). Confirm:
  - The file appears in `%LOCALAPPDATA%\Helios\Vault\working\` writable.
  - The Vault module re-renders with "Locked by me" badge.
- [ ] Edit the file in SolidWorks. Save. Click Check In with a comment. Confirm:
  - A new version appears in the History view.
  - The file is back to read-only on disk.
- [ ] Sign out. Re-sign in. Confirm overlay state hydrates from Realtime.
- [ ] Stop network (disable Wi-Fi). Try Check Out a different file. Confirm a clear error.
- [ ] With a file already checked out, edit offline. Re-enable network. Confirm the queued check-in flushes successfully.

---

## What Plan 7 picks up

Plan 7 builds `pdm-shell-ext.dll` — the Explorer overlay icons and right-click context menu. Every operation it exposes is a thin IPC call to the daemon implemented in this plan.
