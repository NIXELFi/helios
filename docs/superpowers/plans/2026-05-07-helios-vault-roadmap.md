# Helios Vault — Implementation Roadmap

> **Index of all implementation plans** for Helios Vault Phase 1. The Phase 1 spec is large enough that one monolithic plan would be impractical to execute or review. This roadmap splits it into eight independently shippable plans, each producing working, testable software on its own.

**Spec:** [`docs/superpowers/specs/2026-05-07-helios-vault-design.md`](../specs/2026-05-07-helios-vault-design.md)

**Release policy:** No `git push` to `main` (or any other remote branch) until **Plan 4 lands** at minimum — Plans 1–4 together produce the first user-visible "working product" (login + browse the vault from inside Helios + admin actions). Plans 5–8 add the native Windows experience and ship-ready installers.

---

## Plan order, dependencies, and status

| # | Plan | Plan file | Status | Depends on | Output / Definition of done |
|---|---|---|---|---|---|
| 1 | **Backend foundation** | `2026-05-07-helios-vault-1-backend.md` | code complete @ 653fdb4; tests await Docker setup | — | A live Supabase project with the `pdm` schema, RLS policies, RPCs, audit log, and bootstrap-admin script. Manually testable end-to-end via SQL or `supabase-js`: an admin can create a vault, an editor can acquire/release a lock, a non-holder cannot insert a version, an admin can force-unlock. |
| 2 | **Shared Rust crates** | `2026-05-07-helios-vault-2-crates.md` | code complete @ 4711089 | Plan 1 (for `pdm-client` integration tests against the live Supabase project) | `crates/pdm-core` (domain types, `no_std`-friendly for WASM), `crates/pdm-client` (typed Supabase wrapper used by the daemon and Tauri side), and `crates/pdm-sw-parser` (CFB-format SolidWorks file parser → reference path strings). All exercised by `cargo test`. |
| 3 | **Suite shell + login** | `2026-05-07-helios-vault-3-shell.md` | code complete @ ad5ceb0 | Plans 1, 2 | The existing Helios desktop app is reorganized into a module router: `modules/logs/` (existing UI relocated, behavior unchanged) and `modules/vault/` (new, gated by `<RequireAuth>`). New `packages/auth/` provides the Supabase JS auth provider, `useUser()` / `useSession()` hooks, and `RequireAuth` route guard. New left-rail "Vault" entry shows an in-app login pane on click; on success, a placeholder Vault home renders. **Logs is untouched and requires no login.** |
| 4 | **Vault module UI** | `2026-05-07-helios-vault-4-vault-ui.md` | not started | Plan 3 | Inside Helios, the Vault module gains real screens: Browse (folder tree + file table with live lock state via Supabase Realtime), File detail (history, refs, audit), History viewer, Search, Who-has-what, Admin → Users, Admin → Vaults, Settings. Read paths and admin operations are functional; check-in/out from the UI is stubbed (real check-in/out arrives in Plan 6 when the daemon exists). |
| 5 | **`parse-refs` edge function** | `2026-05-07-helios-vault-5-edge-function.md` | not started | Plans 1, 2 | A deployed Supabase Edge Function (Deno) that loads `pdm-sw-parser` as WASM, is triggered by a Postgres webhook on `pdm.versions` insert, downloads the version's bytes from Storage, parses references, and inserts `pdm.refs` rows. Includes a 6-hour retry cron for failed parses. |
| 6 | **`pdm-sync-daemon`** | `2026-05-07-helios-vault-6-sync-daemon.md` | not started | Plans 2, 4 | A Rust binary in `apps/pdm-sync-daemon/` that owns the local working copy, subscribes to Supabase Realtime, services IPC requests over a Windows named pipe, and manages an offline check-in queue. After this plan, a designer using Helios can right-click a file in the in-app Vault module and successfully check it in/out — files appear in `%LOCALAPPDATA%\Helios\Vault\working\`. |
| 7 | **`pdm-shell-ext`** | `2026-05-07-helios-vault-7-shell-ext.md` | not started | Plan 6 | A Rust shell extension DLL in `apps/pdm-shell-ext/` providing four overlay icons (`IShellIconOverlayIdentifier`) and the right-click context menu (`IExplorerCommand`) inside the local Vault folder. All operations delegate to the daemon via the named pipe. |
| 8 | **Installer + Mac packaging** | `2026-05-07-helios-vault-8-installer.md` | not started | Plans 6, 7 | Updated Tauri/NSIS installer bundles `helios.exe`, `pdm-sync-daemon.exe`, and `pdm-shell-ext.dll` with `regsvr32` registration and an HKCU\Run entry for the daemon. Mac DMG ships only the Helios app (no daemon, no shell ext). Auto-update via the existing minisign + GitHub Releases pipeline keeps working. |

---

## "Working product" milestones

Use these to decide when remote pushes are appropriate:

- **After Plan 1:** the database is real, but no user-facing software exists. Stay local.
- **After Plan 3:** Helios still renders identically for current users; clicking the new Vault tab shows a login pane. No vault content yet. Stay local.
- **After Plan 4:** the first user-visible product. An admin can log in, see the vault tree, see history, force-unlock, invite users — all in-app. Check-in/out from the UI is not yet wired up. *This is the earliest point where pushing to `main` could be appropriate, but only if Plans 5–7 are blocked or the team needs a preview build.*
- **After Plan 6:** designers can actually check files in/out from inside Helios. The product is functionally usable for the team, just not yet integrated into Explorer.
- **After Plan 7:** the native Windows experience is live (overlay icons + Explorer context menu). Functionally complete for Phase 1.
- **After Plan 8:** ship-ready installers. This is the right moment to tag a release.

---

## Plans 9+ (Phase 2 and beyond)

Out of scope for this roadmap. When Phase 2 (SolidWorks add-in) work begins, that gets its own spec and its own roadmap of plans. Same for Phase 3 (suite expansion, SSO, multi-vault, etc.).
