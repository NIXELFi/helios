import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
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
}

export function GetLatestButton({
  fileId: _fileId,
  fileName,
  folderId,
  latestSha,
  vaultRoot,
  folders,
  onDone,
}: GetLatestButtonProps) {
  const download = useDownloadVersion();
  if (!latestSha || !vaultRoot) return null;

  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    const dest = localDestPath(vaultRoot!, folderId, fileName, folders);
    const ok = await download.run(latestSha!, dest);
    if (ok) onDone?.();
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={download.loading}
      className="rounded border border-helios-line px-2 py-0.5 text-xs text-helios-text hover:bg-helios-line disabled:opacity-50"
      title="Download latest version to local vault folder"
    >
      {download.loading ? "…" : "Get Latest"}
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
