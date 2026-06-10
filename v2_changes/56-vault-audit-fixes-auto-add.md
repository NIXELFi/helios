# 56 — Vault: audit fixes + SW-PDM-style auto-vaulting of new files

**Date:** 2026-06-09 · Frontend-only (backend draft RPC shipped in #48/#53-era
migrations). From the 4-area vault bug audit.

## Audit fixes

- **Stale-lock download window closed** (the audit's top finding): a checkout
  made while an auto-sync pass was mid-flight could let an already-queued
  download land stale bytes and re-freeze the fresh checkout read-only.
  Workers now re-check a LIVE lock set right before downloading and before
  freezing, and the downloader re-checks its abort signal between the temp
  write and the atomic rename.
- **Undo-checkout honesty**: a failed restore no longer signals success — the
  lock-released-but-not-restored state surfaces on the button with a Retry
  that re-runs only the missing step (never double-releases).
- **Draft discard**: undo-checkout on a never-checked-in file is now an
  explicit "Discard draft" (soft-delete; reaper removes the local copy)
  instead of silently orphaning an unlocked writable file.
- **Friendly duplicate names**: creating a file/folder that already exists in
  the folder now says so up front instead of surfacing a raw 23505.

## SW-PDM auto-vaulting (new)

In auto mode, a new file saved into the vault folder vaults ITSELF: it
becomes a private draft checked out to you (pdm_add_and_lock), invisible to
everyone else until first check-in — no "(add to the vault)" click. Guards:
must be hashed by the scan, mtime stable ≥5 s (no half-written CAD saves),
not in the sync ledger (never resurrects deletions/discards), 5-min backoff
per failing file. Manual mode keeps the explicit banner. A passive status
strip narrates progress/failures.

6 new tests; 177 desktop test files + typecheck green.

## Round 2 (same day): reference + data-card honesty

- **Unresolved references surface at check-in**: after recording refs, the
  client reads back what stayed unresolved and warns — distinguishing "not
  found in this vault" from "matches multiple vault files (rename one to
  disambiguate)", which a re-check-in can never fix. SW PDM halts on these;
  we at least stop being silent. (Arms fully once parse_sw_refs learns the
  modern deflate format — it returns empty on current SW files.)
- **Data-card capture failures surface at check-in**: a property-parse error
  now says "version checked in fine; its data card is empty" instead of
  silently recording nothing. The lazy backfill path stays quiet.
- Both ride a new `vault-warning-events` bus + dismissible amber
  `VaultWarningBanner` — warnings outlive the button that fired them (the
  check-in button unmounts on success).
- Audit note: client has NO file-rename feature, so "warn on rename of
  referenced files" has nothing to guard yet — rename itself is the missing
  SW PDM parity piece.
