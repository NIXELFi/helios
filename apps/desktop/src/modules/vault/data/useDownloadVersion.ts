import { useCallback, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import { writeFile, mkdir } from "@tauri-apps/plugin-fs";
import { gunzipIfNeeded } from "./compression";

// The `client` arg is whatever `useSupabaseClient()` returns; we accept it
// as `any` to avoid pulling @supabase/supabase-js into this leaf module's
// dep tree (the package isn't currently listed in apps/desktop's package.json).
type SupabaseClient = ReturnType<typeof useSupabaseClient>;

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

/**
 * Pure-async download primitive — call directly from a worker pool when you
 * need parallel downloads. Returns the error message on failure (instead of
 * setting hook state) so the caller can aggregate.
 *
 * The hook below wraps this for the common single-download UI cases.
 */
export async function downloadVersionOnce(
  client: SupabaseClient,
  sha: string,
  destPath: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { data, error: dlErr } = await client.storage
      .from(BUCKET)
      .download(storagePath(String(sha)));
    if (dlErr || !data) {
      return { ok: false, error: dlErr?.message ?? "download failed" };
    }
    const raw = new Uint8Array(await data.arrayBuffer());
    const arr = await gunzipIfNeeded(raw);
    const dir = parentDir(destPath);
    if (dir) {
      try { await mkdir(dir, { recursive: true }); }
      catch { /* mkdir errors when the dir exists in some Tauri versions */ }
    }
    await writeFile(destPath, arr);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
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
      const result = await downloadVersionOnce(client, sha, destPath);
      if (result.ok) {
        setLoading(false);
        return true;
      }
      setError(new Error(result.error));
      setLoading(false);
      return false;
    },
    [client],
  );

  return { run, loading, error };
}
