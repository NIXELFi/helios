import { useEffect, useMemo, useState } from "react";
import { useIsVaultAdmin } from "../data/useVaultRole";
import { matchLocal } from "../data/local-match";
import { activeLockMap } from "../data/batch-classify";
import { useVaultBatchOps, type BatchOp } from "../data/useVaultBatchOps";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import type { FileId, Folder, Lock, UserId, VaultFile, Version } from "../data/types";
import type { LocalFile } from "../data/useLocalFolderScan";

interface Props {
  selectedIds: FileId[];
  onClear: () => void;
  onDone: () => void;
  // Local folder sync (optional)
  files?: VaultFile[];
  localFiles?: LocalFile[] | null;
  versionsByFileId?: Map<FileId, Version[]>;
  // Download support (optional)
  vaultRoot?: string | null;
  folders?: Folder[];
  /** Active vault id: records successful bulk get-latest / check-in
   *  materializations in the sync ledger (T6). Optional; null disables it. */
  vaultId?: string | null;
  // Lock state. When supplied, bulk actions gate per-row so e.g. Check Out
  // skips files already locked by other users (silently failing the RPC and
  // surfacing a cryptic count). Without these, the bar runs un-gated.
  locks?: Lock[];
  currentUserId?: UserId | null;
  /** Lock-holder names, for "checked out by Alice" in the failure list. */
  holderLabelById?: Map<UserId, string>;
}

const EMPTY_VERSIONS = new Map<FileId, Version[]>();

export function BulkActionBar({
  selectedIds,
  onClear,
  onDone,
  files = [],
  localFiles,
  versionsByFileId = EMPTY_VERSIONS,
  vaultRoot,
  folders = [],
  vaultId = null,
  locks = [],
  currentUserId = null,
  holderLabelById,
}: Props) {
  // Per-vault admin (global admin rows count everywhere): matches what the
  // pdm_delete_file / pdm_force_unlock RPCs actually authorize, so the bar
  // never shows actions the DB would reject for a vault-scoped member.
  const isAdmin = useIsVaultAdmin(vaultId);
  const batch = useVaultBatchOps({
    files, localFiles, versionsByFileId, vaultRoot, folders, vaultId, locks, currentUserId, holderLabelById,
  });
  const busy = batch.busy;
  const progress = batch.progress;
  const stopping = batch.stopping;
  const [status, setStatus] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  // Key the selection-change effect on the selection's CONTENT, not the array
  // identity: the parent passes a fresh `Array.from(selected)` on every
  // render, so depending on the array reference would abort an in-flight run
  // on every unrelated re-render. When the actual selection changes (e.g.
  // cleared), cancel any run still chewing through the previous one so it
  // can't keep reading/writing files for rows the user no longer has selected.
  const selectionKey = selectedIds.join(",");
  useEffect(() => () => batch.abort(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- abort is stable in effect; keyed on selection content
    [selectionKey]);

  const lockByFile = useMemo(() => activeLockMap(locks), [locks]);

  // Per-action eligibility, counted up-front so the action buttons and the
  // status message agree on what's actually going to run.
  const eligibility = useMemo(() => {
    let canCheckOut = 0, lockedByOtherForCheckOut = 0, alreadyMine = 0;
    let canCancel = 0, notMineForCancel = 0;
    for (const id of selectedIds) {
      const l = lockByFile.get(id);
      if (!l) { canCheckOut++; }
      else if (l.user_id === currentUserId) { canCancel++; alreadyMine++; }
      else { lockedByOtherForCheckOut++; notMineForCancel++; }
    }
    return { canCheckOut, lockedByOtherForCheckOut, alreadyMine, canCancel, notMineForCancel };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectionKey stands in for selectedIds
  }, [selectionKey, lockByFile, currentUserId]);

  // O(1) file lookup by id (a ~13k-file vault made per-id `files.find` slow).
  const filesById = useMemo(() => new Map(files.map((f) => [f.id, f])), [files]);

  // Which selected files have a modified local copy available.
  const hasModifiedLocal = useMemo(
    () =>
      localFiles != null &&
      selectedIds.some((id) => {
        const file = filesById.get(id);
        if (!file) return false;
        const m = matchLocal(file, localFiles, versionsByFileId, folders);
        return m.status === "modified" && !!m.local;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectionKey stands in for selectedIds
    [selectionKey, filesById, localFiles, versionsByFileId, folders],
  );

  // Whether Get Latest is applicable for any selected file.
  const hasGetLatest = useMemo(
    () =>
      vaultRoot != null &&
      selectedIds.some((id) => {
        const file = filesById.get(id);
        if (!file) return false;
        const m = matchLocal(file, localFiles ?? null, versionsByFileId, folders);
        return (m.status === "vault-only" || m.status === "modified") &&
          !!versionsByFileId.get(id)?.[0];
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectionKey stands in for selectedIds
    [selectionKey, vaultRoot, filesById, localFiles, versionsByFileId, folders],
  );

  async function start(op: BatchOp) {
    setStatus(null);
    const ids = selectedIds;
    const r = await batch.run(op, ids);
    // null = unmounted mid-run; nothing left to update.
    if (!r) return;
    if (r.aborted && !r.stopped) {
      // Superseded (selection changed). Delete still reports partial
      // progress: it's destructive and the user must know what was removed.
      if (op === "delete" && (r.ok > 0 || r.failedCount > 0)) setStatus(r.status);
      onDone();
      return;
    }
    setStatus(r.status);
    // A clean delete clears the selection; on partial failure keep it so the
    // user can see (and retry) exactly which files still need attention.
    if (op === "delete" && !r.aborted && r.failedCount === 0) onClear();
    onDone();
  }

  if (selectedIds.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-helios-line bg-helios-base px-3 py-2 text-xs">
      <span className="text-helios-dim">{selectedIds.length} selected</span>
      <button
        type="button"
        onClick={() => { void start("checkout"); }}
        // Disabled when no row in the selection is actually checkout-able
        // (every one is locked or already yours). Saves the user from a
        // "Checked out 0/N (N skipped)" surprise.
        disabled={busy || eligibility.canCheckOut === 0}
        title={
          eligibility.canCheckOut === 0
            ? "All selected files are already locked"
            : eligibility.lockedByOtherForCheckOut > 0
            ? `${eligibility.canCheckOut} of ${selectedIds.length} can be checked out`
            : undefined
        }
        className="rounded bg-asu-gold px-2 py-1 text-white hover:bg-asu-gold/90 disabled:opacity-50"
      >
        Check Out
      </button>
      <button
        type="button"
        onClick={() => setConfirmCancel(true)}
        // Disabled when nothing in the selection is locked by the current
        // user. (Cancelling someone else's lock requires force-unlock.)
        disabled={busy || eligibility.canCancel === 0}
        title={
          eligibility.canCancel === 0
            ? "None of the selected files are checked out to you"
            : eligibility.notMineForCancel > 0
            ? `${eligibility.canCancel} of ${selectedIds.length} are yours to release`
            : undefined
        }
        className="rounded border border-helios-line px-2 py-1 text-helios-text hover:bg-helios-line disabled:opacity-50"
      >
        Cancel Checkout
      </button>
      {hasModifiedLocal && (
        <button
          type="button"
          onClick={() => { void start("checkin"); }}
          disabled={busy}
          className="rounded bg-[#66BB6A] px-2 py-1 text-white hover:brightness-110 disabled:opacity-50"
        >
          Check In Changes
        </button>
      )}
      {hasGetLatest && (
        <button
          type="button"
          onClick={() => { void start("getLatest"); }}
          disabled={busy}
          className="rounded border border-helios-line px-2 py-1 text-helios-text hover:bg-helios-line disabled:opacity-50"
        >
          Get Latest
        </button>
      )}
      {isAdmin && (
        <button
          type="button"
          onClick={() => setConfirmDelete(true)}
          disabled={busy}
          className="rounded bg-red-700 px-2 py-1 text-white hover:bg-red-600 disabled:opacity-50"
        >
          Delete
        </button>
      )}
      <button
        type="button"
        onClick={onClear}
        className="ml-auto rounded px-2 py-1 text-helios-dim hover:bg-helios-line"
      >
        Clear
      </button>
      {status && (
        <span
          role="status"
          aria-live="polite"
          title={status}
          className="ml-2 max-w-[16rem] truncate text-helios-dim"
        >
          {status}
        </span>
      )}
      {/* Live progress for the running bulk action: a determinate bar, the
          count, and the file in flight, so a 40-file check-in no longer looks
          like a frozen bar of disabled buttons. */}
      {progress && (
        <div
          role="progressbar"
          aria-label={progress.verb}
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.done}
          className="flex basis-full items-center gap-2"
        >
          <span className="shrink-0 font-medium text-helios-text">
            {stopping
              ? "Stopping, letting the files in progress finish..."
              : `${progress.verb} ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`}
          </span>
          <div className="h-1.5 min-w-[6rem] flex-1 overflow-hidden rounded-full bg-helios-line">
            <div
              className="h-full rounded-full bg-asu-gold transition-[width] duration-300"
              style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
            />
          </div>
          {progress.current && (
            <span className="max-w-[14rem] truncate font-mono-num text-helios-dim" title={progress.current}>
              {progress.current}
            </span>
          )}
          <button
            type="button"
            onClick={batch.stop}
            disabled={stopping}
            className="shrink-0 rounded border border-helios-line px-2 py-0.5 text-helios-text hover:bg-helios-line focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-asu-gold disabled:opacity-50"
          >
            Stop
          </button>
        </div>
      )}
      {/* Shared ConfirmDialog: role="dialog" (so Browse's Escape-clears-
          selection handler stands down), Escape to close, Cancel focused. */}
      {confirmDelete && (
        <ConfirmDialog
          title={`Delete ${selectedIds.length} file${selectedIds.length === 1 ? "" : "s"}?`}
          body="The selected files move to this vault's Deleted tab. Versions and history are kept, and you (or an admin) can restore them from there. Local working copies on teammates' machines are removed unless they hold unsaved changes."
          confirmLabel="Delete"
          confirmTone="danger"
          cancelLabel="Cancel"
          onConfirm={() => { setConfirmDelete(false); void start("delete"); }}
          onClose={() => setConfirmDelete(false)}
        />
      )}
      {confirmCancel && (
        <ConfirmDialog
          title={`Undo check-out on ${eligibility.canCancel} file${eligibility.canCancel === 1 ? "" : "s"}?`}
          body="This discards your local changes to the files you have checked out and restores the latest vaulted version (read-only). Files you created but never checked in are discarded entirely. This can't be undone."
          confirmLabel="Undo check-out"
          confirmTone="danger"
          cancelLabel="Keep editing"
          onConfirm={() => { setConfirmCancel(false); void start("cancel"); }}
          onClose={() => setConfirmCancel(false)}
        />
      )}
    </div>
  );
}
