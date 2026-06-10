import { useEffect, useRef, useState } from "react";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { useAcquireLock } from "../data/useAcquireLock";
import { useCheckIn } from "../data/useCheckIn";
import { useReleaseLock } from "../data/useReleaseLock";
import { useDeleteFile } from "../data/useDeleteFile";
import { useDownloadVersion } from "../data/useDownloadVersion";
import { useRecordRefs } from "../data/useRecordRefs";
import { useRecordProperties } from "../data/useRecordProperties";
import { useRestoreVersion } from "../data/useRestoreVersion";
import { localDestPath, vaultRelPathFor } from "../data/folder-paths";
import { setReadonly, flipSwReadonly } from "../data/fs-readonly";
import { ledgerRecord } from "../data/sync-ledger";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import type { FileId, FolderId, Folder, Version } from "../data/types";
import type { LocalFile } from "../data/useLocalFolderScan";

/** Context needed to find + toggle the local working copy for the real-vault
 *  read-only transitions. Optional so callers without a vault folder (or tests)
 *  degrade gracefully to "lock-only" behavior. */
interface LocalCtx {
  vaultRoot?: string | null;
  folderId?: FolderId | null;
  fileName?: string;
  folders?: Folder[];
  latestSha?: string | null;
  /** Active vault id — when set, a successful materialization here (download on
   *  checkout, get-latest, undo-checkout restore, or check-in) records the
   *  file in the sync ledger so a later local delete is detectable (T6). */
  vaultId?: string | null;
}

/** The vault-relative path for this file (folder hierarchy + sanitized name),
 *  or null if we lack a file name. Matches the key the sync ledger uses. */
function relForCtx(ctx: LocalCtx): string | null {
  return ctx.fileName ? vaultRelPathFor(ctx.folderId ?? null, ctx.fileName, ctx.folders ?? []) : null;
}

/** Record a successful materialization in the sync ledger. Fire-and-forget;
 *  no-op without both a vaultId and a known sha. */
function recordLedger(ctx: LocalCtx, sha: string | null | undefined): void {
  const rel = relForCtx(ctx);
  if (ctx.vaultId && rel && sha) void ledgerRecord(ctx.vaultId, rel, sha);
}

/** The local working-copy path for this file, or null if no vault folder. */
function localTarget(ctx: LocalCtx): string | null {
  return ctx.vaultRoot && ctx.fileName
    ? localDestPath(ctx.vaultRoot, ctx.folderId ?? null, ctx.fileName, ctx.folders ?? [])
    : null;
}

/** Read a file path into an ArrayBuffer, normalizing the Uint8Array view. */
async function readArrayBuffer(path: string): Promise<ArrayBuffer> {
  const fileBytes = await readFile(path);
  return fileBytes.buffer.slice(
    fileBytes.byteOffset,
    fileBytes.byteOffset + fileBytes.byteLength,
  ) as ArrayBuffer;
}

interface ActionProps extends LocalCtx {
  fileId: FileId;
  onDone?: () => void;
  localFile?: LocalFile;
}

interface CheckInButtonProps extends LocalCtx {
  fileId: FileId;
  localFile?: LocalFile;
  onDone?: () => void;
}

export function CheckOutButton({
  fileId, onDone, vaultRoot, folderId, fileName, folders, vaultId, latestSha, localFile,
}: ActionProps) {
  const acquireLock = useAcquireLock();
  const release = useReleaseLock();
  const download = useDownloadVersion();
  const [rollbackErr, setRollbackErr] = useState<string | null>(null);

  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    setRollbackErr(null);
    const result = await acquireLock.run(fileId);
    if (!result) return;
    // Real-vault: checking out gets you the latest version (download it if you
    // don't have it locally) and makes the local copy WRITABLE so you can edit.
    const dest = localTarget({ vaultRoot, folderId, fileName, folders });
    if (dest) {
      // Get the latest if we don't have it OR our local copy is stale, so the
      // user edits the CURRENT version — not an outdated base they'd then check
      // in over a teammate's newer work. Then make it writable.
      const stale =
        !localFile ||
        (!!latestSha && localFile.sha256?.toLowerCase() !== latestSha.toLowerCase());
      if (latestSha && stale) {
        const ok = await download.run(latestSha, dest);
        if (!ok) {
          // The download failed but the lock is already held. Leaving the
          // STALE (or missing) local copy writable would invite editing an
          // outdated base and checking it in over a teammate's newer work —
          // roll the checkout back instead and surface why.
          await release.run(fileId);
          setRollbackErr(
            "couldn't download the latest version — check-out was rolled back. Try again.",
          );
          return;
        }
        // Record the freshly-downloaded latest version in the ledger (T6).
        recordLedger({ folderId, fileName, folders, vaultId }, latestSha);
      }
      await setReadonly(dest, false);
      flipSwReadonly(dest, false); // make it editable even if open in SW (no add-in needed)
    }
    onDone?.();
  }

  // Surface the hook's error like GetLatestButton — hover tells the user what
  // went wrong (e.g. "already checked out") and the button tints red instead
  // of silently doing nothing.
  const err = acquireLock.error?.message ?? rollbackErr;
  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={acquireLock.loading}
      title={err ? `Check-out failed: ${err}` : "Check out this file (lock it for editing)"}
      className={
        "rounded px-2 py-0.5 text-xs disabled:opacity-50 " +
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold " +
        (err
          ? "border border-[#EF5350] bg-[#EF5350]/10 text-[#EF5350] hover:bg-[#EF5350]/20"
          : "bg-asu-gold text-white hover:bg-asu-gold/90")
      }
    >
      {acquireLock.loading ? "…" : err ? "Retry" : "Check Out"}
    </button>
  );
}

export function CheckInButton({
  fileId, localFile, onDone, vaultRoot, folderId, fileName, folders, vaultId,
}: CheckInButtonProps) {
  const checkIn = useCheckIn();
  const recordRefs = useRecordRefs();
  const recordProperties = useRecordProperties();
  // The bytes to upload are read up-front (file dialog / disk) on click, then
  // held here while the comment modal is open. `null` = modal closed.
  const [pendingBytes, setPendingBytes] = useState<ArrayBuffer | null>(null);
  // Source path of the bytes being checked in — captured so we can parse the
  // file's assembly references after a successful check-in (see submit()).
  const pathRef = useRef<string | null>(null);

  async function readBytes(): Promise<ArrayBuffer | null> {
    // Prefer the scan-matched local file, but fall back to the canonical vault
    // working-copy path (vaultRoot + sanitized folder/name) when the scan didn't
    // match one. The background scan legitimately misses files — open in
    // SOLIDWORKS, a rescan still in flight, or a name that needed sanitizing —
    // and we must NOT then make the user hunt for a file that's already on disk.
    // Only prompt with a manual picker if neither candidate yields bytes.
    const candidate =
      localFile?.absolutePath ?? localTarget({ vaultRoot, folderId, fileName, folders });
    if (candidate) {
      try {
        const buf = await readArrayBuffer(candidate);
        pathRef.current = candidate;
        return buf;
      } catch {
        // Canonical copy missing / unreadable — fall through to the picker.
      }
    }
    const path = await openFileDialog({ multiple: false });
    if (!path || Array.isArray(path)) return null;
    pathRef.current = path;
    return readArrayBuffer(path);
  }

  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    // Read the bytes first, then open the in-app comment modal. Tauri's webview
    // doesn't render window.prompt() — it returns null — so the comment was
    // always lost (audit C1). The modal collects the comment in-app instead.
    const bytes = await readBytes();
    if (!bytes) return;
    setPendingBytes(bytes);
  }

  async function submit(comment: string | null) {
    if (!pendingBytes) return;
    const bytes = pendingBytes;
    setPendingBytes(null);
    const result = await checkIn.run(fileId, bytes, comment);
    if (result) {
      // The file is now the latest version and no longer checked out → make the
      // local copy read-only (real-vault). Prefer the actual file we read; fall
      // back to the computed vault path.
      const dest = localFile?.absolutePath ?? localTarget({ vaultRoot, folderId, fileName, folders });
      if (dest) { await setReadonly(dest, true); flipSwReadonly(dest, true); }
      // Record the just-checked-in content in the ledger (T6): the local copy
      // now matches result.sha256, so a later local delete is detectable.
      recordLedger({ folderId, fileName, folders, vaultId }, result.sha256);
      // Record this version's assembly references (best-effort, fire-and-forget
      // — must never block or fail the check-in the user just completed).
      const refName = localFile?.basename ?? fileName ?? "";
      if (pathRef.current && refName) {
        void recordRefs.run(result.id, pathRef.current, refName, vaultId);
        void recordProperties.run(result.id, pathRef.current, refName, true);
      }
      onDone?.();
    }
  }

  // Surface the hook's error like GetLatestButton — hover shows the failure
  // and the button tints red instead of silently doing nothing.
  const err = checkIn.error?.message ?? null;
  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={checkIn.loading}
        title={err ? `Check-in failed: ${err}` : "Check in your changes (uploads + releases the lock)"}
        className={
          "rounded px-2 py-0.5 text-xs disabled:opacity-50 " +
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold " +
          (err
            ? "border border-[#EF5350] bg-[#EF5350]/10 text-[#EF5350] hover:bg-[#EF5350]/20"
            : "bg-green-700 text-white hover:bg-green-600")
        }
      >
        {checkIn.loading ? "…" : err ? "Retry" : "Check In…"}
      </button>
      {pendingBytes && (
        <CheckInCommentModal
          loading={checkIn.loading}
          onSubmit={(comment) => { void submit(comment); }}
          onCancel={() => setPendingBytes(null)}
        />
      )}
    </>
  );
}

/**
 * In-app comment prompt for check-in. Mirrors the prompt modal in
 * BrowseScreen — Tauri's webview can't render window.prompt(). Submit runs
 * check-in with the typed comment; Skip runs it with a null comment; Cancel
 * aborts entirely. Escape closes (treated as cancel); focus is trapped and
 * restored per the modal a11y convention.
 */
function CheckInCommentModal({
  loading,
  onSubmit,
  onCancel,
}: {
  loading: boolean;
  onSubmit: (comment: string | null) => void;
  onCancel: () => void;
}) {
  const [comment, setComment] = useState("");
  const dialogRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const restoreTo = document.activeElement as HTMLElement | null;
    textareaRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
        return;
      }
      if (e.key === "Tab") {
        // Focus-trap: cycle Tab/Shift+Tab within the dialog.
        const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
          'textarea, button, [href], input, select, [tabindex]:not([tabindex="-1"])',
        );
        if (!focusables || focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      restoreTo?.focus?.();
    };
  }, [onCancel]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = comment.trim();
    onSubmit(trimmed.length > 0 ? trimmed : null);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onCancel}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Check-in comment"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="w-80 space-y-3 rounded-lg border border-helios-line bg-helios-panel p-4 shadow-lg"
      >
        <h3 className="text-sm font-semibold text-helios-text">Check-in comment</h3>
        <textarea
          ref={textareaRef}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={3}
          placeholder="Describe what changed (optional)"
          className="w-full resize-none rounded border border-helios-line bg-helios-base px-2 py-1 text-sm text-helios-text placeholder-helios-dim focus:outline-none focus:ring-1 focus:ring-asu-gold"
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="rounded px-3 py-1 text-xs text-helios-dim hover:bg-helios-line disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSubmit(null)}
            disabled={loading}
            className="rounded border border-helios-line px-3 py-1 text-xs text-helios-text hover:bg-helios-line disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
          >
            Skip
          </button>
          <button
            type="submit"
            disabled={loading}
            className="rounded bg-green-700 px-3 py-1 text-xs text-white hover:bg-green-600 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
          >
            Submit
          </button>
        </div>
      </form>
    </div>
  );
}

interface GetLatestButtonProps {
  fileId: FileId;
  fileName: string;
  folderId: FolderId | null;
  latestSha: string | null;
  vaultRoot: string | null;
  folders: Folder[];
  /** Active vault id — records a successful into-vault download in the ledger. */
  vaultId?: string | null;
  onDone?: () => void;
  /**
   * Visual + behavioral variant.
   *
   *  - "auto"   (default) — classic "Get Latest". Requires `vaultRoot`; writes
   *    straight to the local vault path. Hidden if there's no vault folder
   *    configured (auto-sync would have handled it anyway).
   *  - "manual" — explicit user-driven download. If `vaultRoot` is set we
   *    still write to the canonical path. If not, we prompt the user with a
   *    system save dialog so they can choose where the bytes land. Button
   *    label switches to "Download" to match the manual-mode mental model.
   */
  variant?: "auto" | "manual";
}

export function GetLatestButton({
  fileId: _fileId,
  fileName,
  folderId,
  latestSha,
  vaultRoot,
  folders,
  vaultId,
  onDone,
  variant = "auto",
}: GetLatestButtonProps) {
  const download = useDownloadVersion();
  // Without a version sha we can't download anything — keep the row clean.
  if (!latestSha) return null;
  // Auto-mode keeps its original "needs a vault folder" gate. Manual mode
  // works with or without a vault folder (it falls back to save dialog).
  if (variant === "auto" && !vaultRoot) return null;

  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    let dest: string;
    let intoVault = false;
    if (vaultRoot) {
      dest = localDestPath(vaultRoot, folderId, fileName, folders);
      intoVault = true;
    } else {
      // No vault folder configured + manual mode → ask the user where to put
      // it. Default the suggested filename so the dialog is one click for the
      // common case.
      const picked = await saveFileDialog({ defaultPath: fileName });
      if (!picked || typeof picked !== "string") return;
      dest = picked;
    }
    const ok = await download.run(latestSha!, dest);
    if (ok) {
      // A file downloaded into the vault folder is a non-checked-out copy →
      // read-only (real-vault), even in manual mode where auto-sync's
      // reconciliation never runs. Don't touch a user-chosen save-dialog path
      // outside the vault.
      if (intoVault) {
        await setReadonly(dest, true);
        // Only an into-vault download materializes the canonical local copy the
        // ledger tracks — a save-dialog path elsewhere isn't a vault copy (T6).
        recordLedger({ folderId, fileName, folders, vaultId }, latestSha);
      }
      onDone?.();
    }
  }

  // Failures used to be silent — click, "…" flash, nothing. Surface the
  // error message via title so a hover tells the user what went wrong;
  // also tint the button red so it's obvious the action didn't take.
  const err = download.error?.message ?? null;
  const isManual = variant === "manual";
  const idleLabel = isManual ? "Download" : "Get Latest";
  const title = err
    ? `Download failed: ${err}`
    : isManual
      ? (vaultRoot
          ? "Download latest version to local vault folder"
          : "Choose where to save the latest version")
      : "Download latest version to local vault folder";
  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={download.loading}
      className={
        "rounded border px-2 py-0.5 text-xs disabled:opacity-50 " +
        (err
          ? "border-[#EF5350] bg-[#EF5350]/10 text-[#EF5350] hover:bg-[#EF5350]/20"
          : "border-helios-line text-helios-text hover:bg-helios-line")
      }
      title={title}
    >
      {download.loading ? "…" : err ? "Retry" : idleLabel}
    </button>
  );
}

interface GetVersionButtonProps {
  version: Version;
  fileName: string;
  folderId: FolderId | null;
  vaultRoot: string | null;
  folders: Folder[];
  onDone?: () => void;
}

/**
 * SW-PDM "Get Version": download a SPECIFIC (usually older) version of a file
 * to the local working copy. Non-destructive to vault history — it does NOT
 * check the file out, acquire a lock, or create a new version; it only
 * retrieves the chosen version's bytes (every version carries its own sha256).
 *
 *  - With a vault folder configured we write to the canonical local path. That
 *    OVERWRITES the local working copy (and would discard local edits if the
 *    file is checked out), so we confirm first, then leave the copy read-only —
 *    it's a non-checked-out copy in the real-vault model.
 *  - Without a vault folder we prompt a save dialog so the user chooses where
 *    the bytes land, and never touch the read-only bit on a path of their own.
 */
export function GetVersionButton({
  version, fileName, folderId, vaultRoot, folders, onDone,
}: GetVersionButtonProps) {
  const download = useDownloadVersion();
  const [confirming, setConfirming] = useState(false);
  // No content to fetch without a sha — keep the row clean.
  if (!version.sha256) return null;

  async function doGet() {
    let dest: string;
    let intoVault = false;
    if (vaultRoot) {
      dest = localDestPath(vaultRoot, folderId, fileName, folders);
      intoVault = true;
    } else {
      const picked = await saveFileDialog({ defaultPath: fileName });
      if (!picked || typeof picked !== "string") return;
      dest = picked;
    }
    const ok = await download.run(version.sha256, dest);
    if (ok) {
      // A version pulled into the vault folder is a non-checked-out copy →
      // read-only. A user-chosen save path outside the vault is left untouched.
      if (intoVault) await setReadonly(dest, true);
      onDone?.();
    }
  }

  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    // Into-vault overwrites the local working copy → confirm before discarding.
    // A save-dialog path is a fresh location the user picks, so go straight there.
    if (vaultRoot) setConfirming(true);
    else await doGet();
  }

  const err = download.error?.message ?? null;
  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={download.loading}
        title={
          err
            ? `Get version failed: ${err}`
            : `Download version ${version.version_num} to your local copy (read-only — does not check out or create a new version)`
        }
        className={
          "rounded border px-2 py-0.5 text-xs disabled:opacity-50 " +
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold " +
          (err
            ? "border-[#EF5350] bg-[#EF5350]/10 text-[#EF5350] hover:bg-[#EF5350]/20"
            : "border-helios-line text-helios-text hover:bg-helios-line")
        }
      >
        {download.loading ? "…" : err ? "Retry" : "Get"}
      </button>
      {confirming && (
        <ConfirmDialog
          title={`Get version ${version.version_num}?`}
          body={`This replaces your local copy of ${fileName} with version ${version.version_num} and leaves it read-only. Any local changes will be discarded. It does not check the file out or create a new version.`}
          confirmLabel="Get this version"
          confirmTone="danger"
          cancelLabel="Cancel"
          onConfirm={() => { void doGet(); }}
          onClose={() => setConfirming(false)}
        />
      )}
    </>
  );
}

interface RestoreVersionButtonProps {
  version: Version;
  fileId: FileId;
  fileName: string;
  folderId: FolderId | null;
  vaultRoot: string | null;
  folders: Folder[];
  vaultId?: string | null;
  onDone?: () => void;
}

/**
 * SW-PDM "Rollback": make an old version the file's NEW LATEST. Server-side
 * it's a check-in of that version's content (requires the caller's active
 * lock, releases it on success, carries the data card + refs forward) — no
 * upload happens because the bucket already holds the bytes for that sha.
 * History is never destroyed: the previous latest stays as an older version.
 */
export function RestoreVersionButton({
  version, fileId, fileName, folderId, vaultRoot, folders, vaultId, onDone,
}: RestoreVersionButtonProps) {
  const restore = useRestoreVersion();
  const download = useDownloadVersion();
  const [confirming, setConfirming] = useState(false);
  if (!version.sha256) return null;

  async function doRestore() {
    const restored = await restore.run(fileId, version.id);
    if (!restored) return;
    // Materialize the restored content locally (read-only — the lock was
    // released by the RPC, exactly like a check-in). Best-effort: the vault
    // row is already correct; a failed download self-heals on the next sync.
    const dest = localTarget({ vaultRoot, folderId, fileName, folders });
    if (dest && restored.sha256) {
      const ok = await download.run(restored.sha256, dest);
      if (ok) {
        recordLedger({ folderId, fileName, folders, vaultId }, restored.sha256);
        await setReadonly(dest, true);
      }
    }
    onDone?.();
  }

  const err = restore.error?.message ?? null;
  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setConfirming(true); }}
        disabled={restore.loading || download.loading}
        title={
          err
            ? `Restore failed: ${err}`
            : `Make version ${version.version_num} the new latest (requires the file to be checked out by you; checks it back in with this version's content)`
        }
        className={
          "rounded border px-2 py-0.5 text-xs disabled:opacity-50 " +
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold " +
          (err
            ? "border-[#EF5350] bg-[#EF5350]/10 text-[#EF5350] hover:bg-[#EF5350]/20"
            : "border-asu-gold/50 text-asu-gold hover:bg-asu-gold/10")
        }
      >
        {restore.loading || download.loading ? "…" : err ? "Retry" : "Restore"}
      </button>
      {confirming && (
        <ConfirmDialog
          title={`Restore version ${version.version_num}?`}
          body={`This checks ${fileName} back in with version ${version.version_num}'s content, making it the new latest version. Nothing is deleted — the current latest stays in history. Requires the file to be checked out by you; your checkout is released when it completes.`}
          confirmLabel="Restore as latest"
          confirmTone="danger"
          cancelLabel="Cancel"
          onConfirm={() => { void doRestore(); }}
          onClose={() => setConfirming(false)}
        />
      )}
    </>
  );
}

export function CancelButton({
  fileId, onDone, vaultRoot, folderId, fileName, folders, vaultId, latestSha,
}: ActionProps) {
  const releaseLock = useReleaseLock();
  const download = useDownloadVersion();
  const deleteFile = useDeleteFile();
  const [confirming, setConfirming] = useState(false);
  // The lock release and the restore are two steps; if the restore fails the
  // lock is ALREADY released — "Retry" must only re-run the restore, never
  // call releaseLock again (it would error and mask the real state).
  const [released, setReleased] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  // Never-checked-in draft: there is no vaulted version to restore. Undo
  // check-out then means "discard the draft" (SW PDM: an added-but-never-
  // checked-in file doesn't exist for anyone else) — soft-delete the row
  // (which releases the lock server-side); the deleted-file reaper removes
  // the local copy.
  const isDraft = !latestSha;

  async function doDiscardDraft() {
    const ok = await deleteFile.run(fileId);
    if (!ok) return;
    onDone?.();
  }

  async function doRelease() {
    setRestoreError(null);
    let ok = released;
    if (!ok) {
      ok = await releaseLock.run(fileId);
      if (!ok) return;
      setReleased(true);
    }
    // Undo check-out (real-vault): discard local edits + restore the latest
    // vaulted version, then read-only. Done here so it works in manual mode
    // too (not only via auto-sync). The download clears read-only before the
    // write, so restoring over a read-only file is safe.
    const dest = localTarget({ vaultRoot, folderId, fileName, folders });
    if (dest && latestSha) {
      // Restore the latest version (discarding local edits), THEN read-only —
      // but only freeze if the restore actually SUCCEEDED. On a failed download
      // the local edit is still on disk; leaving it writable keeps the
      // held-back rule protecting it. A read-only-but-dirty file would look like
      // a clean stale copy and get clobbered on the next pass.
      const restored = await download.run(latestSha, dest);
      if (!restored) {
        // The lock IS released but the latest version was NOT restored — the
        // local edit is still on disk (writable + held back). Surface it and
        // offer Retry (restore only) instead of silently signalling success.
        setRestoreError(download.error?.message ?? "could not restore the latest version");
        return;
      }
      await setReadonly(dest, true); flipSwReadonly(dest, true);
      // Undo-checkout restored the latest vaulted version locally → record it
      // (T6): the local copy now matches latestSha and is ledger-tracked.
      recordLedger({ folderId, fileName, folders, vaultId }, latestSha);
    }
    onDone?.();
  }

  // Surface the release error like GetLatestButton — a silent no-op left the
  // user wondering whether the lock was actually released. A failed RESTORE
  // (lock already released) and a failed draft-discard surface the same way.
  const err = releaseLock.error?.message ?? deleteFile.error?.message ?? restoreError;
  return (
    <>
      <button
        type="button"
        // Undo check-out is destructive in the real-vault model: releasing the
        // lock lets auto-sync restore the latest version, discarding any local
        // edits. Confirm before doing it (in-app dialog — window.confirm is a
        // no-op in the Tauri webview).
        onClick={(e) => { e.stopPropagation(); setConfirming(true); }}
        disabled={releaseLock.loading || deleteFile.loading || download.loading}
        title={
          err
            ? `Cancel check-out failed: ${err}`
            : isDraft
              ? "Discard draft: remove this never-checked-in file from the vault (and your local copy)"
              : "Undo check-out: discard local changes and restore the latest version"
        }
        className={
          "ml-1 rounded px-2 py-0.5 text-xs disabled:opacity-50 " +
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold " +
          (err
            ? "border border-[#EF5350] bg-[#EF5350]/10 text-[#EF5350] hover:bg-[#EF5350]/20"
            : "bg-helios-line text-white hover:brightness-110")
        }
      >
        {releaseLock.loading || deleteFile.loading || download.loading ? "…" : err ? "Retry" : "Cancel"}
      </button>
      {confirming && (
        <ConfirmDialog
          title={isDraft ? "Discard draft?" : "Undo check-out?"}
          body={
            isDraft
              ? "This file has never been checked in. Discarding removes it from the vault and deletes your local copy — there is no version to restore."
              : "This releases your lock and restores the latest vaulted version. Any local changes you made to this file will be discarded."
          }
          confirmLabel={isDraft ? "Discard draft" : "Discard & undo"}
          confirmTone="danger"
          cancelLabel="Keep editing"
          onConfirm={() => { void (isDraft ? doDiscardDraft() : doRelease()); }}
          onClose={() => setConfirming(false)}
        />
      )}
    </>
  );
}
