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

import { BaseDirectory, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
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
function ledgerFile(vaultId: string): string {
  return `sync-ledger-${vaultId}.json`;
}

export async function loadLedger(vaultId: string): Promise<SyncLedger> {
  try {
    const text = await readTextFile(ledgerFile(vaultId), { baseDir: BaseDirectory.AppLocalData });
    return parseLedger(text);
  } catch {
    // Missing file (first run) or read error → start fresh. Safe.
    return emptyLedger();
  }
}

export async function saveLedger(vaultId: string, ledger: SyncLedger): Promise<void> {
  try {
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

/** Load-modify-save writing a tombstone for one entry, serialized per vault.
 *  Use after a successful pdm_delete_file propagation instead of ledgerRemove so
 *  a reappearing copy of the just-deleted file is not auto-re-vaulted during the
 *  TOMBSTONE_COOLOFF_MS window. Best-effort. */
export function ledgerTombstone(vaultId: string, relPath: string): Promise<void> {
  return enqueue(vaultId, (l) => tombstoneEntry(l, relPath));
}
