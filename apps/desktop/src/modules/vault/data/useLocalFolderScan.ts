import { useCallback, useEffect, useRef, useState } from "react";
import { readDir, readFile, stat, watchImmediate } from "@tauri-apps/plugin-fs";

export interface LocalFile {
  basename: string;
  relativePath: string;
  absolutePath: string;
  sha256: string;
  sizeBytes: number;
  /** OS read-only bit at scan time. Drives the real-vault reconciliation
   *  (a file is writable iff checked out by the current user). Undefined when
   *  stat was unavailable — treated as writable by reconcilers. */
  readonly?: boolean;
}

/**
 * Hook-scoped sha256 cache keyed by absolute path. Filesystem watcher fires
 * many times during a download burst (one per chunk on some platforms), and
 * each rescan would otherwise re-hash every file — including 100 MB CSVs —
 * on the JS main thread. Hashing 250 MB of data per event freezes the UI.
 *
 * Cache hit requires both mtime AND size to match; either changing means the
 * file content changed and we must re-hash. The cache is held in a useRef
 * inside `useLocalFolderScan` so it shares the React lifetime — it's cleared
 * implicitly when the hook unmounts (e.g. user logs out / switches accounts),
 * preventing cross-user leakage of file hashes.
 */
interface ShaEntry { mtimeMs: number; size: number; sha256: string }
type ShaCache = Map<string, ShaEntry>;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Pass the Uint8Array directly — this avoids realm-boundary issues where
  // .buffer.slice() returns a JSArrayBuffer that Node's SubtleCrypto rejects.
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Stable empty Set returned before the first scan / when there's no root, so
// consumers don't see a new identity (and re-render) on every render.
const EMPTY_OPEN_IN_SW: Set<string> = new Set();

// Hard cap on recursion depth. A vault tree this deep is pathological; the
// cap is a backstop against cyclic real-path trees (and as a second line of
// defense behind the symlink skip below) so the walk can't stack-overflow or
// hang the UI thread indefinitely.
const MAX_DEPTH = 64;

async function walk(
  dir: string,
  relPrefix: string,
  out: LocalFile[],
  openInSw: Set<string>,
  shaCache: ShaCache,
  depth = 0,
): Promise<void> {
  if (depth > MAX_DEPTH) return;
  const entries = await readDir(dir);
  for (const e of entries) {
    // Skip hidden + common cruft.
    if (e.name.startsWith(".")) continue;
    // SolidWorks writes a `~$<name>` sidecar next to a file while it's open for
    // editing and deletes it on close. Never let these enter the LocalFile list
    // (they'd otherwise leak into the "not in vault" unmatched banner). Instead
    // capture them as a live "open in SolidWorks" signal: a `~$Foo.SLDPRT` in
    // this folder means the real `Foo.SLDPRT` (same folder/relPrefix) is open.
    // The captured relativePath is built exactly like the LocalFile.relativePath
    // below so the FileTable's lookup keys line up.
    if (e.name.startsWith("~$")) {
      const realName = e.name.slice(2);
      if (realName) {
        openInSw.add(relPrefix ? `${relPrefix}/${realName}` : realName);
      }
      continue;
    }
    // Never follow symlinks. A symlinked directory can point back up the tree
    // (or to another scanned root), producing an infinite recursion / hang.
    // We skip symlinks entirely — including symlinked files — rather than try
    // to track visited real paths, which Tauri's readDir doesn't expose.
    if (e.isSymlink) continue;
    const abs = `${dir}/${e.name}`;
    const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
    if (e.isDirectory) {
      await walk(abs, rel, out, openInSw, shaCache, depth + 1);
    } else if (e.isFile) {
      try {
        // Probe via stat() to drive the sha cache (mtime+size key). If stat
        // is unavailable (older capabilities, permission denied, weird FS),
        // fall back to read-and-hash so the file still appears in the scan.
        let mtimeMs = 0;
        let size = 0;
        let readonly: boolean | undefined;
        let statOk = false;
        try {
          const info = await stat(abs);
          mtimeMs = info.mtime ? info.mtime.getTime() : 0;
          size = info.size;
          // FileInfo.readonly may be absent on some platforms/types — read
          // defensively; undefined means "unknown" (treated as writable).
          readonly = (info as { readonly?: boolean }).readonly;
          statOk = true;
        } catch {
          // stat blocked / not granted — proceed without cache hit path
        }
        let sha: string;
        const cached = statOk ? shaCache.get(abs) : null;
        if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
          sha = cached.sha256;
        } else {
          const bytes = await readFile(abs);
          sha = await sha256Hex(bytes);
          if (!statOk) size = bytes.length;
          if (statOk) shaCache.set(abs, { mtimeMs, size, sha256: sha });
        }
        out.push({
          basename: e.name,
          relativePath: rel,
          absolutePath: abs,
          sha256: sha,
          sizeBytes: size,
          readonly,
        });
      } catch {
        // Skip unreadable files (permission denied, broken symlink, etc.)
      }
    }
  }
}

export interface UseLocalFolderScanOptions {
  /** Re-scan the folder on this interval. 0 / undefined = no polling. */
  intervalMs?: number;
  /** Re-scan when the window regains focus. */
  rescanOnFocus?: boolean;
  /** Subscribe to filesystem change events on rootPath (recursive). */
  watchFs?: boolean;
  /** When true, suppress automatic rescans (watcher / interval / focus).
   *  The caller can still force a refresh via the returned `refetch`. Used
   *  during auto-sync so partially-written files don't trigger badge churn
   *  in the file table. */
  paused?: boolean;
}

export function useLocalFolderScan(
  rootPath: string | null,
  options: UseLocalFolderScanOptions = {},
) {
  const { intervalMs, rescanOnFocus, watchFs, paused } = options;
  const [files, setFiles] = useState<LocalFile[] | null>(null);
  // Relative paths (built the same way as LocalFile.relativePath) of files that
  // SolidWorks currently has open for editing, derived from `~$` lock sidecars
  // seen during the walk. Used as an informational "Open in SolidWorks" signal.
  const [openInSw, setOpenInSw] = useState<Set<string>>(EMPTY_OPEN_IN_SW);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);

  // Track paused via ref so the watcher / interval callbacks always observe
  // the latest value without needing to re-subscribe.
  const pausedRef = useRef<boolean>(paused ?? false);
  useEffect(() => { pausedRef.current = paused ?? false; }, [paused]);

  // sha cache lives for the hook's lifetime; clears on unmount (e.g. logout).
  const shaCacheRef = useRef<ShaCache>(new Map());

  const refetch = useCallback(() => setTick((t) => t + 1), []);

  // Clear the sha cache whenever rootPath changes — entries are keyed by
  // absolute path and would silently leak across folder/account switches.
  useEffect(() => {
    shaCacheRef.current.clear();
  }, [rootPath]);

  useEffect(() => {
    if (!rootPath) {
      setFiles(null);
      setOpenInSw(EMPTY_OPEN_IN_SW);
      setError(null);
      setLoading(false);
      return;
    }
    let mounted = true;
    // Capture the paused state at scan start. A scan kicked off while running
    // (paused=false) can still be in flight when auto-sync flips paused=true
    // mid-download. Committing its partial, mid-write results would churn the
    // file table with half-downloaded files — so if paused flipped true during
    // the walk, we drop the commit. The next unpaused scan publishes a clean
    // snapshot.
    const startedPaused = pausedRef.current;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        // A vault subfolder that doesn't exist yet (never synced, or deleted)
        // is NOT an error — treat it as empty. Returning null here would make
        // auto-sync early-return on `!localFiles` forever: the folder can't be
        // created without a download, and no download happens without the
        // folder. Publishing [] lets auto-sync bootstrap it (the download path
        // mkdir's the destination).
        let rootExists = true;
        try { await stat(rootPath); } catch { rootExists = false; }
        const collected: LocalFile[] = [];
        const openSw = new Set<string>();
        if (rootExists) {
          await walk(rootPath, "", collected, openSw, shaCacheRef.current);
        }
        // Skip the commit if paused flipped true while we were walking (and it
        // wasn't already paused at start — that case never publishes anyway).
        const pausedNow = pausedRef.current && !startedPaused;
        if (mounted && !pausedNow) {
          setFiles(collected);
          // Reuse the stable empty set when there's nothing open, so consumers
          // don't churn on a fresh empty-Set identity each scan.
          setOpenInSw(openSw.size === 0 ? EMPTY_OPEN_IN_SW : openSw);
          setLoading(false);
        } else if (mounted) {
          // Clear the loading flag but leave `files` untouched — a later
          // unpaused refetch will publish fresh results.
          setLoading(false);
        }
      } catch (e) {
        if (mounted) {
          setError(e instanceof Error ? e : new Error(String(e)));
          setLoading(false);
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, [rootPath, tick]);

  // Periodic re-scan: fallback for environments where filesystem watch isn't
  // available, and a backstop in case the watcher drops events.
  useEffect(() => {
    if (!rootPath || !intervalMs || intervalMs <= 0) return;
    const id = window.setInterval(() => {
      if (!pausedRef.current) refetch();
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [rootPath, intervalMs, refetch]);

  // Re-scan when the user comes back to the window — covers the common case
  // of editing a file in another app and tabbing back.
  useEffect(() => {
    if (!rootPath || !rescanOnFocus) return;
    const onFocus = () => { if (!pausedRef.current) refetch(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [rootPath, rescanOnFocus, refetch]);

  // Native filesystem watcher (Tauri/notify). Debounce small bursts of events
  // — saving a file often produces several events in quick succession.
  useEffect(() => {
    if (!rootPath || !watchFs) return;
    let unwatch: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    (async () => {
      try {
        const stop = await watchImmediate(
          rootPath,
          () => {
            if (pausedRef.current) return;
            // Long debounce: a parallel auto-sync pass produces dozens of
            // events per second across many files. Coalescing into a single
            // rescan ~1.5 s after the last event keeps the UI responsive
            // and lets the sha-cache below absorb most of the work anyway.
            if (timer) clearTimeout(timer);
            timer = setTimeout(refetch, 1500);
          },
          { recursive: true },
        );
        if (cancelled) {
          stop();
        } else {
          unwatch = stop;
        }
      } catch {
        // Permission or platform issue — periodic + focus rescans still work.
      }
    })();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (unwatch) unwatch();
    };
  }, [rootPath, watchFs, refetch]);

  return { files, openInSw, loading, error, refetch };
}
