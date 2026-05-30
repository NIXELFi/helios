# 45 — v3.7.1: Vault + Logs audit sweep (bug-fix release)

**Date:** 2026-05-29

A full correctness + UX audit of the **Vault** and **Logs** modules and the
shared shell/auth chrome, followed by a fix sweep. No new features — this is a
hardening release. Every fix landed test-first; the desktop suite went from 569
to **715 tests** (98 files), `tsc --noEmit` clean.

## Critical
- **Check-in comment box** — `RowActions` used `window.prompt`, which never
  renders in the Tauri webview, so the comment was always null. Now an in-app
  modal.
- **Check-in lock broadcast** — `useCheckIn` now calls `notifyLockChange()` on
  success, closing the window where auto-sync could clobber a just-checked-in
  file.
- **Bulk "Download vault"** — replaced the size-only skip (which silently left
  users on stale same-size revisions and reported green) with a SHA-256 verify;
  out-of-date locals are flagged "differ (kept)" instead of falsely "synced".
- **Math-channel id collisions** — adding/editing a math channel whose id shadows
  a real channel (or another math channel) is now rejected inline instead of
  silently overwriting telemetry / duplicating React keys.
- **Logs boot resilience** — a single bad bundled math formula could strand the
  app on the loading screen; post-load processing is now guarded and sessions
  commit regardless. `loadWorkspaces()` no longer runs (and migrates) twice.

## Vault
- Query/mutation errors now surface (inline error + retry; mutation tooltips)
  instead of permanent spinners or silent no-ops; Postgres errors routed through
  `friendlyPgError`.
- Pagination correctness: unique `id` tiebreaker on `useFiles`/`useFolders`;
  `fetchAllRows` handles a `db-max-rows` cap below the page size + a runaway
  guard. Atomic temp-then-rename downloads. NFC + case-fold path matching (fixes
  macOS re-download loops / duplicate "add" prompts). Realtime reconnect + unique
  channel names. Symlink-cycle guard in the local scan.
- Who-has-what scoped to the active vault; per-row force-unlock; holder names
  resolved. Admin: real server error messages, confirmation on destructive
  actions, no table-blanking on refetch. Lock-holder emails shown. Empty/loading
  states across the file table, history, and switcher.

## Logs
- Correct best-lap tagging with an out-lap; `[`/`]` reach the first lap;
  pure `setSessions` updaters; playback no longer yanks the cursor on zoom;
  clamped progress; tile placement uses rectangle intersection (no overlaps).
- Command palette keyboard nav clamped to visible rows; modals (math, channels,
  add-tile, lap-config, command palette) gained Escape + focus-trap + focus
  restore; native `confirm()` replaced with the in-app `ConfirmDialog`; export
  failures surface inline.

## Shell / Auth
- No more hidden VaultModule remount after sign-out→sign-in; signup password
  length pre-check; forgot-password no longer leaks account existence; stale
  role cleared on user change; double-submit guards; updater modal can't be
  dismissed mid-install; nav/version/a11y polish.

## Deferred (tracked)
- `useIsAdmin`/`useIsOwner` error-exposure (boolean→object ripples across UI —
  needs a coordinated change; current behavior fails closed).
- FolderTree virtualization (perf, large vaults).
- Shared Tailwind status tokens (colors harmonized per-file for now).
