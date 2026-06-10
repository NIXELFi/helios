// SW-PDM-style automatic vaulting of new local files. In SolidWorks PDM you
// don't click "add to vault" — saving a file inside the vault folder puts it
// in the vault as a private, checked-out draft (invisible to everyone else
// until first check-in). This hook watches the unmatched-local list and runs
// the existing add flow (useAddLocalFile → pdm_add_and_lock: atomic file row +
// version 1 + lock, published_at null = private draft) automatically.
//
// Guards (selectAutoAddCandidates, pure + unit-tested):
//  - scan must have hashed the file (sha256 present) — also implies the walk
//    saw a complete file, and the `~$` SolidWorks sidecars never reach us
//    (the scanner skips them);
//  - the file must be STABLE: mtime older than STABLE_AGE_MS, so a CAD save
//    still streaming to disk isn't vaulted half-written;
//  - the sync ledger must have NO entry for the path: a ledgered file was
//    materialized FROM the vault (a deleted file awaiting the reaper, or a
//    discarded draft) — re-adding it would resurrect deletions in a loop;
//  - one failed attempt per path per RETRY_MS (no hot-loop on a bad file).

import { useEffect, useRef, useState } from "react";
import { stat } from "@tauri-apps/plugin-fs";

import { useAddLocalFile } from "./useAddLocalFile";
import { loadLedger, type SyncLedger } from "./sync-ledger";
import { normalizePathForCompare } from "./local-match";
import type { LocalFile } from "./useLocalFolderScan";
import type { VaultId } from "./types";

export const STABLE_AGE_MS = 5_000;
const RETRY_MS = 5 * 60_000;

/** Pure candidate filter — exported for tests. `mtimes` maps relativePath →
 *  mtime epoch-ms (null/missing = unknown → treated as too fresh). */
export function selectAutoAddCandidates(
  unmatched: LocalFile[],
  ledger: SyncLedger,
  mtimes: Map<string, number | null>,
  attempts: Map<string, number>,
  now: number,
): LocalFile[] {
  return unmatched.filter((f) => {
    if (!f.sha256) return false;
    const mtime = mtimes.get(f.relativePath);
    if (mtime == null || now - mtime < STABLE_AGE_MS) return false;
    if (ledger.entries[normalizePathForCompare(f.relativePath)]) return false;
    const lastTry = attempts.get(f.relativePath);
    if (lastTry != null && now - lastTry < RETRY_MS) return false;
    return true;
  });
}

export interface AutoAddStatus {
  /** File currently being added (basename), null when idle. */
  adding: string | null;
  /** Paths that failed their last attempt, with the error. */
  failures: { name: string; error: string }[];
  /** Names added as drafts in the most recent batch (for a passive toast). */
  lastAdded: string[];
}

export function useAutoAddDrafts(opts: {
  vaultId: VaultId | undefined;
  enabled: boolean;
  unmatched: LocalFile[];
  onAdded: () => void;
}): AutoAddStatus {
  const { vaultId, enabled, unmatched, onAdded } = opts;
  const addFile = useAddLocalFile();
  const [status, setStatus] = useState<AutoAddStatus>({ adding: null, failures: [], lastAdded: [] });
  const busyRef = useRef(false);
  const attemptsRef = useRef<Map<string, number>>(new Map());
  const onAddedRef = useRef(onAdded);
  useEffect(() => { onAddedRef.current = onAdded; }, [onAdded]);
  const addRunRef = useRef(addFile.run);
  useEffect(() => { addRunRef.current = addFile.run; }, [addFile.run]);
  // Files skipped only because they were too FRESH need a re-check after the
  // stability window — nothing else re-triggers the effect for them.
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled || !vaultId || unmatched.length === 0 || busyRef.current) return;
    let cancelled = false;
    busyRef.current = true;

    void (async () => {
      try {
        const ledger = await loadLedger(vaultId);
        const mtimes = new Map<string, number | null>();
        for (const f of unmatched) {
          try {
            const info = await stat(f.absolutePath);
            mtimes.set(f.relativePath, info.mtime ? info.mtime.getTime() : null);
          } catch {
            mtimes.set(f.relativePath, null); // gone/unreadable → not a candidate
          }
        }
        const now = Date.now();
        const candidates = selectAutoAddCandidates(
          unmatched, ledger, mtimes, attemptsRef.current, now,
        );
        const deferredFresh = unmatched.some((f) => {
          const m = mtimes.get(f.relativePath);
          return f.sha256 && m != null && now - m < STABLE_AGE_MS;
        });
        if (deferredFresh && !cancelled) {
          setTimeout(() => setTick((t) => t + 1), STABLE_AGE_MS + 500);
        }
        if (candidates.length === 0) return;

        const added: string[] = [];
        const failures: { name: string; error: string }[] = [];
        for (const f of candidates) {
          if (cancelled) break;
          attemptsRef.current.set(f.relativePath, Date.now());
          setStatus((s) => ({ ...s, adding: f.basename }));
          const r = await addRunRef.current(vaultId, f);
          if (r.ok) added.push(f.basename);
          else failures.push({ name: f.basename, error: r.error ?? "failed" });
        }
        setStatus({ adding: null, failures, lastAdded: added });
        if (added.length > 0) onAddedRef.current();
      } finally {
        busyRef.current = false;
        if (!cancelled) setStatus((s) => (s.adding === null ? s : { ...s, adding: null }));
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, vaultId, unmatched, tick]);

  return status;
}
