import { useCallback, useEffect, useRef, useState } from "react";
import type { Folder, VaultFile, Version, Lock } from "./types";
import type { LocalFile } from "./useLocalFolderScan";
import { matchLocal } from "./local-match";
import { localDestPath } from "./folder-paths";
import { useDownloadVersion } from "./useDownloadVersion";

export interface AutoSyncStatus {
  /** True while the sync pass is running. */
  busy: boolean;
  /** Number of files downloaded in the last completed pass. */
  lastDownloaded: number;
  /** Number of files skipped in the last pass (synced, locked-by-me, no version). */
  lastSkipped: number;
  /** Number of failed downloads in the last pass. */
  lastFailed: number;
  /** ISO timestamp of the last completed pass. */
  lastRunAt: string | null;
}

/**
 * Background syncer for the Vault. Whenever vault rows or local-scan results
 * change, a pass runs that downloads every file the user hasn't locked and
 * doesn't already have at the latest version. Locked-by-me files are skipped
 * — overwriting them would clobber the user's in-progress edits.
 *
 * Re-entrancy: a pass-in-progress shadow blocks new passes from starting until
 * the current one finishes, so triggers landing in quick succession (e.g. a
 * realtime burst right after mount) don't fan out into N parallel downloads.
 */
export function useAutoSync(input: {
  enabled: boolean;
  files: VaultFile[] | null | undefined;
  localFiles: LocalFile[] | null;
  versionsByFileId: Map<string, Version[]>;
  locks: Lock[] | null | undefined;
  currentUserId: string | null | undefined;
  vaultRoot: string | null;
  folders: Folder[];
  onComplete?: () => void;
}): AutoSyncStatus {
  const {
    enabled, files, localFiles, versionsByFileId, locks,
    currentUserId, vaultRoot, folders, onComplete,
  } = input;
  const download = useDownloadVersion();
  const inFlight = useRef(false);
  const [status, setStatus] = useState<AutoSyncStatus>({
    busy: false, lastDownloaded: 0, lastSkipped: 0, lastFailed: 0, lastRunAt: null,
  });

  // Keep the latest onComplete in a ref so the run effect doesn't re-fire just
  // because the callback identity changed across renders.
  const onCompleteRef = useRef(onComplete);
  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);

  const run = useCallback(async () => {
    if (!enabled || !vaultRoot || !files || !localFiles) return;
    if (inFlight.current) return;
    inFlight.current = true;
    setStatus((s) => ({ ...s, busy: true }));

    let downloaded = 0, skipped = 0, failed = 0;
    const myLocks = new Set(
      currentUserId
        ? (locks ?? []).filter((l) => l.user_id === currentUserId).map((l) => l.file_id)
        : [],
    );

    // Partition into "needs download" vs "skip" upfront so the worker pool
    // only races on actual downloads.
    type Task = { sha: string; dest: string };
    const tasks: Task[] = [];
    for (const file of files) {
      // Don't clobber in-progress edits. If the user holds the lock, they may
      // have unsaved local changes that don't match the latest sha yet.
      if (myLocks.has(file.id)) { skipped++; continue; }
      const ver = versionsByFileId.get(file.id)?.[0];
      if (!ver) { skipped++; continue; }
      const m = matchLocal(file, localFiles, versionsByFileId, folders);
      if (m.status === "synced") { skipped++; continue; }
      tasks.push({
        sha: ver.sha256,
        dest: localDestPath(vaultRoot, file.folder_id, file.name, folders),
      });
    }

    // Worker pool: N workers pull from a shared queue. 6 matches the per-
    // origin HTTP/1.1 connection limit and keeps Supabase's storage CDN well
    // utilised without saturating it. Net effect is roughly N× faster than
    // the previous serial loop on the initial vault download.
    const CONCURRENCY = 6;
    let cursor = 0;
    async function worker() {
      while (true) {
        const i = cursor++;
        if (i >= tasks.length) return;
        const t = tasks[i]!;
        const ok = await download.run(t.sha, t.dest);
        if (ok) downloaded++; else failed++;
      }
    }
    const workerCount = Math.min(CONCURRENCY, tasks.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    setStatus({
      busy: false,
      lastDownloaded: downloaded,
      lastSkipped: skipped,
      lastFailed: failed,
      lastRunAt: new Date().toISOString(),
    });
    inFlight.current = false;
    if (downloaded > 0) onCompleteRef.current?.();
  }, [enabled, files, localFiles, versionsByFileId, locks, currentUserId, vaultRoot, folders, download]);

  // Trigger a pass whenever the inputs that affect "what's missing" change.
  useEffect(() => {
    if (!enabled) return;
    void run();
  }, [enabled, run]);

  return status;
}
