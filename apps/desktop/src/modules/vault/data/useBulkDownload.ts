import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDirDialog } from "@tauri-apps/plugin-dialog";
import { stat, readFile } from "@tauri-apps/plugin-fs";
import { useSupabaseClient } from "@helios/auth";
import { downloadVersionOnce } from "./useDownloadVersion";
import { setReadonly } from "./fs-readonly";
import { localDestPath, vaultRelPathFor } from "./folder-paths";
import { ledgerRecord } from "./sync-ledger";
import { sanitizeVaultName } from "./useVaultFolder";
import type { FileId, Folder, VaultFile, Version } from "./types";

function joinDir(a: string, b: string): string {
  return `${a.replace(/\/+$/, "")}/${b}`;
}

/** SHA-256 of raw bytes as lowercase hex. A version's sha256 identifies the
 *  ORIGINAL uncompressed content, and a local vault file is that same
 *  uncompressed content, so hashing the local bytes and comparing to
 *  version.sha256 is an exact content-equality check. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface BulkDownloadState {
  running: boolean;
  open: boolean;
  total: number;
  done: number;
  errs: number;
  /** Files we skipped because the local copy is already up-to-date (its
   *  content hash matches the latest version). */
  skipped: number;
  /** Files whose local copy differs from the latest version (different size,
   *  or same size but different content hash). Left untouched to avoid
   *  clobbering a possible local edit — surfaced so the run does NOT falsely
   *  report everything as synced. */
  stale: number;
  bytesDone: number;
  current: string | null;
  lastError: string | null;
  startedAt: number | null;
  /** Files currently in flight — `{ id, name }` so React keys don't collide
      when two files in different folders happen to share a filename. */
  active: Array<{ id: FileId; name: string }>;
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
  /** Shared "Helios folder" the user picked in Settings, or null. */
  heliosRoot: string | null;
  /** Active vault's display name — used to nest each vault into its own
   *  subfolder under heliosRoot. If null, no vault subfolder is applied. */
  vaultName: string | null;
  /** Active vault id — records each successful download in the sync ledger so
   *  a later local delete is distinguishable from "never downloaded". Null
   *  disables ledger recording (manual download still works). */
  vaultId?: string | null;
  folders: Folder[];
  versionsByFileId: Map<FileId, Version[]>;
  /** If we have to prompt the user for a destination (heliosRoot was null),
   *  optionally save the chosen parent as the Helios root so future runs
   *  don't re-prompt. Falsy → just use the picked path for this run only. */
  onPickedRoot?: (root: string) => void;
  onDone?: () => void;
}): BulkDownloadAPI {
  const { heliosRoot, vaultName, vaultId, folders, versionsByFileId, onPickedRoot, onDone } = opts;
  const client = useSupabaseClient();
  const [running, setRunning] = useState(false);
  const [open, setOpen] = useState(false);
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState(0);
  const [errs, setErrs] = useState(0);
  const [skipped, setSkipped] = useState(0);
  const [stale, setStale] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);
  const [active, setActive] = useState<Array<{ id: FileId; name: string }>>([]);
  // Monotonic generation counter. Each start() captures a new generation;
  // cancel() and a subsequent start() both increment it. Workers carry their
  // captured generation through every loop iteration and the post-await
  // settle; when their generation no longer matches genRef.current, they
  // exit immediately and stop touching shared state.
  //
  // The previous boolean cancelRef had a Cancel→Start race: start() reset it
  // to false, so any in-flight worker whose download was still awaiting would
  // see the flag flip back, loop, and pull the next item from its (now-stale)
  // downloadable closure — leaking run-1 work into run-2's pool.
  const genRef = useRef(0);
  // AbortController for the active run. Cancel and start both abort the
  // previous controller so downloadVersionOnce drops in-flight bytes before
  // their terminal writeFile — guarantees Cancel actually halts disk writes,
  // not just future iterations of the worker loop.
  const abortRef = useRef<AbortController | null>(null);
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

    // Bump the generation. Any workers still alive from a previous run see
    // the mismatch on their next loop iteration / post-await check and exit.
    const myGen = ++genRef.current;
    // Abort the previous controller so any in-flight downloads from the
    // last run skip their writeFile, then start a fresh controller for this
    // run's downloads.
    abortRef.current?.abort();
    const myAbort = new AbortController();
    abortRef.current = myAbort;

    setOpen(true);
    setRunning(true);
    setTotal(downloadable.length);
    setDone(0);
    setErrs(0);
    setSkipped(0);
    setStale(0);
    setLastError(null);
    setActive([]);
    bytesDoneRef.current = 0;
    startedAtRef.current = Date.now();

    // Build the effective destination directory:
    //   <heliosRoot>/<sanitized vault name>/
    // If heliosRoot isn't set yet, prompt the user for a PARENT folder and
    // optionally persist it via onPickedRoot. Even when prompted, we always
    // append the vault-name subfolder so SDM26 and SDM27 stay separate on
    // disk. Previously the prompted path was used as-is, which dumped
    // SDM27's files into the SDM26 root — the user reported "loading SDM27
    // into the 5.3 folders root".
    let parent = heliosRoot;
    if (!parent) {
      const picked = await openDirDialog({ directory: true, multiple: false });
      if (!picked || Array.isArray(picked)) {
        setRunning(false);
        setOpen(false);
        return;
      }
      parent = picked;
      onPickedRoot?.(parent);
    }
    const root = vaultName ? joinDir(parent, sanitizeVaultName(vaultName)) : parent;

    // Worker pool — N parallel workers pull from a shared cursor. The
    // active set is keyed by file id (unique) so two files in different
    // folders with the same name don't collide on the React render key.
    const activeMap = new Map<FileId, string>();
    let cursor = 0;
    const isCurrent = () => myGen === genRef.current;
    const refreshActive = () => {
      if (!isCurrent()) return;
      setActive(Array.from(activeMap.entries()).map(([id, name]) => ({ id, name })));
    };
    async function worker() {
      while (isCurrent()) {
        const i = cursor++;
        if (i >= downloadable.length) return;
        const file = downloadable[i]!;
        const version = versionsByFileId.get(file.id)?.[0];
        if (!version) continue;
        const dest = localDestPath(root!, file.folder_id, file.name, folders);

        // Skip-if-already-synced. The local copy is only considered current
        // when its CONTENT matches the latest version — size equality alone
        // is unsound because a revision can keep the exact same byte length,
        // and skipping it silently left the user on a stale file while the
        // run reported green (2026-05-29 audit, critical). So:
        //   - size differs            → can't be the latest version → stale
        //   - size matches, hash ==   → genuinely up to date         → skip
        //   - size matches, hash !=   → same-size revision/edit       → stale
        // "stale" files are left on disk untouched (never clobber a possible
        // local edit) but counted separately so the summary doesn't claim
        // everything is synced. We only pay the read+hash cost on a size
        // match, which is the only case that could be a false "up to date".
        try {
          const info = await stat(dest);
          if (!isCurrent()) return;
          if (info.isFile) {
            if (info.size !== version.size_bytes) {
              setStale((s) => s + 1);
              continue;
            }
            let localSha = "";
            try {
              const localBytes = await readFile(dest);
              if (!isCurrent()) return;
              localSha = await sha256Hex(localBytes);
            } catch {
              // Couldn't read the local file — treat as needing a download.
              localSha = "";
            }
            // Case-insensitive compare: locally-computed shas are lowercase,
            // but a version row's sha256 could be uppercase/mixed (legacy
            // import). downloadVersionOnce already lowercases on verify, so a
            // verbatim compare here would loop-redownload such files forever.
            if (localSha && localSha === version.sha256?.toLowerCase()) {
              setSkipped((s) => s + 1);
              continue;
            }
            if (localSha) {
              // Same size, different content — don't overwrite a local edit.
              setStale((s) => s + 1);
              continue;
            }
            // Unreadable local file → fall through and (re)download it.
          }
        } catch {
          // File doesn't exist — fall through to download.
        }

        if (!isCurrent()) return;
        activeMap.set(file.id, file.name);
        refreshActive();
        const result = await downloadVersionOnce(client, version.sha256, dest, {
          signal: myAbort.signal,
        });
        // Post-await guard: if a Cancel/Restart happened while we were
        // downloading, drop this result on the floor — it belongs to a
        // superseded run and must not touch the current generation's state.
        if (!isCurrent()) return;
        activeMap.delete(file.id);
        refreshActive();
        if (result.ok) {
          // Downloaded into the vault folder = a non-checked-out copy →
          // read-only (real-vault model), so it holds even in manual mode where
          // auto-sync's reconciliation never runs.
          await setReadonly(dest, true);
          // Record the materialization in the sync ledger (T6). Fire-and-forget;
          // a ledger IO failure must not affect the download. Only meaningful
          // when downloading into the canonical vault layout (we have a vaultId
          // and the dest is under the vault root).
          if (vaultId) {
            void ledgerRecord(vaultId, vaultRelPathFor(file.folder_id, file.name, folders), version.sha256);
          }
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
    // Only flip terminal state if we're still the current generation —
    // a superseded run finishing late must not clobber the active run's UI.
    if (isCurrent()) {
      setRunning(false);
      setActive([]);
      onDone?.();
      // Controller served its purpose; clear so a stale reference doesn't
      // abort a future controller.
      if (abortRef.current === myAbort) abortRef.current = null;
    }
  }, [heliosRoot, vaultName, vaultId, folders, versionsByFileId, client, onPickedRoot, onDone]);

  const cancel = useCallback(() => {
    // Bumping the generation immediately invalidates every in-flight worker.
    // Their post-await guard sees the mismatch and returns without writing
    // to shared state; a subsequent start() bumps again and spawns fresh
    // workers under the new generation. Also abort the controller so any
    // download already past the gen-check skips its terminal writeFile.
    genRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
    setActive([]);
  }, []);
  const close = useCallback(() => { if (!running) setOpen(false); }, [running]);

  return {
    running, open, total, done, errs, skipped, stale,
    bytesDone: bytesDoneRef.current,
    // For backwards-compat the legacy modal reads `current` (single name);
    // populate it from the active list's first entry.
    current: active[0]?.name ?? null,
    active,
    lastError,
    startedAt: startedAtRef.current,
    start, cancel, close,
  };
}
