import { useCallback, useEffect, useState } from "react";
import { readDir, readFile } from "@tauri-apps/plugin-fs";

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
  const digest = await crypto.subtle.digest("SHA-256", bytes);
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

export function useLocalFolderScan(rootPath: string | null) {
  const [files, setFiles] = useState<LocalFile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);

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

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  return { files, loading, error, refetch };
}
