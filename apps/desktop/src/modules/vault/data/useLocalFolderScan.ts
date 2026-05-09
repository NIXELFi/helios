import { useCallback, useEffect, useState } from "react";
import { readDir, readFile, watchImmediate } from "@tauri-apps/plugin-fs";

export interface LocalFile {
  basename: string;
  relativePath: string;
  absolutePath: string;
  sha256: string;
  sizeBytes: number;
}

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
        const bytes = await readFile(abs);
        const sha = await sha256Hex(bytes);
        out.push({
          basename: e.name,
          relativePath: rel,
          absolutePath: abs,
          sha256: sha,
          sizeBytes: bytes.length,
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
}

export function useLocalFolderScan(
  rootPath: string | null,
  options: UseLocalFolderScanOptions = {},
) {
  const { intervalMs, rescanOnFocus, watchFs } = options;
  const [files, setFiles] = useState<LocalFile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);

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
    const id = window.setInterval(refetch, intervalMs);
    return () => window.clearInterval(id);
  }, [rootPath, intervalMs, refetch]);

  // Re-scan when the user comes back to the window — covers the common case
  // of editing a file in another app and tabbing back.
  useEffect(() => {
    if (!rootPath || !rescanOnFocus) return;
    const onFocus = () => refetch();
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
            if (timer) clearTimeout(timer);
            timer = setTimeout(refetch, 300);
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
