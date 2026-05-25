import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDirDialog } from "@tauri-apps/plugin-dialog";
import { useDownloadVersion } from "./useDownloadVersion";
import { localDestPath } from "./folder-paths";
import type { FileId, Folder, VaultFile, Version } from "./types";

export interface BulkDownloadState {
  running: boolean;
  open: boolean;
  total: number;
  done: number;
  errs: number;
  bytesDone: number;
  current: string | null;
  lastError: string | null;
  startedAt: number | null;
}

export interface BulkDownloadAPI extends BulkDownloadState {
  /** Kick off a bulk download. Opens the progress modal automatically. */
  start: (files: VaultFile[]) => void;
  /** User cancels the in-progress run. */
  cancel: () => void;
  /** Close the modal once finished. No-op while running. */
  close: () => void;
}

/**
 * Headless bulk-download driver: one file at a time, sequential. Caller
 * picks the destination model — either supplies `vaultRoot` (auto-derived
 * per-vault subfolder under the user's Helios folder) or null, in which
 * case the user is prompted once per run for a destination directory.
 *
 * The hook exposes both the in-flight state (rendered by a modal) and the
 * `start(files)` trigger. ManualDownloadAll and the FolderTree context
 * menu both use this so behavior + UI stay consistent.
 */
export function useBulkDownload(opts: {
  vaultRoot: string | null;
  folders: Folder[];
  versionsByFileId: Map<FileId, Version[]>;
  onDone?: () => void;
}): BulkDownloadAPI {
  const { vaultRoot, folders, versionsByFileId, onDone } = opts;
  const download = useDownloadVersion();
  const [running, setRunning] = useState(false);
  const [open, setOpen] = useState(false);
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState(0);
  const [errs, setErrs] = useState(0);
  const [current, setCurrent] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const cancelRef = useRef(false);
  const startedAtRef = useRef<number | null>(null);
  const bytesDoneRef = useRef(0);
  const [, setRateTick] = useState(0);

  // Force re-render every 500ms while running so the rate/elapsed labels
  // refresh without leaking ticks when idle.
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setRateTick((t) => t + 1), 500);
    return () => window.clearInterval(id);
  }, [running]);

  const start = useCallback(async (rawFiles: VaultFile[]) => {
    const downloadable = rawFiles.filter((f) => {
      const v = versionsByFileId.get(f.id)?.[0];
      return v && v.sha256;
    });
    if (downloadable.length === 0) return;

    setOpen(true);
    setRunning(true);
    setTotal(downloadable.length);
    setDone(0);
    setErrs(0);
    setLastError(null);
    setCurrent(null);
    bytesDoneRef.current = 0;
    cancelRef.current = false;
    startedAtRef.current = Date.now();

    // Destination: configured vault root, else prompt the user once.
    let root = vaultRoot;
    if (!root) {
      const picked = await openDirDialog({ directory: true, multiple: false });
      if (!picked || Array.isArray(picked)) {
        setRunning(false);
        setOpen(false);
        return;
      }
      root = picked;
    }

    for (const file of downloadable) {
      if (cancelRef.current) break;
      const version = versionsByFileId.get(file.id)?.[0];
      if (!version) continue;
      setCurrent(file.name);
      const dest = localDestPath(root!, file.folder_id, file.name, folders);
      const ok = await download.run(version.sha256, dest);
      if (ok) {
        bytesDoneRef.current += version.size_bytes ?? 0;
        setDone((d) => d + 1);
      } else {
        setErrs((e) => e + 1);
        setLastError(download.error?.message ?? "download failed");
      }
    }
    setRunning(false);
    setCurrent(null);
    onDone?.();
  }, [vaultRoot, folders, versionsByFileId, download, onDone]);

  const cancel = useCallback(() => { cancelRef.current = true; }, []);
  const close = useCallback(() => { if (!running) setOpen(false); }, [running]);

  return {
    running, open, total, done, errs,
    bytesDone: bytesDoneRef.current,
    current, lastError,
    startedAt: startedAtRef.current,
    start, cancel, close,
  };
}
