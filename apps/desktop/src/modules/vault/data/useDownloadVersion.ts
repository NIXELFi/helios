import { useCallback, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import { writeFile, mkdir } from "@tauri-apps/plugin-fs";

const BUCKET = "vault-objects";

/** Compute storage path from a sha256 string. */
function storagePath(sha: string): string {
  return `${sha.slice(0, 2)}/${sha}`;
}

/** Find the parent directory of a slash-joined path. */
function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.substring(0, i) : "";
}

export function useDownloadVersion() {
  const client = useSupabaseClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  /**
   * Download the bytes for a sha256 + write them to destPath. Overwrites by
   * default. Creates intermediate directories. Returns true on success.
   */
  const run = useCallback(
    async (sha: string, destPath: string): Promise<boolean> => {
      setLoading(true);
      setError(null);
      try {
        const { data, error: dlErr } = await client.storage
          .from(BUCKET)
          .download(storagePath(String(sha)));
        if (dlErr || !data) {
          throw new Error(dlErr?.message ?? "download failed");
        }
        const arr = new Uint8Array(await data.arrayBuffer());

        // Create the parent directory tree if needed.
        const dir = parentDir(destPath);
        if (dir) {
          try {
            await mkdir(dir, { recursive: true });
          } catch {
            // mkdir errors when the dir already exists in some Tauri versions;
            // ignore — writeFile will fail later if it's actually a problem.
          }
        }

        await writeFile(destPath, arr);
        setLoading(false);
        return true;
      } catch (e) {
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
        return false;
      }
    },
    [client],
  );

  return { run, loading, error };
}
