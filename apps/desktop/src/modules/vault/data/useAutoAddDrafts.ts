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
//  - the sync ledger guard: a live (non-tombstone) entry means the file was
//    materialized FROM the vault — re-adding it would resurrect deletions in a
//    loop. A tombstone entry (deletedAt set) means the file was propagated as an
//    intentional vault-wide deletion; auto-add is suppressed during the
//    TOMBSTONE_COOLOFF_MS window so a reappearing copy is not silently re-vaulted
//    (which would undo the deletion). Past the cool-off the file is treated as
//    genuinely new and is allowed through;
//  - one failed attempt per path per RETRY_MS (no hot-loop on a bad file).

import { useEffect, useRef, useState } from "react";
import { stat } from "@tauri-apps/plugin-fs";

import { useAddLocalFile } from "./useAddLocalFile";
import { loadLedger, TOMBSTONE_COOLOFF_MS, type SyncLedger } from "./sync-ledger";
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
    const e = ledger.entries[normalizePathForCompare(f.relativePath)];
    if (e) {
      if (!e.deletedAt) return false; // materialized & live in vault — don't re-add
      // tombstone: suppress auto-add during the cool-off so a reappearing copy of
      // a just-deleted file isn't silently re-vaulted (would undo the deletion).
      // Also treat an unparseable deletedAt (NaN) as still-suppressing: a corrupt
      // tombstone is safer to hold than to silently re-vault (matches the
      // classifyMissing truthiness check which treats any truthy deletedAt as a
      // tombstone).
      const dt = new Date(e.deletedAt).getTime();
      if (Number.isNaN(dt) || now - dt < TOMBSTONE_COOLOFF_MS) return false;
      // past cool-off → fall through and allow re-add as a genuinely new file
    }
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

  // The newest unmatched list, read by an in-flight pass to skip files that
  // were matched (or changed / vanished) after the pass took its snapshot.
  const latestUnmatchedRef = useRef(unmatched);
  latestUnmatchedRef.current = unmatched;
  // Set when the effect fires while a pass is running: the pass re-checks once
  // it drains, so a file that appeared mid-pass is never stranded.
  const rerunRef = useRef(false);
  // Pass generation. ONLY a vault switch, auto-add being turned off, or unmount
  // invalidates a running pass. The `unmatched` list changing does NOT: every
  // add changes it (the realtime patch lands the new row), and cancelling on
  // that made each pass add one or two files, then restart from the top with a
  // fresh ledger load + stat of every unmatched file and a full vault refetch
  // in between. A 240-file test-data drop (2026-11-16) ran at ~10–40 s a file.
  const genRef = useRef(0);
  useEffect(() => () => { genRef.current++; }, [vaultId, enabled]);

  useEffect(() => {
    if (!enabled || !vaultId || unmatched.length === 0) return;
    if (busyRef.current) {
      rerunRef.current = true;
      return;
    }
    const gen = genRef.current;
    const isCurrent = () => genRef.current === gen;
    busyRef.current = true;
    rerunRef.current = false;

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
        if (deferredFresh && isCurrent()) {
          setTimeout(() => setTick((t) => t + 1), STABLE_AGE_MS + 500);
        }
        if (candidates.length === 0) return;

        const added: string[] = [];
        const failures: { name: string; error: string }[] = [];
        for (const f of candidates) {
          if (!isCurrent()) break;
          if (!stillUnmatched(latestUnmatchedRef.current, f)) continue;
          attemptsRef.current.set(f.relativePath, Date.now());
          setStatus((s) => ({ ...s, adding: f.basename }));
          // "auto": a huge file is left for a person to add by hand, never
          // a dialog popped up from a background job.
          const r = await addRunRef.current(vaultId, f, undefined, "auto");
          if (r.ok) added.push(f.basename);
          else failures.push({ name: f.basename, error: r.error ?? "failed" });
        }
        if (!isCurrent()) return;
        setStatus({ adding: null, failures, lastAdded: added });
        // ONE catalog/locks refetch + rescan for the whole pass, not per file.
        if (added.length > 0) onAddedRef.current();
      } finally {
        busyRef.current = false;
        if (isCurrent()) setStatus((s) => (s.adding === null ? s : { ...s, adding: null }));
        // Something changed while we were busy (new files, a vault switch, a
        // fresh tick) — look again now that we're free.
        if (rerunRef.current) {
          rerunRef.current = false;
          setTick((t) => t + 1);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, vaultId, unmatched, tick]);

  return status;
}

/**
 * Is `f` still waiting to be added, per the newest unmatched list? False once
 * the file is in the vault (matched), gone from disk, or its content changed
 * since the pass snapshot (the next pass picks up the new bytes). Exported for
 * tests.
 */
export function stillUnmatched(latest: LocalFile[], f: LocalFile): boolean {
  return latest.some((u) => u.relativePath === f.relativePath && u.sha256 === f.sha256);
}
