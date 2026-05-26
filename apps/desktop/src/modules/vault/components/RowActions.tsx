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

  return (
    <button
      onClick={handleClick}
      disabled={acquireLock.loading}
      className="rounded bg-asu-gold px-2 py-0.5 text-xs text-white hover:bg-asu-gold disabled:opacity-50"
    >
      Check Out
    </button>
  );
}

export function CheckInButton({ fileId, localFile, onDone }: CheckInButtonProps) {
  const checkIn = useCheckIn();

  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    let bytes: ArrayBuffer;
    if (localFile) {
      const fileBytes = await readFile(localFile.absolutePath);
      bytes = fileBytes.buffer.slice(
        fileBytes.byteOffset,
        fileBytes.byteOffset + fileBytes.byteLength,
      ) as ArrayBuffer;
    } else {
      const path = await openFileDialog({ multiple: false });
      if (!path || Array.isArray(path)) return;
      const fileBytes = await readFile(path);
      bytes = fileBytes.buffer.slice(
        fileBytes.byteOffset,
        fileBytes.byteOffset + fileBytes.byteLength,
      ) as ArrayBuffer;
    }
    const comment = window.prompt("Check-in comment (optional):") ?? null;
    const result = await checkIn.run(fileId, bytes, comment);
    if (result) onDone?.();
  }

  return (
    <button
      onClick={handleClick}
      disabled={checkIn.loading}
      className="rounded bg-green-700 px-2 py-0.5 text-xs text-white hover:bg-green-600 disabled:opacity-50"
    >
      Check In…
    </button>
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

  return (
    <button
      onClick={handleClick}
      disabled={releaseLock.loading}
      className="ml-1 rounded bg-helios-line px-2 py-0.5 text-xs text-white hover:bg-helios-line disabled:opacity-50"
    >
      Cancel
    </button>
  );
}
