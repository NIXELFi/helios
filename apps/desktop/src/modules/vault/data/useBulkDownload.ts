import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDirDialog } from "@tauri-apps/plugin-dialog";
import { useSupabaseClient } from "@helios/auth";
import { downloadVersionOnce } from "./useDownloadVersion";
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
  /** Names of files currently in flight in the worker pool. */
  active: string[];
}

export interface BulkDownloadAPI extends BulkDownloadState {
  start: (files: VaultFile[]) => void;
  cancel: () => void;
  close: () => void;
}

/**
 * Worker count for parallel downloads. Each worker does fetch + arrayBuffer
 * + gunzip + Tauri writeFile. Pushing too many saturates the webview IPC
 * bridge and can stutter the UI; manual bulk downloads run with a progress
 * modal that consumes most paint frames anyway, so we push harder than the
 * auto-sync default. 8 saturates typical residential upstream + the Tauri
 * fs plugin without obvious jank on Apple-Silicon laptops; if a slower
 * machine struggles we'll dial back.
 */
const WORKERS = 8;

/**
 * Headless bulk-download driver with a worker pool. Caller picks the
 * destination model — either supplies `vaultRoot` (auto-derived per-vault
 * subfolder under the user's Helios folder) or null, in which case the user
 * is prompted once per run for a destination directory.
 */
export function useBulkDownload(opts: {
  vaultRoot: string | null;
  folders: Folder[];
  versionsByFileId: Map<FileId, Version[]>;
  onDone?: () => void;
}): BulkDownloadAPI {
  const { vaultRoot, folders, versionsByFileId, onDone } = opts;
  const client = useSupabaseClient();
  const [running, setRunning] = useState(false);
  const [open, setOpen] = useState(false);
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState(0);
  const [errs, setErrs] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);
  const [active, setActive] = useState<string[]>([]);
  const cancelRef = useRef(false);
  const startedAtRef = useRef<number | null>(null);
  const bytesDoneRef = useRef(0);
  const [, setRateTick] = useState(0);

  // Force re-render every 500ms while running so rate/elapsed labels refresh.
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
    setActive([]);
    bytesDoneRef.current = 0;
    cancelRef.current = false;
    startedAtRef.current = Date.now();

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

    // Worker pool — N parallel workers pull from a shared cursor. activeIds
    // tracks "in-flight" so the modal can show concurrent filenames.
    const activeMap = new Map<FileId, string>();
    let cursor = 0;
    const refreshActive = () => setActive(Array.from(activeMap.values()));
    async function worker() {
      while (!cancelRef.current) {
        const i = cursor++;
        if (i >= downloadable.length) return;
        const file = downloadable[i]!;
        const version = versionsByFileId.get(file.id)?.[0];
        if (!version) continue;
        activeMap.set(file.id, file.name);
        refreshActive();
        const dest = localDestPath(root!, file.folder_id, file.name, folders);
        const result = await downloadVersionOnce(client, version.sha256, dest);
        activeMap.delete(file.id);
        refreshActive();
        if (result.ok) {
          bytesDoneRef.current += version.size_bytes ?? 0;
          setDone((d) => d + 1);
        } else {
          setErrs((e) => e + 1);
          setLastError(result.error);
        }
      }
    }
    const workerCount = Math.min(WORKERS, downloadable.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    setRunning(false);
    setActive([]);
    onDone?.();
  }, [vaultRoot, folders, versionsByFileId, client, onDone]);

  const cancel = useCallback(() => { cancelRef.current = true; }, []);
  const close = useCallback(() => { if (!running) setOpen(false); }, [running]);

  return {
    running, open, total, done, errs,
    bytesDone: bytesDoneRef.current,
    // For backwards-compat the legacy modal reads `current` (single name);
    // populate it from the active list's first entry.
    current: active[0] ?? null,
    active,
    lastError,
    startedAt: startedAtRef.current,
    start, cancel, close,
  };
}
