import { useState } from "react";
import { readFile } from "@tauri-apps/plugin-fs";
import { useAcquireLock } from "../data/useAcquireLock";
import { useReleaseLock } from "../data/useReleaseLock";
import { useDeleteFile } from "../data/useDeleteFile";
import { useIsAdmin } from "../data/useIsAdmin";
import { useCheckIn } from "../data/useCheckIn";
import { matchLocal } from "../data/local-match";
import type { FileId, VaultFile, Version } from "../data/types";
import type { LocalFile } from "../data/useLocalFolderScan";

interface Props {
  selectedIds: FileId[];
  onClear: () => void;
  onDone: () => void;
  // Local folder sync (optional)
  files?: VaultFile[];
  localFiles?: LocalFile[] | null;
  versionsByFileId?: Map<FileId, Version[]>;
}

export function BulkActionBar({
  selectedIds,
  onClear,
  onDone,
  files = [],
  localFiles,
  versionsByFileId = new Map(),
}: Props) {
  const acquireLock = useAcquireLock();
  const releaseLock = useReleaseLock();
  const deleteFile = useDeleteFile();
  const checkIn = useCheckIn();
  const isAdmin = useIsAdmin();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Determine which selected files have a modified local copy available.
  const hasModifiedLocal =
    localFiles != null &&
    selectedIds.some((id) => {
      const file = files.find((f) => f.id === id);
      if (!file) return false;
      const m = matchLocal(file, localFiles, versionsByFileId);
      return m.status === "modified" && !!m.local;
    });

  async function bulkCheckInChanges() {
    setBusy(true);
    setStatus(null);
    let ok = 0, fail = 0, skipped = 0;
    for (const id of selectedIds) {
      const file = files.find((f) => f.id === id);
      if (!file) { skipped++; continue; }
      const m = matchLocal(file, localFiles ?? null, versionsByFileId);
      if (m.status !== "modified" || !m.local) { skipped++; continue; }
      // Acquire lock first; may fail if another user holds it.
      await acquireLock.run(id);
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
    setStatus(
      `Checked in ${ok}/${selectedIds.length}` +
        (fail ? ` (${fail} failed, ${skipped} skipped)` : ` (${skipped} skipped)`),
    );
    setBusy(false);
    onDone();
  }

  async function bulkCheckOut() {
    setBusy(true);
    setStatus(null);
    let ok = 0, fail = 0;
    for (const id of selectedIds) {
      const r = await acquireLock.run(id);
      if (r) ok++; else fail++;
    }
    setStatus(`Checked out ${ok}/${selectedIds.length}${fail ? ` (${fail} failed)` : ""}`);
    setBusy(false);
    onDone();
  }

  async function bulkCancel() {
    setBusy(true);
    setStatus(null);
    let ok = 0, fail = 0;
    for (const id of selectedIds) {
      const r = await releaseLock.run(id);
      if (r) ok++; else fail++;
    }
    setStatus(`Cancelled ${ok}/${selectedIds.length}${fail ? ` (${fail} failed)` : ""}`);
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
    <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-950 px-3 py-2 text-xs">
      <span className="text-zinc-400">{selectedIds.length} selected</span>
      <button
        type="button"
        onClick={bulkCheckOut}
        disabled={busy}
        className="rounded bg-blue-700 px-2 py-1 text-white hover:bg-blue-600 disabled:opacity-50"
      >
        Check Out
      </button>
      <button
        type="button"
        onClick={bulkCancel}
        disabled={busy}
        className="rounded border border-zinc-700 px-2 py-1 text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
      >
        Cancel Checkout
      </button>
      {hasModifiedLocal && (
        <button
          type="button"
          onClick={bulkCheckInChanges}
          disabled={busy}
          className="rounded bg-emerald-700 px-2 py-1 text-white hover:bg-emerald-600 disabled:opacity-50"
        >
          Check In Changes
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
        className="ml-auto rounded px-2 py-1 text-zinc-400 hover:bg-zinc-800"
      >
        Clear
      </button>
      {status && <span className="ml-2 text-zinc-500">{status}</span>}
      {confirmDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setConfirmDelete(false)}
        >
          <div
            className="w-96 space-y-3 rounded-lg border border-zinc-700 bg-zinc-900 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-zinc-100">
              Delete {selectedIds.length} file{selectedIds.length === 1 ? "" : "s"}?
            </h3>
            <p className="text-xs text-zinc-400">
              This cannot be undone. All versions, references, and audit history for the selected
              files will be removed.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="rounded px-3 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
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
