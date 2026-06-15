import { useEffect, useMemo, useRef, useState } from "react";
import { readFile } from "@tauri-apps/plugin-fs";
import { useAcquireLock } from "../data/useAcquireLock";
import { useReleaseLock } from "../data/useReleaseLock";
import { useDeleteFile } from "../data/useDeleteFile";
import { useIsVaultAdmin } from "../data/useVaultRole";
import { useCheckIn } from "../data/useCheckIn";
import { useDownloadVersion } from "../data/useDownloadVersion";
import { matchLocal, vaultRelativePath } from "../data/local-match";
import { localDestPath } from "../data/folder-paths";
import { ledgerRecord } from "../data/sync-ledger";
import { setReadonly, flipSwReadonly } from "../data/fs-readonly";
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
  /** Active vault id — records successful bulk get-latest / check-in
   *  materializations in the sync ledger (T6). Optional; null disables it. */
  vaultId?: string | null;
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
  vaultId = null,
  locks = [],
  currentUserId = null,
}: Props) {
  const acquireLock = useAcquireLock();
  const releaseLock = useReleaseLock();
  const deleteFile = useDeleteFile();
  const checkIn = useCheckIn();
  const download = useDownloadVersion();
  // Per-vault admin (global admin rows count everywhere) — matches what the
  // pdm_delete_file / pdm_force_unlock RPCs actually authorize, so the bar
  // never shows actions the DB would reject for a vault-scoped member.
  const isAdmin = useIsVaultAdmin(vaultId);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  // AbortController for the in-flight long-running loop (Get Latest /
  // Check In Changes — the two that write files and call setState across many
  // awaits). The loops poll `signal.aborted` between iterations and after each
  // await, so once the controller fires they stop reading files, stop calling
  // RPCs, and never touch state. Each invocation installs a fresh controller
  // (aborting any prior). We abort on unmount and whenever the selection
  // changes, which covers the audit case where the bar kept writing files /
  // calling setState after the user cleared the selection or navigated away.
  const abortRef = useRef<AbortController | null>(null);
  // Key the selection-change effect on the selection's CONTENT, not the array
  // identity — the parent passes a fresh `Array.from(selected)` on every
  // render, so depending on the array reference would abort an in-flight loop
  // on every unrelated re-render. This string only changes when the actual set
  // of selected ids changes.
  const selectionKey = selectedIds.join(",");
  useEffect(() => {
    // Cancel any loop still chewing through a previous selection on unmount or
    // when the selection content changes (e.g. cleared), so it can't finish
    // reading/writing files or calling setState for rows the user no longer
    // has selected.
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [selectionKey]);

  /** Start a fresh abort scope for a long-running loop, superseding any prior. */
  function beginAbortScope(): AbortSignal {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    return ctrl.signal;
  }

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
    const signal = beginAbortScope();
    setBusy(true);
    setStatus(null);
    let ok = 0, fail = 0, skipped = 0, lockedByOther = 0;
    for (const id of selectedIds) {
      // Bail the moment the run is superseded (unmount / selection cleared) so
      // we stop reading files and calling check-in RPCs for rows the user is
      // no longer acting on.
      if (signal.aborted) return;
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
        if (signal.aborted) return;
        if (!acquired) { fail++; continue; }
      }
      try {
        const fileBytes = await readFile(m.local.absolutePath);
        if (signal.aborted) return;
        const ab = fileBytes.buffer.slice(
          fileBytes.byteOffset,
          fileBytes.byteOffset + fileBytes.byteLength,
        ) as ArrayBuffer;
        const r = await checkIn.run(id, ab, "bulk check-in");
        if (signal.aborted) return;
        if (r) {
          ok++;
          // P0: the file is now the latest version and no longer checked out, so
          // re-protect the local copy read-only — mirroring single-file CheckIn.
          // Without this the writable-but-unlocked copy reads as an unsaved edit
          // and gets held back from sync indefinitely (the next reconciliation
          // only freezes it a pass later, if at all).
          await setReadonly(m.local.absolutePath, true);
          flipSwReadonly(m.local.absolutePath, true);
          // Record the just-checked-in content in the ledger (T6).
          if (vaultId) void ledgerRecord(vaultId, vaultRelativePath(file, folders), r.sha256);
        } else fail++;
      } catch {
        if (signal.aborted) return;
        fail++;
      }
    }
    if (signal.aborted) return;
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
    const signal = beginAbortScope();
    setBusy(true);
    setStatus(null);
    let ok = 0, fail = 0, skipped = 0;
    for (const id of selectedIds) {
      // Bail before starting the next download once the run is superseded
      // (unmount / selection cleared) — and pass the signal through so an
      // in-flight download drops its terminal disk write too.
      if (signal.aborted) return;
      const file = files.find((f) => f.id === id);
      if (!file) { skipped++; continue; }
      const ver = versionsByFileId.get(id)?.[0];
      if (!ver) { skipped++; continue; }
      const dest = localDestPath(vaultRoot!, file.folder_id, file.name, folders);
      const r = await download.run(ver.sha256, dest, signal);
      if (signal.aborted) return;
      if (r) {
        ok++;
        // Record the freshly-downloaded latest version in the ledger (T6).
        if (vaultId) void ledgerRecord(vaultId, vaultRelativePath(file, folders), ver.sha256);
      } else fail++;
    }
    if (signal.aborted) return;
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
      if (!r) { fail++; continue; }
      // P0: make the local copy editable — get the latest first if ours is
      // missing/stale (so the user doesn't edit an outdated base and then check
      // it in over a teammate's newer work), then clear the read-only bit.
      // Mirrors single-file CheckOut, including rolling the lock back if the
      // required download fails.
      const file = files.find((f) => f.id === id);
      if (file && vaultRoot) {
        const m = matchLocal(file, localFiles ?? null, versionsByFileId, folders);
        const ver = versionsByFileId.get(id)?.[0];
        const dest = localDestPath(vaultRoot, file.folder_id, file.name, folders);
        const stale = !m.local || (!!ver && m.local.sha256?.toLowerCase() !== ver.sha256.toLowerCase());
        if (ver && stale) {
          const got = await download.run(ver.sha256, dest);
          if (!got) { await releaseLock.run(id); fail++; continue; }
          if (vaultId) void ledgerRecord(vaultId, vaultRelativePath(file, folders), ver.sha256);
        }
        await setReadonly(dest, false);
        flipSwReadonly(dest, false);
      }
      ok++;
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
    setConfirmCancel(false);
    const signal = beginAbortScope();
    setBusy(true);
    setStatus(null);
    let ok = 0, fail = 0, notMine = 0, discarded = 0;
    for (const id of selectedIds) {
      if (signal.aborted) return;
      // Only rows the user owns can be released — releasing someone else's lock
      // requires force-unlock, which is admin-only and out of the bulk path.
      if (lockKindFor(id) !== "me") { notMine++; continue; }
      const file = files.find((f) => f.id === id);
      const ver = file ? versionsByFileId.get(id)?.[0] : undefined;
      // Never-checked-in draft: there is no vaulted version to restore, so undo
      // = discard the draft (soft-delete releases the lock; the reaper removes
      // the local copy). Mirrors single-file undo-checkout on a draft.
      if (file && !ver) {
        const del = await deleteFile.run(id);
        if (signal.aborted) return;
        if (del) discarded++; else fail++;
        continue;
      }
      const rel = await releaseLock.run(id);
      if (signal.aborted) return;
      if (!rel) { fail++; continue; }
      // P0: undo check-out is destructive in the real-vault model — discard local
      // edits by restoring the latest vaulted version, THEN re-protect read-only.
      // Only freeze on a SUCCESSFUL restore: a failed download leaves the local
      // edit on disk writable (held back), never a read-only-but-dirty copy that
      // the next sync pass would treat as clean and clobber.
      if (file && ver && vaultRoot) {
        const dest = localDestPath(vaultRoot, file.folder_id, file.name, folders);
        const restored = await download.run(ver.sha256, dest, signal);
        if (signal.aborted) return;
        if (!restored) { fail++; continue; }
        await setReadonly(dest, true);
        flipSwReadonly(dest, true);
        if (vaultId) void ledgerRecord(vaultId, vaultRelativePath(file, folders), ver.sha256);
      }
      ok++;
    }
    if (signal.aborted) return;
    const detail: string[] = [];
    if (discarded) detail.push(`${discarded} draft${discarded === 1 ? "" : "s"} discarded`);
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
    const nameById = new Map(files.map((f) => [f.id, f.name]));
    let ok = 0;
    const failed: string[] = [];
    for (const id of selectedIds) {
      const r = await deleteFile.run(id);
      if (r) ok++;
      else failed.push(nameById.get(id) ?? String(id));
    }
    if (failed.length > 0) {
      // Name the failures (hover shows the full list via the status title) and
      // keep the selection so the user can retry — clearing it would hide
      // exactly which files still need attention.
      setStatus(
        `Deleted ${ok}/${selectedIds.length} — failed: ${failed.join(", ")}` +
          (deleteFile.error ? ` (${deleteFile.error.message})` : ""),
      );
    } else {
      setStatus(`Deleted ${ok}/${selectedIds.length}`);
      onClear();
    }
    setBusy(false);
    onDone();
  }

  if (selectedIds.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-helios-line bg-helios-base px-3 py-2 text-xs">
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
          onClick={bulkCheckInChanges}
          disabled={busy}
          className="rounded bg-[#66BB6A] px-2 py-1 text-white hover:brightness-110 disabled:opacity-50"
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
              The selected files move to this vault&apos;s Deleted tab — versions and history are
              kept, and you (or an admin) can restore them from there. Local working copies on
              teammates&apos; machines are removed unless they hold unsaved changes.
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
      {confirmCancel && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setConfirmCancel(false)}
        >
          <div
            className="w-96 space-y-3 rounded-lg border border-helios-line bg-helios-panel p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-helios-text">
              Undo check-out on {eligibility.canCancel} file{eligibility.canCancel === 1 ? "" : "s"}?
            </h3>
            <p className="text-xs text-helios-dim">
              This discards your local changes to the files you have checked out and restores the
              latest vaulted version (read-only). Files you created but never checked in are
              discarded entirely. This can&apos;t be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmCancel(false)}
                className="rounded px-3 py-1 text-xs text-helios-dim hover:bg-helios-line"
              >
                Keep editing
              </button>
              <button
                type="button"
                onClick={bulkCancel}
                className="rounded bg-red-700 px-3 py-1 text-xs text-white hover:bg-red-600"
              >
                Undo check-out
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
