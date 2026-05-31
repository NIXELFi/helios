# Always-On Background Vault Sync — Implementation Plan

> **For agentic workers:** Use this plan phase-by-phase. It spans the Tauri Rust
> backend (`apps/desktop/src-tauri`) and the React/TS frontend
> (`apps/desktop/src`). Steps use checkbox (`- [ ]`) tracking. TDD where a unit
> boundary exists; integration-test the rest.

**Goal:** Helios runs continuously in the background (system tray + launch-at-login)
and keeps **every vault the user can access** real-time current — **metadata
always**, and **file bytes too whenever that vault is in Auto mode** — no matter
which module is open or whether the window is even visible.

**Architecture:** Lift the vault sync engine out of `BrowseScreen` into an
**app-level `VaultSyncProvider`** mounted once at the `Shell` root. Freshness is
driven by three independent signals so no single one is a single point of
staleness: **Supabase Realtime** (instant push; *not* throttled when the window
is hidden), a **Rust-emitted interval tick** (beats the webview's background-timer
throttling), and the **native fs-watcher** (local state). Cover all accessible
vaults, each honoring its own Auto/Manual mode. **Freshness is prioritized over
resource economy** — the team is small, limits aren't a concern, so we poll
aggressively and keep every vault subscribed.

**Tech stack:** Tauri v2 (Rust + React/TS), Supabase (`pdm` schema + Realtime),
`tauri-plugin-autostart`, Tauri v2 tray, `tauri-plugin-single-instance` (already
wired).

---

## Why this is non-trivial
All sync logic lives in `BrowseScreen` today (`useVaultRealtime`, the 15s
`useInterval` poll, `useLocalFolderScan`, `useAutoSync`, the file/lock queries),
so it only runs **while the Vault module is mounted and the user is on it**. The
work is (1) keep the process alive in the background and (2) move the engine
above the module layer so it never stops.

## Current state to refactor
- `apps/desktop/src/modules/vault/screens/BrowseScreen.tsx` — owns every sync
  hook; scoped to the active vault; runs only while mounted.
- `apps/desktop/src/Shell.tsx` — mounts modules on first visit, keeps them
  mounted (visibility toggle). Single-instance plugin already initialized in
  `src-tauri/src/lib.rs`.
- Hooks to reuse: `useVaultRealtime`, `useAutoSync`, `useLocalFolderScan`,
  `useAllFiles`/`useFiles`/`useLocks`, `useDownloadMode`, `useVaultFolder`
  (all in `modules/vault/data/`).

## Target file structure
- `apps/desktop/src-tauri/` — autostart, tray, close-to-tray, start-hidden, and a
  `vault_tick` interval event emitter (Rust `tokio` timer — unthrottled).
- `apps/desktop/src/vault-sync/VaultSyncProvider.tsx` *(new)* — the always-on
  engine + a context exposing per-vault state (files/versions/locks/sync status).
- `apps/desktop/src/vault-sync/useVaultSyncEngine.ts` *(new)* — the multi-vault
  orchestration (subscribe + tick-refetch + scan + auto-download per vault).
- `Shell.tsx` — wrap `<HeliosShell>` in `<VaultSyncProvider>` (inside `AuthShell`,
  so it has the session).
- `BrowseScreen.tsx` — consume the provider; delete the local sync hooks.

---

## Phase 1 — Process always alive (tray + autostart)

### Task 1.1: Launch at login
- [ ] Add `tauri-plugin-autostart` (Cargo + JS), register in `lib.rs`.
- [ ] Settings toggle "Start Helios at login" (default ON), calling `enable()/disable()`.
- [ ] Verify the OS entry is created (Windows Run key; macOS LoginItem).

### Task 1.2: System tray + close-to-tray
- [ ] Add a tray icon (`TrayIconBuilder`) with a menu: **Open Helios**, **Quit**.
- [ ] Intercept `WindowEvent::CloseRequested` → `prevent_close()` + hide the window (don't exit). Quit only via the tray menu.
- [ ] Tray left-click / "Open Helios" → show + focus the window.

### Task 1.3: Start hidden on autostart
- [ ] Autostart launches with arg `--hidden`; on startup, if present, don't show the main window (start tray-only). Manual launch shows normally.
- [ ] macOS: `set_activation_policy(Accessory)` while hidden so it isn't in the Dock; restore `Regular` when shown.

**Test:** manual — launch at login starts hidden in tray; close hides; reopen from tray; Quit actually exits; second launch focuses the existing instance (single-instance ✓).

---

## Phase 2 — Hoist the sync engine to the app root (active vault)

### Task 2.1: VaultSyncProvider scaffold
- [ ] Create `vault-sync/VaultSyncProvider.tsx` + context. Mount it in `Shell.tsx` inside `AuthShell`, around `HeliosShell`.
- [ ] Move the active-vault realtime + poll + local scan + auto-sync wiring out of `BrowseScreen` into the provider. Expose state via context: `{ filesByVault, locksByVault, localByVault, syncStatusByVault, openInSwByVault, refresh() }`.

### Task 2.2: BrowseScreen consumes the provider
- [ ] Replace `BrowseScreen`'s local hooks with `useVaultSync()` reads. Keep all UI behavior identical.
- [ ] **Test:** existing `BrowseScreen.test.tsx` + vault suite stay green; the file list, locks, download buttons, and auto-sync pill behave exactly as before — now sourced from the provider.

**Checkpoint:** sync now runs whenever the app is on *any* tab (Logs/CFD/Vault), not just Vault.

---

## Phase 3 — Cover every accessible vault

### Task 3.1: Enumerate vaults
- [ ] In the provider, load all vaults the user can access (`useVaults`), not just the active one.

### Task 3.2: Per-vault engine instances
- [ ] For each vault, run its own: Realtime subscription, metadata refetch, local-folder scan, and — **only if its `downloadMode` is Auto** — the `useAutoSync` download loop. Manual vaults get metadata + scan only (list stays live; no downloads).
- [ ] Resolve each vault's local folder via `useVaultFolder` (per-vault path under the shared root).
- [ ] **Test:** with two vaults (one Auto, one Manual), Auto downloads in the background while Manual only refreshes its list; switching the UI's active vault shows already-fresh data (no load spinner).

---

## Phase 4 — Guarantee freshness when hidden (the "up to date matters most" core)

### Task 4.1: Rust interval tick (beats webview throttling)
- [ ] In `src-tauri`, a `tokio` interval (e.g. every 8–10s — aggressive; limits don't matter) emits a `vault-tick` event to the frontend. Rust timers are **not** subject to the webview's hidden-window timer throttling, so polling stays real-time even minimized/tray-only.
- [ ] The provider listens for `vault-tick` and refetches metadata for all vaults (in addition to Realtime push). Drop the JS `setInterval` poll (it throttles when hidden).

### Task 4.2: Keep the session alive in the background
- [ ] Verify Supabase `autoRefreshToken` survives background throttling; if not, refresh the token on each `vault-tick` (or via a Rust keepalive) so Realtime + queries never silently expire while idle/hidden.
- [ ] **Test:** hide the window, mutate a vault from another client, confirm the change lands within one tick / Realtime push (manual, on Windows + macOS).

---

## Phase 5 — Serve the add-in bridge + resilience

### Task 5.1: Bridge data source
- [ ] The SOLIDWORKS add-in's localhost bridge (separate plan) reads from this always-fresh provider state, so "open SolidWorks → instantly correct check-out/version status" is real.

### Task 5.2: Offline / reconnect
- [ ] Detect offline (failed tick/fetch) → stop error-spam, show a subtle "reconnecting" state, resume on reconnect + Realtime re-subscribe. (No battery/metered gating — freshness is the priority.)

---

## Decisions (locked)
- **Scope:** all accessible vaults, each per its Auto/Manual mode.
- **Engine:** hoisted TS provider, with a **Rust tick** for unthrottled background timing (full Rust rewrite not needed — Realtime + the tick give real-time freshness).
- **Priority:** up-to-dateness over resource economy.

## Risks / watch-items
- **Background timer throttling** → solved by Realtime (push) + the Rust tick.
- **Token refresh while idle/hidden** → Task 4.2; verify on both OSes.
- **N-vault Realtime subscriptions** → fine at our scale; watch connection caps only if vault count grows large.
- **Conflict safety** → preserved: `useAutoSync` already holds back writable/locally-edited files instead of clobbering them.
- **Multi-vault local scans** → each vault folder scanned independently; the fs-watcher is native (unthrottled).

## Execution order
Phase 1 (alive) → Phase 2 (hoist) → Phase 4 (Rust tick) can precede or follow
Phase 3, but Phase 3 (all vaults) is what fully delivers the goal. Phase 5 ties
into the add-in bridge.
