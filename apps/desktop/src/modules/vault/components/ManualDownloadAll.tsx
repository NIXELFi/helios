import { useEffect, useRef, useState } from "react";
import { open as openDirDialog } from "@tauri-apps/plugin-dialog";
import { useDownloadVersion } from "../data/useDownloadVersion";
import { localDestPath } from "../data/folder-paths";
import type { FileId, Folder, VaultFile, Version } from "../data/types";

interface Props {
  /** Files to download (current folder view, or vault root). */
  files: VaultFile[];
  /** Map file_id → latest version array (only [0] is used). */
  versionsByFileId: Map<FileId, Version[]>;
  /** The active vault's local folder, if configured. Null → prompt for a dir. */
  vaultRoot: string | null;
  /** Folder rows needed to reconstruct relative paths. */
  folders: Folder[];
  /** Called once the run finishes (any outcome) so the parent can refetch. */
  onDone?: () => void;
}

/**
 * "Download all" — manual-mode bulk pull of every file in the current view.
 *
 * One file at a time (sequential) — keeps progress predictable + avoids Tauri
 * fs contention. The bottleneck is the storage GET, not local disk, so
 * single-stream throughput is roughly the same as parallel for one machine.
 *
 * Idempotent across re-runs — already-downloaded files are simply re-fetched
 * with the latest sha (no on-disk dedupe).
 */
export function ManualDownloadAll({
  files,
  versionsByFileId,
  vaultRoot,
  folders,
  onDone,
}: Props) {
  const download = useDownloadVersion();
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [errs, setErrs] = useState(0);
  const [current, setCurrent] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const cancelRef = useRef(false);
  const startedAtRef = useRef<number | null>(null);
  const bytesDoneRef = useRef(0);
  const [, setRateTick] = useState(0);

  // Recompute the rate label every 500ms while the run is active so the user
  // sees throughput instead of a frozen number.
  useEffect(() => {
    if (!open || !running) return;
    const id = window.setInterval(() => setRateTick((t) => t + 1), 500);
    return () => window.clearInterval(id);
  }, [open, running]);

  // Only consider files that actually have a latest version + sha.
  const downloadable = files.filter((f) => {
    const v = versionsByFileId.get(f.id)?.[0];
    return v && v.sha256;
  });
  const total = downloadable.length;
  if (total === 0) return null;

  async function pickDestRoot(): Promise<string | null> {
    const picked = await openDirDialog({ directory: true, multiple: false });
    if (!picked || Array.isArray(picked)) return null;
    return picked;
  }

  async function start() {
    setOpen(true);
    setRunning(true);
    setDone(0);
    setErrs(0);
    setLastError(null);
    setCurrent(null);
    bytesDoneRef.current = 0;
    cancelRef.current = false;
    startedAtRef.current = Date.now();

    const root = vaultRoot ?? (await pickDestRoot());
    if (!root) {
      setRunning(false);
      setOpen(false);
      return;
    }

    for (const file of downloadable) {
      if (cancelRef.current) break;
      const version = versionsByFileId.get(file.id)?.[0];
      if (!version) continue;
      setCurrent(file.name);
      const dest = localDestPath(root, file.folder_id, file.name, folders);
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
  }

  const elapsedMs = startedAtRef.current ? Date.now() - startedAtRef.current : 0;
  const mb = bytesDoneRef.current / 1024 / 1024;
  const rate = elapsedMs > 0 ? mb / (elapsedMs / 1000) : 0;
  const pct = total > 0 ? Math.floor(((done + errs) / total) * 100) : 0;

  return (
    <>
      <button
        type="button"
        onClick={start}
        disabled={running}
        className="rounded border border-helios-line bg-helios-base px-2 py-0.5 text-xs text-helios-text hover:bg-helios-line disabled:opacity-50"
        title={
          vaultRoot
            ? `Download all ${total} files in this view to ${vaultRoot}`
            : `Download all ${total} files — you'll be prompted for a destination`
        }
      >
        Download all ({total})
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => { if (!running) setOpen(false); }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-[28rem] rounded-lg border border-helios-line bg-helios-panel p-5 shadow-xl"
          >
            <h3 className="mb-2 text-sm font-semibold text-helios-text">
              Downloading {total} files
            </h3>
            <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-helios-line">
              <div
                className="h-full bg-asu-gold transition-[width] duration-200"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="mb-3 flex justify-between text-xs text-helios-dim">
              <span>
                {done}/{total} done
                {errs > 0 && <span className="text-[#EF5350]"> · {errs} failed</span>}
              </span>
              <span className="font-mono-num">
                {mb.toFixed(1)} MB · {rate.toFixed(1)} MB/s
              </span>
            </div>
            <div
              className="mb-3 truncate font-mono-num text-[11px] text-helios-text"
              title={current ?? ""}
            >
              {current ?? (running ? "Starting…" : "Done")}
            </div>
            {lastError && (
              <div className="mb-3 text-[11px] text-[#EF5350]">
                Last error: {lastError}
              </div>
            )}
            <div className="flex justify-end gap-2">
              {running ? (
                <button
                  type="button"
                  onClick={() => { cancelRef.current = true; }}
                  className="rounded border border-helios-line px-3 py-1 text-xs text-helios-dim hover:text-helios-text"
                >
                  Cancel
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded bg-asu-gold px-3 py-1 text-xs text-white hover:bg-asu-gold"
                >
                  Close
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
