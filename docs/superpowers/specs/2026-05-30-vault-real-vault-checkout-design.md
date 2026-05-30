# Vault: real-vault check-out model (read-only until checkout)

**Date:** 2026-05-30 · **Status:** approved, ready for implementation

## Goal
Make the Vault behave like a real PDM (SolidWorks PDM / Windchill): local working
copies are **read-only** until you check a file out. This is what lets auto-sync
always pull the latest version without ever destroying local work — you can't
edit a file you haven't checked out.

## Core invariant
> A vault file's local copy is **writable iff the current user holds its lock
> (has it checked out)**. Otherwise it is **read-only**.

Everything below is enforcement of this one rule. The "auto-sync clobbers a
modified, unlocked file" problem dissolves: a non-checked-out file is read-only,
so there are no unlocked local edits to lose.

## Components

### 1. Read-only primitive (Rust command)
The Tauri fs plugin has no chmod, so add an app command:
- `src-tauri`: `#[tauri::command] set_path_readonly(path: String, readonly: bool)`
  using `std::fs::metadata(&path)?.permissions()` → `perm.set_readonly(readonly)`
  → `std::fs::set_permissions(&path, perm)`. Cross-platform (Windows read-only
  attribute; Unix clears/sets owner+group+other write bits).
- Register in the `invoke_handler!` generate_handler list.
- App (not plugin) command → no capability/ACL grant needed (capabilities gate
  plugin + core commands only). Verify on first run.
- TS wrapper `lib/fs-readonly.ts`: `setReadonly(path, readonly): Promise<void>`
  over `invoke("set_path_readonly", { path, readonly })`. Best-effort: log + swallow
  on failure (a perms hiccup must not break a download).

### 2. Lifecycle transitions
| Event | Local file → |
|---|---|
| Auto-sync / bulk / get-latest download (in `useDownloadVersion` after the atomic write) | **read-only** (you can only download non-checked-out files) |
| Check out (`useAcquireLock` success) | **writable** (get-latest first if not present locally) |
| Check in (`useCheckIn` success) | **read-only** (content is already the latest you uploaded) |
| Undo checkout / Cancel (`useReleaseLock` success) | **A:** discard local edits → re-download latest → **read-only**, behind a confirm |
| New file created (`useCreateFile`, `useAddLocalFile`) | **checked out to creator** → lock acquired, local copy **writable** |

### 3. Reconciliation (safety net)
Each auto-sync pass, after downloads, reconcile every local vault file's
read-only bit to match lock state (writable iff locked-by-current-user). Self-heals
drift: a checkout that predates this feature, a lock force-released by an admin,
a file edited out-of-band. Single source of truth = `locks` + `currentUserId`.

### 4. (A) Undo checkout = discard + restore latest
Cancel/undo-checkout is destructive in a real vault: it throws away local edits
and restores the vaulted version. The Cancel control gets a confirm
("Discard your local changes to <name>? This restores the latest vaulted
version."). On confirm: release lock → re-download latest → set read-only.

### 5. (B) First-run migration guard
Today every local file is writable; some may be locally modified but never
checked out. On the FIRST reconciliation after this ships, a modified-and-unlocked
file is **not** clobbered — it's left as-is and surfaced ("N local files have
unsynced changes and aren't checked out; check them in or discard"). A one-time
localStorage flag (`helios.vault.roMigrated.<vaultId>`) gates this; subsequent
passes enforce the invariant normally.

### 6. New file → checked out to creator
When a file new to the vault is created (`useCreateFile`) or a local file is added
(`useAddLocalFile`), the creator should hold the lock by default (they're working
on it). Implementation: after the create/add RPC succeeds, acquire the lock for
the new file id (client-side: create → `pdm_acquire_lock`; `notifyLockChange()`),
and set the local copy writable. (Server-side atomic create-locked is a possible
future hardening; client-side is adequate for the team's size.)

## Testing
- Rust: a `#[cfg(test)]` round-trips set_path_readonly true/false on a temp file
  (`metadata().permissions().readonly()`).
- TS (mock the `setReadonly` wrapper / `invoke`):
  - download → setReadonly(dest, true) called after write.
  - acquireLock success → setReadonly(path, false).
  - checkIn success → setReadonly(path, true).
  - releaseLock (undo) → re-download + setReadonly(path, true).
  - reconciliation → writable iff locked-by-me across a mixed set.
  - migration guard → modified+unlocked not downloaded on first pass; flagged.
  - create/addLocal → acquireLock called for the new file id.
- Existing suite stays green; add a capabilities/command guard if an ACL turns
  out to be needed.

## Rollout
Ships as v3.8.0. No schema migration required (client-side checkout-on-create);
revisit server-side atomic lock-on-create later if races matter.

## Implementation notes (as built — supersedes details above where they differ)
A post-implementation adversarial review surfaced gaps in a reconciliation-only
approach; the final design uses **direct per-hook transitions + reconciliation
as a safety net**, plus two correctness fixes:

1. **Download clears read-only first (cross-platform).** `downloadVersionOnce`
   calls `setReadonly(dest, false)` before the temp→dest rename. Renaming onto a
   read-only file fails on Windows (`MoveFileExW` → ACCESS_DENIED); clearing the
   bit first makes refreshing a read-only stale file work everywhere. The
   download leaves the file writable; the caller / reconciliation re-applies
   read-only.

2. **Per-hook transitions (work in manual mode too, not just auto-sync):**
   - **Check out** (`CheckOutButton`): acquire lock → download latest if not
     present locally → `setReadonly(dest, false)` (writable, instant).
   - **Check in** (`CheckInButton`): on success → `setReadonly(dest, true)`.
   - **Undo / Cancel** (`CancelButton`): confirm → release lock → re-download
     latest (discard local edits) → `setReadonly(dest, true)`.
   - **Create / add** (`useCreateFile` / `useAddLocalFile`): acquire lock +
     `notifyLockChange()` so the creator holds it.

3. **Stateless no-clobber rule (replaces the localStorage migration flag).** The
   read-only bit IS the "clean copy" marker — reconciliation only ever sets a
   *synced* unlocked file read-only. So in the auto-sync partition:
   - missing locally → download.
   - present, read-only, differs from latest → clean STALE copy → refresh.
   - present, **writable**, differs from latest → possible unsaved edit →
     **held back** (never overwritten, never force-frozen), surfaced via
     `lastHeldBack`. The user resolves by checking it in or undoing.
   This protects pre-existing edits permanently (not just on a first pass) and
   needs no per-vault flag. The local scan reports each file's `readonly` bit so
   reconciliation only toggles what changed.

4. **Reconciliation** (`useAutoSync`, auto mode): locked-by-me → writable;
   unlocked-and-synced → read-only; unlocked-but-differs → left untouched (per
   the rule above). It's the self-healing safety net for drift (e.g. an admin
   force-unlock); the per-hook transitions handle the instant/manual-mode cases.
