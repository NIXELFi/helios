# Helios SOLIDWORKS add-in — handoff / context

Read this first if you're picking up the add-in work in a fresh session
(especially **on the Windows + SolidWorks machine**, which is where it builds and
runs). The macOS side can author C# but can't build/test it.

## Goal
A SOLIDWORKS add-in that does what SW PDM does, against the **Helios** vault:
check-in / check-out, get latest, version history, lock/where-used, data card —
plus true **edit-enforcement** (you can't change a file in SW unless you've
checked it out). Today, OS read-only is only a speed bump; the *real* guarantee
is server-side (Helios refuses a check-in without the lock). The add-in closes
the in-SW gap.

## Key decisions (settled)
- **Bridge architecture.** The add-in is a thin SW-side client; it talks to a
  `127.0.0.1` HTTP API exposed by the **running Helios desktop app**, which
  already owns auth (Supabase session), sync, locks, and the `pdm.*` RPCs. One
  source of truth — no duplicated auth/vault logic in C#.
- **Helios auto-starts minimized / in the tray** so the bridge is always up
  (Phase 5).
- **Stack:** C# **.NET Framework 4.8** COM add-in (`ISwAddin`), x64, WinForms
  Task Pane. Self-registers via `regasm /codebase` (`[ComRegisterFunction]`).
- **Workflow:** author C# on macOS, **build/test on Windows** (or run Claude
  Code directly on the Windows box — preferred, closes the loop).

## Roadmap / status
1. **Phase 1 — DONE + verified:** loadable add-in + "Helios Vault" Task Pane,
   reflects the active document. Builds/registers/loads in SW2025.
2. **Phase 2 — DONE + verified:** localhost bridge in `apps/desktop/src-tauri`.
   Metadata ops native in Rust (`/status`, `/status-batch`, `/versions`,
   `/checkout`, `/add`, `/health`); blob ops (`/checkin`, `/get-latest`) forward
   to the UI's tested code. Multi-vault snapshot pushed from the frontend.
3. **Phase 3 — DONE + verified:** Task Pane wired to the bridge — real check-in/
   out / get-latest / versions / lock status, **Add-to-Vault** for untracked
   files, and **assembly component status** (where-used tree). Identity/online
   line ("● Connected · you").
4. **Phase 4 — TODO:** edit-enforcement — handle SW document events (open +
   save-pre-notify) to block or force a check-out. The *server* already refuses a
   check-in without the lock; this closes the in-SW gap. **Not yet built.**
5. **Phase 5 — IMPLEMENTED, pending live validation:** per-user (no-admin)
   add-in injector (`src-tauri/src/addin_injector/`, auto-update via versioned
   staging), Helios minimize-to-tray + auto-start-on-login, DLL bundled as a
   Tauri resource (`pnpm build:win`). Compiles + unit-tested; needs the Task 0
   HKCU spike + a live SW pass on the Windows box (see
   `docs/superpowers/plans/2026-06-01-helios-addin-injector-tray.md`).

## Where things live
- Add-in: `solidworks-addin/` (this dir). Branch: **`feat/sw-addin`**.
- Helios desktop app (bridge target): `apps/desktop/` (Tauri: Rust `src-tauri/`
  + React/TS `src/`). Vault module: `apps/desktop/src/modules/vault/`.
- Backend: Supabase project `dlmyixonuyckxkknolku` (`pdm` schema). Check-in/out
  RPCs: `pdm.check_in`, `pdm.add_and_lock`, `pdm.force_unlock`,
  `pdm.acquire_lock`/locks, `pdm.set_revision`, `pdm.record_refs`. Storage
  bucket `vault-objects` (gzip blobs keyed by sha256 at `{sha[:2]}/{sha}`).
- The desktop vault hooks to mirror over the bridge:
  `useAcquireLock`, `useCheckIn`, `useReleaseLock`, `useDownloadVersion`,
  `useVersions`, `useLocks` (in `apps/desktop/src/modules/vault/data/`).

## Continuing on Windows
1. Install Claude Code on the Windows machine (CLI / desktop / IDE extension).
2. `git clone` (or pull) this repo; `git checkout feat/sw-addin`.
3. Open a Claude Code session in the repo and point it at this file.
4. Build + register per `README.md`, confirm the Task Pane loads, then start
   Phase 2/3. The Windows box can build/register/debug the add-in directly —
   no more "ship it over."

The live chat from the macOS session doesn't transfer automatically, but
everything decided is captured here + in git, and your Claude memory carries
across. This doc is the bridge.
