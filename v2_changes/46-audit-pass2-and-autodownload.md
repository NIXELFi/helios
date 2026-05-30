# 46 — v3.7.2: second-pass audit fixes + auto-download status fix

**Date:** 2026-05-30

A follow-up to v3.7.1: a second audit pass over the Vault + Logs modules caught
regressions the first sweep introduced (mostly focus/lifecycle, which unit tests
couldn't see) plus one critical miss — and a separate, user-reported bug where
the Vault's auto-download feature appeared to do nothing. No new features.
Desktop suite: **751 tests, 98 files, all green; `tsc` clean.**

## Auto-download "does nothing / no status" — fixed
When a vault was in **Auto** download mode but no Helios sync folder had been
picked, the toolbar rendered *nothing*: `VaultSyncSection` is gated on
`vaultFolderPath && autoSyncEnabled`, and the "Manual mode" pill on
`!autoSyncEnabled`, so auto-with-no-folder fell between them. `useAutoSync`
also no-ops without a `vaultRoot`, and `useLocalFolderScan(null)` does no scan —
so no status, no per-file "up to date", no downloads, and no prompt to fix it.
Settings even let you switch to Auto without ever asking for a folder.

Fix: a third toolbar state — **"Auto-download on — no sync folder set · [Set
folder]"** — that picks a folder in one click and immediately activates sync.

## Critical / High (pass 2)
- **Force-unlock was dead** — `WhoHasWhatScreen` still used `window.prompt` (a
  no-op in the Tauri webview, same root cause as the v3.7.1 RowActions fix which
  missed this second call site). Now an in-app reason modal.
- **Stacked-modal Escape** — modals used `stopPropagation` on `window`, which
  doesn't stop sibling `window` listeners, so one Escape could close two modals
  (and dismissing a modal could wipe the tree selection underneath). Switched to
  `stopImmediatePropagation`; the updater modal no longer auto-pops over an open
  auth modal; BrowseScreen's Escape now no-ops while any dialog is open.
- **Role tag flicker** — `useMyRole` reset + refetched on every `user` object
  change (incl. hourly token refresh); now keyed on `user?.id`.
- **Trace-color desync** — re-loading a session mis-assigned overlay colors
  (index ≠ array position after id-dedup); colors now derive from final position
  (extracted `mergeSessionsWithColors`, unit-tested).
- **Atomic-write temp files** — downloads used a fixed `.part` name (collided
  between concurrent writers) and orphaned on failure; now a unique
  `crypto.randomUUID()` temp + best-effort cleanup.
- **FileDetailPanel false "deleted"** — a `?? []` regression showed "file
  deleted" during load; now `?? undefined`.
- **Bulk status unmount** — completing a bulk op cleared the selection, which
  unmounted the `aria-live` result before it could be read; selection now
  persists until the user clears it.

## Medium / Low (pass 2)
Per-row disable in Admin (was all-rows); SHA comparisons case-insensitive (no
re-download loop on uppercase shas); pagination advances by actual rows received;
WhoHasWhat scoped correctly on a loaded-empty vault + surfaces path errors;
ChannelsModal/MathChannelsModal no longer steal focus on re-render; TabContextMenu
submenu arrow-nav + valid DOM nesting; CommandPalette Tab-trap + accurate match
count; ShortcutsOverlay focus management; impure `setSessions` updaters made pure
(extracted `computeOverrideChange`/`computeMathChannelsUpdate`); signup surfaces
subteam-load errors; release date formatted in local time; failed install keeps
the modal open with a retry; FolderTree marquee listener cleanup on unmount;
dead `LockBadge`/`LocalStatusBadge` component removed (FileTable's pill is the
single renderer); shared `holderLabel` helper. Test harness: `URL.createObjectURL`
stubbed centrally so widget/maplibre imports collect in jsdom.
