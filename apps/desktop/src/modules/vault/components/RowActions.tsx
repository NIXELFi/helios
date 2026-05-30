import { useEffect, useRef, useState } from "react";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { useAcquireLock } from "../data/useAcquireLock";
import { useCheckIn } from "../data/useCheckIn";
import { useReleaseLock } from "../data/useReleaseLock";
import { useDownloadVersion } from "../data/useDownloadVersion";
import { localDestPath } from "../data/folder-paths";
import type { FileId, FolderId, Folder } from "../data/types";
import type { LocalFile } from "../data/useLocalFolderScan";

interface ActionProps {
  fileId: FileId;
  onDone?: () => void;
}

interface CheckInButtonProps {
  fileId: FileId;
  localFile?: LocalFile;
  onDone?: () => void;
}

export function CheckOutButton({ fileId, onDone }: ActionProps) {
  const acquireLock = useAcquireLock();

  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    const result = await acquireLock.run(fileId);
    if (result) onDone?.();
  }

  // Surface the hook's error like GetLatestButton — hover tells the user what
  // went wrong (e.g. "already checked out") and the button tints red instead
  // of silently doing nothing.
  const err = acquireLock.error?.message ?? null;
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

export function CheckInButton({ fileId, localFile, onDone }: CheckInButtonProps) {
  const checkIn = useCheckIn();
  // The bytes to upload are read up-front (file dialog / disk) on click, then
  // held here while the comment modal is open. `null` = modal closed.
  const [pendingBytes, setPendingBytes] = useState<ArrayBuffer | null>(null);

  async function readBytes(): Promise<ArrayBuffer | null> {
    if (localFile) {
      const fileBytes = await readFile(localFile.absolutePath);
      return fileBytes.buffer.slice(
        fileBytes.byteOffset,
        fileBytes.byteOffset + fileBytes.byteLength,
      ) as ArrayBuffer;
    }
    const path = await openFileDialog({ multiple: false });
    if (!path || Array.isArray(path)) return null;
    const fileBytes = await readFile(path);
    return fileBytes.buffer.slice(
      fileBytes.byteOffset,
      fileBytes.byteOffset + fileBytes.byteLength,
    ) as ArrayBuffer;
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
    if (result) onDone?.();
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
    if (vaultRoot) {
      dest = localDestPath(vaultRoot, folderId, fileName, folders);
    } else {
      // No vault folder configured + manual mode → ask the user where to put
      // it. Default the suggested filename so the dialog is one click for the
      // common case.
      const picked = await saveFileDialog({ defaultPath: fileName });
      if (!picked || typeof picked !== "string") return;
      dest = picked;
    }
    const ok = await download.run(latestSha!, dest);
    if (ok) onDone?.();
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

export function CancelButton({ fileId, onDone }: ActionProps) {
  const releaseLock = useReleaseLock();

  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    const ok = await releaseLock.run(fileId);
    if (ok) onDone?.();
  }

  // Surface the release error like GetLatestButton — a silent no-op left the
  // user wondering whether the lock was actually released.
  const err = releaseLock.error?.message ?? null;
  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={releaseLock.loading}
      title={err ? `Cancel check-out failed: ${err}` : "Discard your check-out and release the lock"}
      className={
        "ml-1 rounded px-2 py-0.5 text-xs disabled:opacity-50 " +
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold " +
        (err
          ? "border border-[#EF5350] bg-[#EF5350]/10 text-[#EF5350] hover:bg-[#EF5350]/20"
          : "bg-helios-line text-white hover:brightness-110")
      }
    >
      {releaseLock.loading ? "…" : err ? "Retry" : "Cancel"}
    </button>
  );
}
