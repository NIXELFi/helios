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
}

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
        const e = v as { sha256?: unknown; recordedAt?: unknown };
        if (typeof e.sha256 === "string" && typeof e.recordedAt === "string") {
          out[k] = { sha256: e.sha256, recordedAt: e.recordedAt };
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
  return key in ledger.entries ? "locally-deleted" : "never-downloaded";
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

export async function loadLedger(vaultId: string): Promise<SyncLedger> {
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

// ── Convenience: chain-serialized load-modify-save (Task 6) ──────────────────

/** Per-vault promise chain so concurrent download workers can't interleave
 *  read-modify-write cycles and drop each other's records. */
const chains = new Map<string, Promise<void>>();

function enqueue(vaultId: string, work: (l: SyncLedger) => SyncLedger): Promise<void> {
  const prev = chains.get(vaultId) ?? Promise.resolve();
  const next = prev
    .catch(() => {}) // a prior failure must not stall the chain
    .then(async () => {
      const ledger = await loadLedger(vaultId);
      await saveLedger(vaultId, work(ledger));
    });
  chains.set(vaultId, next);
  return next;
}

/** Load-modify-save recording one entry, serialized per vault. Best-effort. */
export function ledgerRecord(vaultId: string, relPath: string, sha256: string): Promise<void> {
  return enqueue(vaultId, (l) => recordEntry(l, relPath, sha256));
}

/** Load-modify-save removing one entry, serialized per vault. Best-effort. */
export function ledgerRemove(vaultId: string, relPath: string): Promise<void> {
  return enqueue(vaultId, (l) => removeEntry(l, relPath));
}
