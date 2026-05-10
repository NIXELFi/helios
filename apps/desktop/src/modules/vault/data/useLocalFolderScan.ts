import { useCallback, useEffect, useRef, useState } from "react";
import { readDir, readFile, stat, watchImmediate } from "@tauri-apps/plugin-fs";

export interface LocalFile {
  basename: string;
  relativePath: string;
  absolutePath: string;
  sha256: string;
  sizeBytes: number;
}

/**
 * Module-scoped sha256 cache keyed by absolute path. Filesystem watcher fires
 * many times during a download burst (one per chunk on some platforms), and
 * each rescan would otherwise re-hash every file — including 100 MB CSVs —
 * on the JS main thread. Hashing 250 MB of data per event freezes the UI.
 *
 * Cache hit requires both mtime AND size to match; either changing means the
 * file content changed and we must re-hash. Survives across rescans (module
 * scope), gets pruned implicitly when entries are simply not refreshed.
 */
interface ShaEntry { mtimeMs: number; size: number; sha256: string }
const shaCache = new Map<string, ShaEntry>();

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Pass the Uint8Array directly — this avoids realm-boundary issues where
  // .buffer.slice() returns a JSArrayBuffer that Node's SubtleCrypto rejects.
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function walk(dir: string, relPrefix: string, out: LocalFile[]): Promise<void> {
  const entries = await readDir(dir);
  for (const e of entries) {
    // Skip hidden + common cruft.
    if (e.name.startsWith(".")) continue;
    const abs = `${dir}/${e.name}`;
    const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
    if (e.isDirectory) {
      await walk(abs, rel, out);
    } else if (e.isFile) {
      try {
        // Probe via stat() to drive the sha cache (mtime+size key). If stat
        // is unavailable (older capabilities, permission denied, weird FS),
        // fall back to read-and-hash so the file still appears in the scan.
        let mtimeMs = 0;
        let size = 0;
        let statOk = false;
        try {
          const info = await stat(abs);
          mtimeMs = info.mtime ? info.mtime.getTime() : 0;
          size = info.size;
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);

  // Track paused via ref so the watcher / interval callbacks always observe
  // the latest value without needing to re-subscribe.
  const pausedRef = useRef<boolean>(paused ?? false);
  useEffect(() => { pausedRef.current = paused ?? false; }, [paused]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!rootPath) {
      setFiles(null);
      setError(null);
      setLoading(false);
      return;
    }
    let mounted = true;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const collected: LocalFile[] = [];
        await walk(rootPath, "", collected);
        if (mounted) {
          setFiles(collected);
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

  return { files, loading, error, refetch };
}
