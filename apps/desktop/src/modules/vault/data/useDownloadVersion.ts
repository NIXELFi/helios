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
 * Retries up to 3 times with exponential backoff on transient errors:
 *  - 5xx responses from Supabase Storage (esp. 504 gateway timeouts when
 *    the proxy gives up waiting on the backend during heavy load)
 *  - Network errors (TypeError on fetch failure, AbortError, etc.)
 * Permanent errors (404, 403) bail immediately — no point retrying.
 */
export async function downloadVersionOnce(
  client: SupabaseClient,
  sha: string,
  destPath: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let lastError = "download failed";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data, error: dlErr } = await client.storage
        .from(BUCKET)
        .download(storagePath(String(sha)));
      if (dlErr || !data) {
        const msg = dlErr?.message ?? "download failed";
        // Retry only on transient signals — 5xx, network/abort, generic
        // "fetch failed". Anything that looks like 4xx is permanent.
        const transient = /504|502|503|timeout|gateway|network|fetch failed|abort/i.test(msg);
        if (!transient || attempt === 2) {
          return { ok: false, error: msg };
        }
        lastError = msg;
        await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
        continue;
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
      const msg = e instanceof Error ? e.message : String(e);
      const transient = /504|502|503|timeout|gateway|network|fetch failed|abort/i.test(msg);
      if (!transient || attempt === 2) {
        return { ok: false, error: msg };
      }
      lastError = msg;
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
    }
  }
  return { ok: false, error: lastError };
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
