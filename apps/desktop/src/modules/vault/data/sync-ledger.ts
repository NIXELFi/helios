// Per-vault sync ledger: a record of which vault files THIS machine has
// materialized locally, keyed by normalized vault-relative path. It lets the
// auto-sync pass tell three cases apart for a file that's in the vault but not
// found on disk:
//   - in the ledger        → we DID download it ⇒ the user deleted it locally
//   - NOT in the ledger    → we never downloaded it ⇒ leave it (vault-only)
// The ledger lives OUTSIDE the vault root (under %LOCALAPPDATA%) so it survives
// vault-root moves and never shows up as an untracked file in a scan.
//
// Split into a pure core (no Tauri, fully unit-testable) and a thin best-effort
// IO half. The IO half must never throw into the sync pass — a missing or
// corrupt ledger degrades to "we've downloaded nothing", which is safe (it only
// means we won't propagate a local deletion until the file is re-materialized).

import { BaseDirectory, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { normalizePathForCompare } from "./local-match";

export interface LedgerEntry {
  sha256: string;
  recordedAt: string;
  /** ISO timestamp set when this path was propagated as a soft-delete (tombstone).
   *  Presence means the file was intentionally deleted vault-wide from this machine.
   *  Used to suppress auto-re-add during the cool-off window so a reappearing copy
   *  of a just-deleted file is never silently re-vaulted (which would undo the deletion). */
  deletedAt?: string;
}

/** How long (ms) a tombstone suppresses auto-add after a propagated deletion. 7 days. */
export const TOMBSTONE_COOLOFF_MS = 7 * 24 * 60 * 60 * 1000;

export interface SyncLedger {
  /** relPath (normalized via normalizePathForCompare) → entry. */
  entries: Record<string, LedgerEntry>;
}

export type MissingClass = "present" | "locally-deleted" | "never-downloaded";

// ── Pure core ──────────────────────────────────────────────────────────────

export function emptyLedger(): SyncLedger {
  return { entries: {} };
}

/** Record that `relPath` was materialized locally at content `sha256`.
 *  Returns a NEW ledger (never mutates). Key is normalized for compare. */
export function recordEntry(ledger: SyncLedger, relPath: string, sha256: string): SyncLedger {
  const key = normalizePathForCompare(relPath);
  return {
    entries: { ...ledger.entries, [key]: { sha256, recordedAt: new Date().toISOString() } },
  };
}

/** Remove `relPath` from the ledger. Returns a NEW ledger. */
export function removeEntry(ledger: SyncLedger, relPath: string): SyncLedger {
  const key = normalizePathForCompare(relPath);
  const next = { ...ledger.entries };
  delete next[key];
  return { entries: next };
}

/** Mark `relPath` as a tombstone: the file was propagated as a vault-wide soft-delete.
 *  Preserves the existing sha256/recordedAt if an entry already exists (so the stamp
 *  survives for diagnostics). Returns a NEW ledger (never mutates). The tombstone
 *  suppresses auto-add during TOMBSTONE_COOLOFF_MS so a reappearing copy of the
 *  just-deleted file is never silently re-vaulted — which would undo the deletion. */
export function tombstoneEntry(ledger: SyncLedger, relPath: string): SyncLedger {
  const key = normalizePathForCompare(relPath);
  const existing = ledger.entries[key];
  const now = new Date().toISOString();
  return {
    entries: {
      ...ledger.entries,
      [key]: {
        sha256: existing?.sha256 ?? "",
        recordedAt: existing?.recordedAt ?? now,
        deletedAt: now,
      },
    },
  };
}

/** Parse ledger JSON, returning an empty ledger on any parse/shape error so a
 *  truncated or hand-corrupted file can never crash the sync pass. */
export function parseLedger(text: string): SyncLedger {
  try {
    const obj = JSON.parse(text) as unknown;
    if (!obj || typeof obj !== "object") return emptyLedger();
    const entries = (obj as { entries?: unknown }).entries;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) return emptyLedger();
    const out: Record<string, LedgerEntry> = {};
    for (const [k, v] of Object.entries(entries as Record<string, unknown>)) {
      if (v && typeof v === "object") {
        const e = v as { sha256?: unknown; recordedAt?: unknown; deletedAt?: unknown };
        if (typeof e.sha256 === "string" && typeof e.recordedAt === "string") {
          const entry: LedgerEntry = { sha256: e.sha256, recordedAt: e.recordedAt };
          // Only carry deletedAt through if it's a string (tombstone marker).
          if (typeof e.deletedAt === "string") entry.deletedAt = e.deletedAt;
          out[k] = entry;
        }
      }
    }
    return { entries: out };
  } catch {
    return emptyLedger();
  }
}

/** Classify a vault file that may or may not be present on disk. */
export function classifyMissing(
  ledger: SyncLedger,
  relPath: string,
  presentLocally: boolean,
): MissingClass {
  if (presentLocally) return "present";
  const key = normalizePathForCompare(relPath);
  const e = ledger.entries[key];
  if (!e) return "never-downloaded";
  // A tombstone means the file was already propagated as an intentional vault-wide
  // deletion. Never re-classify it as "locally-deleted" (which would re-propagate
  // or re-download it); treat it as never-downloaded so the auto-sync pass ignores it.
  if (e.deletedAt) return "never-downloaded";
  return "locally-deleted";
}

// ── IO half (best-effort; never throws) ──────────────────────────────────────

// `BaseDirectory.AppLocalData` resolves to the app's per-identifier folder
// under %LOCALAPPDATA% (e.g. %LOCALAPPDATA%\<bundle-identifier>) — NOT
// necessarily ...\Helios. That's fine: the ledger only needs a stable
// per-machine home outside the vault root, and AppLocalData provides one.
//
// Ledgers live in a `sync-ledgers/` subdir so saveLedger can `mkdir` it with
// `recursive: true` and be guaranteed the whole path exists. The AppLocalData
// folder itself may not exist yet (a fresh profile, or nothing else has written
// there this session), and Tauri's writeTextFile does NOT create parent dirs —
// which surfaced as intermittent `saveLedger failed: ... No such file or
// directory (os error 2)`.
const LEDGER_DIR = "sync-ledgers";
function ledgerFile(vaultId: string): string {
  return `${LEDGER_DIR}/sync-ledger-${vaultId}.json`;
}
// Pre-subdir ledgers sat directly under AppLocalData. Read them as a fallback so
// the move doesn't silently reset every machine's deletion-detection.
function legacyLedgerFile(vaultId: string): string {
  return `sync-ledger-${vaultId}.json`;
}

/** Drop tombstones whose cool-off has expired. Mutates `ledger` in place and
 *  returns how many were pruned. An expired tombstone behaves exactly like no
 *  entry at all (classifyMissing → "never-downloaded", auto-add allowed, the
 *  reaper skips it), so pruning is behavior-neutral — it just stops the ledger
 *  growing forever. An UNPARSEABLE deletedAt is kept: useAutoAddDrafts treats it
 *  as still-suppressing, and dropping it would re-allow an auto-add. */
export function pruneExpiredTombstones(ledger: SyncLedger, now: number = Date.now()): number {
  let pruned = 0;
  for (const [k, e] of Object.entries(ledger.entries)) {
    if (!e.deletedAt) continue;
    const dt = new Date(e.deletedAt).getTime();
    if (Number.isNaN(dt)) continue;
    if (now - dt >= TOMBSTONE_COOLOFF_MS) {
      delete ledger.entries[k];
      pruned++;
    }
  }
  return pruned;
}

async function readLedgerFromDisk(vaultId: string): Promise<SyncLedger> {
  for (const file of [ledgerFile(vaultId), legacyLedgerFile(vaultId)]) {
    try {
      const text = await readTextFile(file, { baseDir: BaseDirectory.AppLocalData });
      return parseLedger(text);
    } catch {
      // Missing/unreadable at this path → try the legacy path, then start fresh.
    }
  }
  // Missing file (first run) or read error → start fresh. Safe.
  return emptyLedger();
}

export async function saveLedger(vaultId: string, ledger: SyncLedger): Promise<void> {
  try {
    // Ensure the directory exists first — recursive creates AppLocalData itself
    // if missing, and is a no-op when it's already there. Without this the write
    // intermittently fails with ENOENT (os error 2) on the not-yet-created dir.
    await mkdir(LEDGER_DIR, { baseDir: BaseDirectory.AppLocalData, recursive: true });
    await writeTextFile(ledgerFile(vaultId), JSON.stringify(ledger), {
      baseDir: BaseDirectory.AppLocalData,
    });
  } catch (e) {
    // Best-effort: a write failure just means deletion-detection lags a pass.
    console.warn("saveLedger failed:", e);
  }
}

// ── In-memory ledger + coalesced writes (Task 6) ─────────────────────────────
//
// Each vault's ledger is read from disk ONCE per session and then kept in
// memory. Mutations (ledgerRecord / ledgerRemove / ledgerTombstone) apply to
// that copy in place and mark it dirty; a debounced flush writes the whole file.
// The old load-parse-spread-stringify-write per call made a bulk sync O(n^2)
// (every one of ~13k downloads re-read and re-wrote the entire ledger).
//
// Ordering guarantees kept from the old chain-serialized load-modify-save:
//  - mutations for a vault apply strictly in call order (per-vault `chains`),
//    so concurrent download workers can't drop each other's records;
//  - disk writes for a vault are serialized (per-vault `writes`) and each one
//    serializes the CURRENT in-memory state, so a later write is always a
//    superset of an earlier one — an older snapshot can never land last.
// loadLedger serves the in-memory copy, so a pass never reads a disk file that
// lags a not-yet-flushed record.
//
// Durability: writes are debounced (FLUSH_DEBOUNCE_MS after the last change)
// but never deferred past FLUSH_MAX_WAIT_MS during a continuous stream, and are
// forced on pass/bulk completion (flushLedger) and on page unload. A crash can
// lose at most the last few seconds of records, which degrades exactly like a
// failed write always did: deletion-detection lags until re-materialization.

export const FLUSH_DEBOUNCE_MS = 500;
export const FLUSH_MAX_WAIT_MS = 5_000;

/** vaultId → the session's owned ledger (loaded once, mutated in place). */
const owned = new Map<string, Promise<SyncLedger>>();
/** Per-vault promise chain serializing mutations. */
const chains = new Map<string, Promise<void>>();
/** Per-vault promise chain serializing disk writes. */
const writes = new Map<string, Promise<void>>();

interface FlushState {
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** When the current dirty streak began (for the max-wait cap). */
  since: number;
}
const flushStates = new Map<string, FlushState>();

function ownedLedger(vaultId: string): Promise<SyncLedger> {
  let p = owned.get(vaultId);
  if (!p) {
    p = readLedgerFromDisk(vaultId).then((l) => {
      // Expired tombstones are dead weight; persist the pruned file lazily.
      if (pruneExpiredTombstones(l) > 0) markDirty(vaultId);
      return l;
    });
    owned.set(vaultId, p);
  }
  return p;
}

/** Load this vault's ledger. Returns a snapshot COPY of the in-memory ledger
 *  (disk is read only on first use per session), so a caller can hold it for a
 *  whole pass without later records mutating it underneath. Never throws: a
 *  missing/corrupt file degrades to an empty ledger. */
export async function loadLedger(vaultId: string): Promise<SyncLedger> {
  const l = await ownedLedger(vaultId);
  return { entries: { ...l.entries } };
}

function markDirty(vaultId: string): void {
  let s = flushStates.get(vaultId);
  if (!s) {
    s = { dirty: false, timer: null, since: 0 };
    flushStates.set(vaultId, s);
  }
  const state = s;
  const now = Date.now();
  if (!state.dirty) state.since = now;
  state.dirty = true;
  if (state.timer) clearTimeout(state.timer);
  // Debounce, capped so a continuous stream still reaches disk every max-wait.
  const delay = Math.max(0, Math.min(FLUSH_DEBOUNCE_MS, state.since + FLUSH_MAX_WAIT_MS - now));
  state.timer = setTimeout(() => {
    state.timer = null;
    void flushLedger(vaultId);
  }, delay);
}

function enqueue(vaultId: string, mutate: (l: SyncLedger) => void): Promise<void> {
  const prev = chains.get(vaultId) ?? Promise.resolve();
  const next = prev
    .catch(() => {}) // a prior failure must not stall the chain
    .then(async () => {
      const ledger = await ownedLedger(vaultId);
      mutate(ledger);
      markDirty(vaultId);
    });
  chains.set(vaultId, next);
  return next;
}

/** Write this vault's pending ledger changes to disk now (after any mutations
 *  already queued). Resolves once the write has landed (or failed — best-effort,
 *  never throws). A no-op when nothing is dirty. Call at the end of a pass. */
export async function flushLedger(vaultId: string): Promise<void> {
  await (chains.get(vaultId) ?? Promise.resolve()).catch(() => {});
  const s = flushStates.get(vaultId);
  if (s?.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  if (s?.dirty) {
    s.dirty = false;
    const prev = writes.get(vaultId) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        const ledger = await ownedLedger(vaultId);
        await saveLedger(vaultId, ledger);
      });
    writes.set(vaultId, next);
  }
  await (writes.get(vaultId) ?? Promise.resolve()).catch(() => {});
}

/** Flush every vault with pending changes (unload / shutdown). */
export function flushAllLedgers(): Promise<void> {
  const ids = Array.from(flushStates.entries())
    .filter(([, s]) => s.dirty)
    .map(([id]) => id);
  return Promise.all(ids.map((id) => flushLedger(id))).then(() => {});
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  // Best-effort: the async write may not finish if the webview is torn down,
  // but the max-wait cap bounds what can be lost either way.
  window.addEventListener("pagehide", () => void flushAllLedgers());
  window.addEventListener("beforeunload", () => void flushAllLedgers());
}

/** Test-only: forget all in-memory ledgers, pending timers and chains. */
export function __resetLedgerCacheForTests(): void {
  for (const s of flushStates.values()) if (s.timer) clearTimeout(s.timer);
  flushStates.clear();
  owned.clear();
  chains.clear();
  writes.clear();
}

/** Record one materialized entry, serialized per vault (in memory now, on disk
 *  at the next flush). Best-effort. Same entry shape as recordEntry. */
export function ledgerRecord(vaultId: string, relPath: string, sha256: string): Promise<void> {
  return enqueue(vaultId, (l) => {
    l.entries[normalizePathForCompare(relPath)] = {
      sha256,
      recordedAt: new Date().toISOString(),
    };
  });
}

/** Remove one entry, serialized per vault. Best-effort. */
export function ledgerRemove(vaultId: string, relPath: string): Promise<void> {
  return enqueue(vaultId, (l) => {
    delete l.entries[normalizePathForCompare(relPath)];
  });
}

/** Write a tombstone for one entry, serialized per vault. Same entry shape as
 *  tombstoneEntry. Use after a successful pdm_delete_file propagation instead of
 *  ledgerRemove so a reappearing copy of the just-deleted file is not
 *  auto-re-vaulted during the TOMBSTONE_COOLOFF_MS window. Best-effort. */
export function ledgerTombstone(vaultId: string, relPath: string): Promise<void> {
  return enqueue(vaultId, (l) => {
    const key = normalizePathForCompare(relPath);
    const existing = l.entries[key];
    const now = new Date().toISOString();
    l.entries[key] = {
      sha256: existing?.sha256 ?? "",
      recordedAt: existing?.recordedAt ?? now,
      deletedAt: now,
    };
  });
}
