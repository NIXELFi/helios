import { useState } from "react";
import { readFile } from "@tauri-apps/plugin-fs";
import { useAcquireLock } from "../data/useAcquireLock";
import { useReleaseLock } from "../data/useReleaseLock";
import { useDeleteFile } from "../data/useDeleteFile";
import { useIsAdmin } from "../data/useIsAdmin";
import { useCheckIn } from "../data/useCheckIn";
import { useDownloadVersion } from "../data/useDownloadVersion";
import { matchLocal } from "../data/local-match";
import { localDestPath } from "../data/folder-paths";
import type { FileId, Folder, VaultFile, Version } from "../data/types";
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
    let ok = 0, fail = 0, skipped = 0;
    for (const id of selectedIds) {
      const file = files.find((f) => f.id === id);
      if (!file) { skipped++; continue; }
      const m = matchLocal(file, localFiles ?? null, versionsByFileId, folders);
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
    <div className="flex items-center gap-2 border-b border-helios-line bg-helios-base px-3 py-2 text-xs">
      <span className="text-helios-dim">{selectedIds.length} selected</span>
      <button
        type="button"
        onClick={bulkCheckOut}
        disabled={busy}
        className="rounded bg-asu-gold px-2 py-1 text-white hover:bg-asu-gold disabled:opacity-50"
      >
        Check Out
      </button>
      <button
        type="button"
        onClick={bulkCancel}
        disabled={busy}
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
