import { useMemo, useState } from "react";
import { readFile } from "@tauri-apps/plugin-fs";
import { useAcquireLock } from "../data/useAcquireLock";
import { useReleaseLock } from "../data/useReleaseLock";
import { useDeleteFile } from "../data/useDeleteFile";
import { useIsAdmin } from "../data/useIsAdmin";
import { useCheckIn } from "../data/useCheckIn";
import { useDownloadVersion } from "../data/useDownloadVersion";
import { matchLocal } from "../data/local-match";
import { localDestPath } from "../data/folder-paths";
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
  // Lock state. When supplied, bulk actions gate per-row so e.g. Check Out
  // skips files already locked by other users (silently failing the RPC and
  // surfacing a cryptic count). Without these, the bar runs un-gated.
  locks?: Lock[];
  currentUserId?: UserId | null;
}

export function BulkActionBar({
  selectedIds,
  onClear,
  onDone,
  files = [],
  localFiles,
  versionsByFileId = new Map(),
  vaultRoot,
  folders = [],
  locks = [],
  currentUserId = null,
}: Props) {
  const acquireLock = useAcquireLock();
  const releaseLock = useReleaseLock();
  const deleteFile = useDeleteFile();
  const checkIn = useCheckIn();
  const download = useDownloadVersion();
  const isAdmin = useIsAdmin();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // O(1) lookup of the currently-active lock by file_id. Used to skip rows
  // for which a bulk action would silently fail at the RPC layer (e.g.
  // Check Out on a file someone else already holds).
  const lockByFile = useMemo(() => {
    const m = new Map<FileId, Lock>();
    for (const l of locks) {
      if (l.released_at === null) m.set(l.file_id, l);
    }
    return m;
  }, [locks]);

  function lockKindFor(fileId: FileId): "none" | "me" | "other" {
    const l = lockByFile.get(fileId);
    if (!l) return "none";
    return l.user_id === currentUserId ? "me" : "other";
  }

  // Per-action eligibility — counted up-front so the action buttons and
  // the status message agree on what's actually going to run.
  const eligibility = useMemo(() => {
    let canCheckOut = 0, lockedByOtherForCheckOut = 0, alreadyMine = 0;
    let canCancel = 0, notMineForCancel = 0;
    for (const id of selectedIds) {
      const kind = lockKindFor(id);
      if (kind === "none") { canCheckOut++; }
      else if (kind === "me") { canCancel++; alreadyMine++; }
      else { lockedByOtherForCheckOut++; notMineForCancel++; }
    }
    return { canCheckOut, lockedByOtherForCheckOut, alreadyMine, canCancel, notMineForCancel };
  }, [selectedIds, lockByFile, currentUserId]);

  // Determine which selected files have a modified local copy available.
  const hasModifiedLocal =
    localFiles != null &&
    selectedIds.some((id) => {
      const file = files.find((f) => f.id === id);
      if (!file) return false;
      const m = matchLocal(file, localFiles, versionsByFileId, folders);
      return m.status === "modified" && !!m.local;
    });

  // Determine if Get Latest is applicable for any selected file.
  const hasGetLatest =
    vaultRoot != null &&
    selectedIds.some((id) => {
      const file = files.find((f) => f.id === id);
      if (!file) return false;
      const m = matchLocal(file, localFiles ?? null, versionsByFileId, folders);
      return (m.status === "vault-only" || m.status === "modified") &&
        !!versionsByFileId.get(id)?.[0];
    });

  async function bulkCheckInChanges() {
    setBusy(true);
    setStatus(null);
    let ok = 0, fail = 0, skipped = 0, lockedByOther = 0;
    for (const id of selectedIds) {
      const file = files.find((f) => f.id === id);
      if (!file) { skipped++; continue; }
      const m = matchLocal(file, localFiles ?? null, versionsByFileId, folders);
      if (m.status !== "modified" || !m.local) { skipped++; continue; }
      // Lock-state gate: never try to acquire a lock another user holds —
      // the RPC will fail anyway and we'd waste a local file read. The bar
      // surfaces the count below so the user knows why some rows skipped.
      if (lockKindFor(id) === "other") { lockedByOther++; continue; }
      // Acquire lock if we don't already hold it. Stop the row if we can't.
      if (lockKindFor(id) === "none") {
        const acquired = await acquireLock.run(id);
        if (!acquired) { fail++; continue; }
      }
      try {
        const fileBytes = await readFile(m.local.absolutePath);
        const ab = fileBytes.buffer.slice(
          fileBytes.byteOffset,
          fileBytes.byteOffset + fileBytes.byteLength,
        ) as ArrayBuffer;
        const r = await checkIn.run(id, ab, "bulk check-in");
        if (r) ok++; else fail++;
      } catch {
        fail++;
      }
    }
    const parts: string[] = [`Checked in ${ok}/${selectedIds.length}`];
    const detail: string[] = [];
    if (fail) detail.push(`${fail} failed`);
    if (skipped) detail.push(`${skipped} skipped`);
    if (lockedByOther) detail.push(`${lockedByOther} locked by other user`);
    if (detail.length) parts.push(`(${detail.join(", ")})`);
    setStatus(parts.join(" "));
    setBusy(false);
    onDone();
  }

  async function bulkGetLatest() {
    setBusy(true);
    setStatus(null);
    let ok = 0, fail = 0, skipped = 0;
    for (const id of selectedIds) {
      const file = files.find((f) => f.id === id);
      if (!file) { skipped++; continue; }
      const ver = versionsByFileId.get(id)?.[0];
      if (!ver) { skipped++; continue; }
      const dest = localDestPath(vaultRoot!, file.folder_id, file.name, folders);
      const r = await download.run(ver.sha256, dest);
      if (r) ok++; else fail++;
    }
    setStatus(
      `Downloaded ${ok}/${selectedIds.length}` +
        (fail ? ` (${fail} failed, ${skipped} skipped)` : skipped ? ` (${skipped} skipped)` : ""),
    );
    setBusy(false);
    onDone();
  }

  async function bulkCheckOut() {
    setBusy(true);
    setStatus(null);
    let ok = 0, fail = 0, lockedByOther = 0, alreadyMine = 0;
    for (const id of selectedIds) {
      const kind = lockKindFor(id);
      // Skip rows that would fail / no-op at the RPC layer. Pre-filtering
      // here turns "0/3 (3 failed)" into "1/3 (2 locked by other user)" —
      // the user can act on that.
      if (kind === "me") { alreadyMine++; continue; }
      if (kind === "other") { lockedByOther++; continue; }
      const r = await acquireLock.run(id);
      if (r) ok++; else fail++;
    }
    const detail: string[] = [];
    if (fail) detail.push(`${fail} failed`);
    if (lockedByOther) detail.push(`${lockedByOther} locked by other user`);
    if (alreadyMine) detail.push(`${alreadyMine} already yours`);
    setStatus(
      `Checked out ${ok}/${selectedIds.length}` + (detail.length ? ` (${detail.join(", ")})` : ""),
    );
    setBusy(false);
    onDone();
  }

  async function bulkCancel() {
    setBusy(true);
    setStatus(null);
    let ok = 0, fail = 0, notMine = 0;
    for (const id of selectedIds) {
      // Only rows the user owns can be released — releasing someone else's
      // lock requires force-unlock, which is admin-only and intentionally
      // out of the bulk path.
      if (lockKindFor(id) !== "me") { notMine++; continue; }
      const r = await releaseLock.run(id);
      if (r) ok++; else fail++;
    }
    const detail: string[] = [];
    if (fail) detail.push(`${fail} failed`);
    if (notMine) detail.push(`${notMine} not yours`);
    setStatus(
      `Cancelled ${ok}/${selectedIds.length}` + (detail.length ? ` (${detail.join(", ")})` : ""),
    );
    setBusy(false);
    onDone();
  }

  async function bulkDelete() {
    setConfirmDelete(false);
    setBusy(true);
    setStatus(null);
    let ok = 0, fail = 0;
    for (const id of selectedIds) {
      const r = await deleteFile.run(id);
      if (r) ok++; else fail++;
    }
    setStatus(`Deleted ${ok}/${selectedIds.length}${fail ? ` (${fail} failed)` : ""}`);
    setBusy(false);
    onClear();
    onDone();
  }

  if (selectedIds.length === 0) return null;

  return (
    <div className="flex items-center gap-2 border-b border-helios-line bg-helios-base px-3 py-2 text-xs">
      <span className="text-helios-dim">{selectedIds.length} selected</span>
      <button
        type="button"
        onClick={bulkCheckOut}
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
        className="rounded bg-asu-gold px-2 py-1 text-white hover:bg-asu-gold disabled:opacity-50"
      >
        Check Out
      </button>
      <button
        type="button"
        onClick={bulkCancel}
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
          onClick={bulkCheckInChanges}
          disabled={busy}
          className="rounded bg-[#66BB6A] px-2 py-1 text-white hover:bg-[#66BB6A] disabled:opacity-50"
        >
          Check In Changes
        </button>
      )}
      {hasGetLatest && (
        <button
          type="button"
          onClick={bulkGetLatest}
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
      {status && <span className="ml-2 text-helios-dim">{status}</span>}
      {confirmDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setConfirmDelete(false)}
        >
          <div
            className="w-96 space-y-3 rounded-lg border border-helios-line bg-helios-panel p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-helios-text">
              Delete {selectedIds.length} file{selectedIds.length === 1 ? "" : "s"}?
            </h3>
            <p className="text-xs text-helios-dim">
              This cannot be undone. All versions, references, and audit history for the selected
              files will be removed.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="rounded px-3 py-1 text-xs text-helios-dim hover:bg-helios-line"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={bulkDelete}
                className="rounded bg-red-700 px-3 py-1 text-xs text-white hover:bg-red-600"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
