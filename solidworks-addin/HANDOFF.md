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

## Roadmap
1. **Phase 1 — DONE (this commit):** loadable add-in + "Helios Vault" Task Pane,
   reflects the active document. Placeholder buttons. → `src/`, build per README.
2. **Phase 2:** add a localhost bridge API to the Helios Tauri app
   (`apps/desktop/src-tauri`): `GET /status?path=`, `POST /checkout`,
   `POST /checkin`, `POST /get-latest`, `GET /versions?path=` — each delegating
   to the existing vault hooks/RPCs. Auth = the app's current session.
3. **Phase 3:** wire the Task Pane buttons to the bridge (real check-in/out /
   get-latest / version list / lock status for the active document).
4. **Phase 4:** enforcement — handle SW document events (open + save-pre-notify)
   to block or force a check-out.
5. **Phase 5:** Helios auto-start-on-login + minimize-to-tray; one-click
   installer + COM registration for the add-in.

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
