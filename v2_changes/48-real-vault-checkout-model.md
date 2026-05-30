# 48 — v3.8.0: real-vault check-out model (read-only until checked out)

**Date:** 2026-05-30

The Vault now behaves like a real PDM (SolidWorks PDM / Windchill): your local
working copy of a file is **read-only until you check it out**. That's what lets
auto-sync always pull the latest version without ever destroying local work —
you can't edit a file you haven't checked out.

**Core invariant:** a local vault file is writable **iff** you hold its lock.

## What you'll notice
- Synced files are **read-only** on disk. **Check out** a file → it becomes
  **writable** (and you get the latest version first if your copy was missing or
  stale). **Check in** → back to read-only, as the new latest version.
- **Undo check-out** (Cancel) now asks to confirm, then **discards your local
  edits and restores the latest vaulted version** (read-only). Works in manual
  mode too, not just auto-sync.
- **Creating a new file** (the “+ File” button, or adding a local file) leaves it
  **checked out to you** by default — you made it, you hold the lock until you
  check it in.
- Auto-download keeps non-checked-out files mirrored to the latest version.

## How it works
- **`set_path_readonly` Rust app command** (cross-platform via
  `std::fs::Permissions::set_readonly`) toggles the OS read-only bit; thin TS
  `setReadonly()` wrapper. (App command → no capability/ACL grant needed.)
- **Per-hook transitions** drive the bit directly so check-out is instant and it
  works in manual mode: check-out → writable (+ get-latest if missing/stale);
  check-in → read-only; undo → restore-latest + read-only; create/add → locked
  to creator.
- **Downloads clear read-only before the atomic rename** — required on Windows,
  where renaming onto a read-only file fails (ACCESS_DENIED). Covers auto-sync,
  bulk, and Get-Latest (all route through `downloadVersionOnce`).
- **Stateless no-clobber rule** (auto-sync): the read-only bit is the
  “clean copy” marker. A writable, unlocked file that differs from latest is a
  possible unsaved edit → **held back**, never overwritten or frozen (surfaced
  via the sync status). A read-only stale copy → safely refreshed. No migration
  flag needed.
- **Reconciliation** pass (auto mode) self-heals drift to match lock state
  (e.g. after an admin force-unlock).

## Quality
Three independent adversarial review rounds (correctness/concurrency,
data-loss/cross-platform, tests/Rust) drove fixes — including a Windows
download break and an undo data-loss edge — to a clean verdict. Desktop suite:
**765 tests / 99 files green; `tsc` clean; Rust `set_path_readonly` tests pass**.
Design + as-built notes: `docs/superpowers/specs/2026-05-30-vault-real-vault-checkout-design.md`.
