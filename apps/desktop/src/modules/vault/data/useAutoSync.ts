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
  /** Total number of files queued for download in the current pass. */
  totalTasks: number;
  /** Number of those files finished (success or fail) so far. */
  completedTasks: number;
  /** Total bytes (uncompressed source size) we plan to fetch this pass. */
  totalBytes: number;
  /** Bytes (uncompressed source size) completed so far. */
  completedBytes: number;
  /** Basenames of files currently in flight. */
  activeFiles: string[];
  /** Epoch ms when the current pass started; null when idle. */
  startedAt: number | null;
}

/**
 * Background syncer for the Vault. Whenever vault rows or local-scan results
 * change, a pass runs that downloads every file the user hasn't locked and
 * doesn't already have at the latest version. Locked-by-me files are skipped
 * — overwriting them would clobber the user's in-progress edits.
 *
 * Re-entrancy: each pass captures a "generation" id when it starts. New passes
 * can't begin while a generation is active, and any state writes from an in-
 * flight pass are gated behind a check that its captured generation still
 * matches `activeGenRef.current` — so if the trigger effect re-fires due to a
 * dep change while a run is mid-flight, the in-flight run can be effectively
 * cancelled (its remaining writes become no-ops) without aborting the actual
 * download fetch, and a fresh run is free to start. This prevents the stale-
 * closure race where an old run, holding a snapshot of versionsByFileId from
 * before the change, would otherwise commit results computed from stale data.
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

  // Monotonic generation counter. Bumped at the start of every run; the value
  // captured by a given run is checked before every state write to detect when
  // a newer generation has superseded it.
  const generationSeq = useRef(0);
  // The generation currently considered authoritative. While a run is active,
  // this equals that run's captured generation. When set to 0 there is no
  // active run. When the trigger effect supersedes an in-flight run, this is
  // either bumped (by the next run starting) or stays equal (cooldown timer
  // pending) — the in-flight run only needs `captured === activeGenRef.current`
  // to be allowed to write.
  const activeGenRef = useRef(0);

  // Monotonic counter for task ids. We use ids — not filenames — to dedupe
  // `activeFiles`: two files with the same basename in different folders are
  // two distinct tasks, and finishing one mustn't drop the other's row.
  const taskIdSeq = useRef(0);

  const [status, setStatus] = useState<AutoSyncStatus>({
    busy: false, lastDownloaded: 0, lastSkipped: 0, lastFailed: 0, lastRunAt: null,
    totalTasks: 0, completedTasks: 0, totalBytes: 0, completedBytes: 0,
    activeFiles: [], startedAt: null,
  });

  // Keep the latest onComplete in a ref so the run effect doesn't re-fire just
  // because the callback identity changed across renders.
  const onCompleteRef = useRef(onComplete);
  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);

  // Same pattern for `download.run`: useDownloadVersion's hook return changes
  // identity every time it sets internal loading/error state — and it does so
  // on every individual download. If we put `download` in `run`'s deps, the
  // useCallback churns inside the worker pool, the trigger effect re-fires
  // continuously, and BrowseScreen ends up re-rendering on every fetch tick
  // (visible as full-window jitter during sync). Refs keep both stable.
  const downloadRunRef = useRef(download.run);
  useEffect(() => { downloadRunRef.current = download.run; }, [download.run]);

  const run = useCallback(async () => {
    if (!enabled || !vaultRoot || !files || !localFiles) return;
    // Re-entrancy guard: another run is already authoritative.
    if (activeGenRef.current !== 0) return;
    const myGen = ++generationSeq.current;
    activeGenRef.current = myGen;
    // Helper: a write is only applied if our generation is still authoritative.
    // If a superseding pass has bumped activeGenRef, our partial state would
    // overwrite the newer pass's writes (or commit results from stale closure
    // data) — drop them silently.
    const isCurrent = () => activeGenRef.current === myGen;
    const guardedSet = (updater: (s: AutoSyncStatus) => AutoSyncStatus) => {
      if (!isCurrent()) return;
      setStatus((s) => (activeGenRef.current === myGen ? updater(s) : s));
    };
    guardedSet((s) => ({ ...s, busy: true }));

    let downloaded = 0, skipped = 0, failed = 0;
    const myLocks = new Set(
      currentUserId
        ? (locks ?? []).filter((l) => l.user_id === currentUserId).map((l) => l.file_id)
        : [],
    );

    // Partition into "needs download" vs "skip" upfront so the worker pool
    // only races on actual downloads. Each task gets a stable id used as the
    // dedup key in `activeFiles` — never the basename, since two files in
    // different folders can share a name.
    type Task = { id: number; sha: string; dest: string; name: string; size: number };
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
        id: ++taskIdSeq.current,
        sha: ver.sha256,
        dest: localDestPath(vaultRoot, file.folder_id, file.name, folders),
        name: file.name,
        size: ver.size_bytes,
      });
    }

    const totalBytes = tasks.reduce((sum, t) => sum + (t.size || 0), 0);
    const startedAt = Date.now();
    guardedSet((s) => ({
      ...s, busy: true, totalTasks: tasks.length, completedTasks: 0,
      totalBytes, completedBytes: 0, activeFiles: [], startedAt,
    }));

    // Track active task ids in a parallel ref so each completion can map back
    // to the right entry; we render `t.name` but key on `t.id`.
    const activeTaskIds = new Map<number, string>();

    // Worker pool: N workers pull from a shared queue. Cap at 2 because
    // each "download" is fetch + ~100 MB ArrayBuffer through gunzip + Tauri
    // writeFile IPC — pushing 6 of those at once saturates the webview
    // bridge and freezes the UI even with native DecompressionStream off-
    // thread. 2 keeps the CDN warm while leaving headroom for paint frames.
    const CONCURRENCY = 2;
    let cursor = 0;
    async function worker() {
      while (true) {
        if (!isCurrent()) return; // superseded — drop remaining work.
        const i = cursor++;
        if (i >= tasks.length) return;
        const t = tasks[i]!;
        activeTaskIds.set(t.id, t.name);
        guardedSet((s) => ({ ...s, activeFiles: [...s.activeFiles, t.name] }));
        const ok = await downloadRunRef.current(t.sha, t.dest);
        // Count outcomes locally even if we're superseded, so the run's local
        // totals stay consistent — they just won't reach state.
        if (ok) downloaded++; else failed++;
        activeTaskIds.delete(t.id);
        // Rebuild activeFiles from the still-active id set so a worker
        // finishing "x.sldprt" doesn't drop the other worker's identically-
        // named entry from a different folder.
        const stillActive = Array.from(activeTaskIds.values());
        guardedSet((s) => ({
          ...s,
          activeFiles: stillActive,
          completedTasks: s.completedTasks + 1,
          completedBytes: s.completedBytes + (ok ? t.size : 0),
        }));
      }
    }
    const workerCount = Math.min(CONCURRENCY, tasks.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    // Final commit — only if we're still the authoritative generation. If a
    // newer run took over (e.g. deps changed mid-pass), the new run owns the
    // status and will publish its own results.
    if (isCurrent()) {
      setStatus((s) => ({
        ...s,
        busy: false,
        lastDownloaded: downloaded,
        lastSkipped: skipped,
        lastFailed: failed,
        lastRunAt: new Date().toISOString(),
        activeFiles: [],
      }));
      activeGenRef.current = 0;
      lastFinishedAt.current = Date.now();
      if (downloaded > 0) onCompleteRef.current?.();
    }
  }, [enabled, files, localFiles, versionsByFileId, locks, currentUserId, vaultRoot, folders]);

  // Cooldown: at least this many ms between the end of one pass and the start
  // of the next. Stops dependency churn / rescan-after-pass / realtime ticks
  // from spinning the worker at full speed when the vault is already in sync.
  const COOLDOWN_MS = 2000;
  const lastFinishedAt = useRef(0);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Trigger a pass whenever the inputs that affect "what's missing" change.
  // We coalesce rapid trigger storms by debouncing through a single timer
  // and deferring until the cooldown has elapsed since the last completion.
  //
  // Generation/race interaction: if a run is in flight when this effect re-
  // fires (because `run` got a new identity from changed deps), we supersede
  // it by zeroing `activeGenRef` — the in-flight run's `isCurrent()` will
  // start returning false, dropping its remaining writes — and schedule a
  // fresh pass that captures the new dep snapshot.
  useEffect(() => {
    if (!enabled) return;
    // Supersede any in-flight generation: the closure inside that run holds
    // stale deps, so its writes from this point on must not land.
    if (activeGenRef.current !== 0) {
      activeGenRef.current = 0;
    }
    if (pending.current) return; // already scheduled
    const wait = Math.max(0, COOLDOWN_MS - (Date.now() - lastFinishedAt.current));
    pending.current = setTimeout(() => {
      pending.current = null;
      void run();
    }, wait);
    return () => {
      if (pending.current) {
        clearTimeout(pending.current);
        pending.current = null;
      }
    };
  }, [enabled, run]);

  return status;
}
