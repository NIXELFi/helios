import { useCallback, useEffect, useRef, useState } from "react";
import type { Folder, VaultFile, Version, Lock } from "./types";
import type { LocalFile } from "./useLocalFolderScan";
import { matchLocal, vaultRelativePath } from "./local-match";
import { localDestPath } from "./folder-paths";
import { useDownloadVersion } from "./useDownloadVersion";
import { setReadonly } from "./fs-readonly";
import { ensureLocalFolderTree } from "./ensureLocalFolderTree";
import {
  classifyMissing,
  emptyLedger,
  ledgerRecord,
  ledgerRemove,
  loadLedger,
} from "./sync-ledger";
import {
  notifyLocalDeleteBlocked,
  notifyLocalDeletesPropagated,
} from "./local-delete-events";
import { useSupabaseClient } from "@helios/auth";

export interface AutoSyncStatus {
  /** True while the sync pass is running. */
  busy: boolean;
  /** Number of files downloaded in the last completed pass. */
  lastDownloaded: number;
  /** Number of files skipped in the last pass (synced, locked-by-me, no version). */
  lastSkipped: number;
  /** Number of failed downloads in the last pass. */
  lastFailed: number;
  /** Files held back on the first (migration) pass because they had local
   *  changes and weren't checked out — left untouched so unsaved work isn't
   *  clobbered. Surfaced so the user can check them in or discard. */
  lastHeldBack: number;
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
 * — overwriting them would clobber the user's in-progress edits. Each pass also
 * materializes the full vault folder scaffolding locally (empty folders
 * included) via ensureLocalFolderTree so the local tree mirrors the vault.
 *
 * Local-deletion detection (spec 2c) is the THIRD bucket each pass partitions
 * into, alongside "download" and "skip". For a file that's live in the vault
 * but missing from the local scan, the per-vault sync ledger tells us whether
 * THIS machine ever materialized it:
 *   - locked-by-me + in-ledger + gone from disk → the user deleted their
 *     checked-out copy ⇒ propagate as a soft-delete (pdm_delete_file) and drop
 *     the ledger entry. Surfaced via notifyLocalDeletesPropagated.
 *   - NOT locked + in-ledger + gone from disk → the user deleted a copy they
 *     weren't checked out for ⇒ re-download it (restoring it) AND warn once via
 *     notifyLocalDeleteBlocked. The re-download's own ledgerRecord (below)
 *     refreshes the stamp, so the NEXT pass classifies it "present" — one
 *     warning per deletion, not one per sync pass.
 *   - in-vault + NOT in ledger + gone → never downloaded here ⇒ a normal
 *     download (vault-only), untouched by deletion logic.
 * The ledger is also RECORDED into on every successful download below so these
 * classifications stay accurate. All of this is gated on a non-null vaultId; an
 * empty/missing ledger degrades to "we've downloaded nothing", which can only
 * cause redundant re-downloads, never a false vault delete.
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
  /** Active vault id. Required for ledger recording + local-deletion detection;
   *  null disables both (the pass still downloads + reconciles as before). */
  vaultId: string | null;
  onComplete?: () => void;
}): AutoSyncStatus {
  const {
    enabled, files, localFiles, versionsByFileId, locks,
    currentUserId, vaultRoot, folders, vaultId, onComplete,
  } = input;
  const download = useDownloadVersion();
  // Used to propagate local deletions of checked-out files (pdm_delete_file).
  const client = useSupabaseClient();

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
  // AbortController for the currently-running generation. Supersession (the
  // trigger effect re-firing while a run is in flight, or unmount) calls
  // abort() so any in-flight downloadVersionOnce stops short of writing its
  // bytes to disk. Without this the post-fetch writeFile of a superseded run
  // could clobber the new run's freshly-written file (torn-write race).
  const activeAbortRef = useRef<AbortController | null>(null);

  // Monotonic counter for task ids. We use ids — not filenames — to dedupe
  // `activeFiles`: two files with the same basename in different folders are
  // two distinct tasks, and finishing one mustn't drop the other's row.
  const taskIdSeq = useRef(0);

  const [status, setStatus] = useState<AutoSyncStatus>({
    busy: false, lastDownloaded: 0, lastSkipped: 0, lastFailed: 0, lastHeldBack: 0, lastRunAt: null,
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

  // LIVE view of the files the current user has locked. The pass partitions
  // tasks against a myLocks snapshot taken at pass start; if the user checks a
  // file out while the pass is in flight, the snapshot is stale and an
  // already-queued download could land stale bytes (and a read-only freeze) on
  // a file they now hold. Workers re-check THIS ref right before downloading
  // and before freezing, closing that window (the supersede/abort path remains
  // as the second line of defense).
  const myLocksLiveRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    myLocksLiveRef.current = new Set(
      currentUserId
        ? (locks ?? []).filter((l) => l.user_id === currentUserId).map((l) => l.file_id)
        : [],
    );
  }, [locks, currentUserId]);

  const run = useCallback(async () => {
    if (!enabled || !vaultRoot || !files || !localFiles) return;
    // Vault-switch race guard: on an active-vault change, vaultRoot updates
    // synchronously (derived from the vault name) while files/folders keep the
    // PREVIOUS vault's rows until their refetches land. A pass in that window
    // would materialize vault A's folder tree (and write file downloads) into
    // vault B's local dir. Skip until every row matches; the dep-change when
    // the fresh data lands re-triggers a clean pass.
    if (vaultId && (files.some((f) => f.vault_id !== vaultId) || folders.some((f) => f.vault_id !== vaultId))) {
      return;
    }
    // Re-entrancy guard: another run is already authoritative.
    if (activeGenRef.current !== 0) return;
    const myGen = ++generationSeq.current;
    activeGenRef.current = myGen;
    // Fresh AbortController for this generation. Aborting it interrupts the
    // download path before its terminal writeFile.
    const myAbort = new AbortController();
    activeAbortRef.current = myAbort;
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

    // Materialize the vault's folder scaffolding locally (empty folders too) so
    // the local tree mirrors the vault before any file download. Best-effort.
    await ensureLocalFolderTree(folders, vaultRoot);

    let downloaded = 0, skipped = 0, failed = 0;
    const myLocks = new Set(
      currentUserId
        ? (locks ?? []).filter((l) => l.user_id === currentUserId).map((l) => l.file_id)
        : [],
    );
    // Files we won't overwrite because the local copy could be unsaved work
    // (writable + unlocked + differs from latest). Surfaced via lastHeldBack.
    const heldBack: string[] = [];

    // Local-deletion ledger, loaded ONCE per pass (best-effort; empty when no
    // vaultId or on any IO error). Drives the third partition bucket below.
    const ledger = vaultId ? await loadLedger(vaultId) : emptyLedger();
    // Checked-out files the user deleted locally → propagate as a soft-delete
    // AFTER the worker pool settles (sequential pdm_delete_file calls).
    const toPropagate: Array<{ fileId: string; name: string; rel: string }> = [];
    // Non-checked-out files the user deleted locally → re-downloaded below AND
    // warned about once (the re-download's ledgerRecord refreshes the stamp).
    const deleteBlocked: string[] = [];

    // Partition into "needs download" vs "skip" upfront so the worker pool
    // only races on actual downloads. Each task gets a stable id used as the
    // dedup key in `activeFiles` — never the basename, since two files in
    // different folders can share a name. `relPath`/`vaultId` ride along so the
    // worker can record a successful download in the sync ledger (T6).
    type Task = {
      id: number; fileId: string; sha: string; dest: string; name: string; size: number;
      relPath: string; vaultId: string | null;
    };
    const tasks: Task[] = [];
    for (const file of files) {
      // Don't clobber in-progress edits. If the user holds the lock, they may
      // have unsaved local changes that don't match the latest sha yet — EXCEPT
      // when the ledger shows we materialized it and it's now gone from disk,
      // which means the user deleted their checked-out copy: propagate it as a
      // soft-delete (spec 2c). Either way the file is skipped from downloading.
      if (myLocks.has(file.id)) {
        if (vaultId) {
          const m0 = matchLocal(file, localFiles, versionsByFileId, folders);
          const rel = vaultRelativePath(file, folders);
          if (!m0.local && classifyMissing(ledger, rel, false) === "locally-deleted") {
            toPropagate.push({ fileId: file.id, name: file.name, rel });
          }
        }
        skipped++;
        continue;
      }
      const ver = versionsByFileId.get(file.id)?.[0];
      if (!ver) { skipped++; continue; }
      const m = matchLocal(file, localFiles, versionsByFileId, folders);
      if (m.status === "synced") { skipped++; continue; }
      // Third bucket (spec 2c), NOT-locked side: the vault has it, the ledger
      // says we materialized it locally, but the scan can't find it ⇒ the user
      // deleted a copy they weren't checked out for. We re-download it (the task
      // push below restores it) AND warn once — the worker's ledgerRecord
      // refreshes the stamp so the next pass sees a fresh materialization, not a
      // repeat deletion (warn-once). m.status === "vault-only" ⇒ !m.local.
      if (vaultId && m.status === "vault-only") {
        const rel = vaultRelativePath(file, folders);
        if (classifyMissing(ledger, rel, false) === "locally-deleted") {
          deleteBlocked.push(file.name);
        }
      }
      // Present locally but differs from the latest version. The read-only bit
      // is our "clean copy" marker (reconciliation only ever sets a SYNCED file
      // read-only), so:
      //   - read-only local copy  → a clean, un-edited copy that's now stale
      //     (a newer version landed) → safe to refresh (download overwrites it;
      //     the download clears the read-only bit first, then reconciliation
      //     re-applies it).
      //   - writable local copy   → a possible unsaved local edit (predates the
      //     read-only model, or the user cleared the bit) → DON'T clobber it.
      //     Hold it back and surface it; the user resolves by checking it in or
      //     discarding (undo check-out). A missing file (no m.local) downloads.
      if (m.local && m.local.readonly !== true) {
        heldBack.push(file.name);
        skipped++;
        continue;
      }
      tasks.push({
        id: ++taskIdSeq.current,
        fileId: file.id,
        sha: ver.sha256,
        dest: localDestPath(vaultRoot, file.folder_id, file.name, folders),
        name: file.name,
        size: ver.size_bytes,
        relPath: vaultRelativePath(file, folders),
        vaultId,
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

    // Worker pool: N workers pull from a shared queue. Each "download" is
    // fetch + ArrayBuffer through gunzip + Tauri writeFile IPC. The cap
    // used to be 2 — that was conservative for paint-frame headroom while
    // the user was actively browsing. With v3.5.10's inline sync status
    // (the user can see what's downloading without the popover open), the
    // throughput trade-off is worth it. 4 is steady on Apple-Silicon
    // laptops and finishes typical syncs noticeably faster; can be dialed
    // back if older hardware shows UI jank.
    const CONCURRENCY = 4;
    let cursor = 0;
    async function worker() {
      while (true) {
        if (!isCurrent()) return; // superseded — drop remaining work.
        const i = cursor++;
        if (i >= tasks.length) return;
        const t = tasks[i]!;
        // The user checked this file out AFTER the pass partitioned → the
        // queued download would clobber their fresh copy with this pass's
        // (possibly stale) idea of latest, then freeze it. Skip it; the lock
        // change has already re-triggered a pass that will reconcile.
        if (myLocksLiveRef.current.has(t.fileId)) { skipped++; continue; }
        activeTaskIds.set(t.id, t.name);
        guardedSet((s) => ({ ...s, activeFiles: [...s.activeFiles, t.name] }));
        const ok = await downloadRunRef.current(t.sha, t.dest, myAbort.signal);
        // Freeze the just-downloaded file read-only immediately. Auto-sync only
        // ever downloads clean vault copies — files the user has locked/edited
        // are held back earlier in this same pass — so freezing here is always
        // safe and closes the window where a fresh download is briefly writable
        // before the post-pass reconciliation loop runs. Best-effort: a chmod
        // failure must never flip ok/failed or abort the pass.
        if (ok && !myLocksLiveRef.current.has(t.fileId)) {
          try {
            await setReadonly(t.dest, true);
          } catch {
            // chmod failed (permission / platform); reconciliation will retry.
          }
          // Record the materialization in the sync ledger so a later local
          // delete of this file is distinguishable from "never downloaded"
          // (T6). Fire-and-forget + serialized per vault inside ledgerRecord;
          // a ledger IO failure must never affect the download outcome. This
          // is ALSO what gives the third bucket warn-once semantics: a
          // re-download of a `deleteBlocked` file refreshes its stamp here.
          if (t.vaultId) void ledgerRecord(t.vaultId, t.relPath, t.sha);
        }
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
    try {
      await Promise.all(Array.from({ length: workerCount }, () => worker()));

      // Reconcile OS read-only bits to lock state (real-vault invariant): a
      // local file is writable iff the current user holds its lock; otherwise
      // read-only. This is what makes check-out → writable and check-in / undo
      // → read-only work — those mutate `locks`, which re-triggers a pass. We
      // only toggle files whose current bit differs (from the scan), so steady
      // state does zero IPC. Files downloaded THIS pass aren't in `localFiles`
      // yet; the post-download rescan re-triggers a pass that reconciles them.
      if (isCurrent() && localFiles) {
        for (const file of files) {
          if (!isCurrent()) break;
          const m = matchLocal(file, localFiles, versionsByFileId, folders);
          if (!m.local) continue; // not present locally → nothing to chmod
          const lockedByMe = myLocks.has(file.id);
          const currentlyReadonly = m.local.readonly === true;
          if (lockedByMe) {
            // Checked out by me → must be writable so I can edit.
            if (currentlyReadonly) await setReadonly(m.local.absolutePath, false);
          } else if (m.status === "synced" && !currentlyReadonly) {
            // Unlocked AND clean (matches latest) → enforce read-only. We
            // deliberately do NOT touch an unlocked file that DIFFERS from
            // latest: a writable one is a possible unsaved edit (left writable
            // + held back, never frozen or clobbered); a read-only one is a
            // clean stale copy (the download path will refresh it). This keeps
            // the read-only bit a reliable "clean copy" marker.
            await setReadonly(m.local.absolutePath, true);
          }
        }
      }

      // Propagate local deletions of CHECKED-OUT files (spec 2c). Done after
      // the worker pool so a download in-flight can't race the soft-delete, and
      // sequentially so each pdm_delete_file settles before the next. Each
      // success drops the ledger entry (so the now-deleted file isn't seen as
      // "locally-deleted" again) and collects the name for the success event.
      // Guarded by isCurrent() per iteration like every other write in the pass.
      const propagated: string[] = [];
      if (vaultId && toPropagate.length > 0) {
        for (const p of toPropagate) {
          if (!isCurrent()) break;
          const { error } = await client.rpc("pdm_delete_file", { p_file_id: p.fileId });
          if (!error) {
            await ledgerRemove(vaultId, p.rel);
            propagated.push(p.name);
          }
        }
      }

      // Final commit — only if we're still the authoritative generation. If a
      // newer run took over (e.g. deps changed mid-pass), the new run owns the
      // status and will publish its own results.
      if (isCurrent()) {
        if (heldBack.length > 0) {
          console.warn(
            `[vault] ${heldBack.length} local file(s) had unsaved changes and weren't checked out; left untouched (check in or discard): ${heldBack.join(", ")}`,
          );
        }
        setStatus((s) => ({
          ...s,
          busy: false,
          lastDownloaded: downloaded,
          lastSkipped: skipped,
          lastFailed: failed,
          lastHeldBack: heldBack.length,
          lastRunAt: new Date().toISOString(),
          activeFiles: [],
        }));
        // Notify the UI of propagated soft-deletes (success toast/banner) and
        // of blocked deletions (restored-from-vault warning). The blocked
        // files' ledger stamps were already refreshed by their re-download's
        // ledgerRecord in the worker above, so no extra write is needed here.
        if (propagated.length > 0) notifyLocalDeletesPropagated(propagated);
        if (deleteBlocked.length > 0) notifyLocalDeleteBlocked(deleteBlocked);
        // Trigger the refetch machinery when EITHER bytes landed OR a deletion
        // propagated — a propagation with zero downloads still needs the file
        // list / recycle bin to refresh.
        if (downloaded > 0 || propagated.length > 0) onCompleteRef.current?.();
      }
    } finally {
      // Reset run-owned bookkeeping regardless of whether we're still current.
      // A superseded run skips the commit block above, but it must still mark
      // the cooldown clock — otherwise `lastFinishedAt` stays stale and the
      // next trigger computes wait=0, defeating the cooldown. We only clear
      // state we still OWN: zero `activeGenRef` only if it still equals our
      // generation (a superseding run may have already claimed it), and clear
      // the AbortController only if it's still ours.
      if (activeGenRef.current === myGen) activeGenRef.current = 0;
      if (activeAbortRef.current === myAbort) activeAbortRef.current = null;
      lastFinishedAt.current = Date.now();
    }
  }, [enabled, files, localFiles, versionsByFileId, locks, currentUserId, vaultRoot, folders, vaultId, client]);

  // Unmount cleanup: abort any in-flight pass so its writeFile doesn't fire
  // after the consumer is gone.
  useEffect(() => {
    return () => {
      activeAbortRef.current?.abort();
      activeAbortRef.current = null;
      activeGenRef.current = 0;
    };
  }, []);

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
    // stale deps, so its writes from this point on must not land. Also abort
    // its AbortController so any pending downloadVersionOnce drops its bytes
    // before writeFile rather than potentially racing with the new run's
    // write to the same dest path.
    if (activeGenRef.current !== 0) {
      activeGenRef.current = 0;
      activeAbortRef.current?.abort();
      activeAbortRef.current = null;
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
