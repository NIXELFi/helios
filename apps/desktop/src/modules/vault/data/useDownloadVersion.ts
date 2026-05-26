import { useCallback, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import { writeFile, mkdir } from "@tauri-apps/plugin-fs";
import { gunzipIfNeeded, isGzipped } from "./compression";

/** Hex sha256 of a byte buffer — used to verify download integrity before
 *  writing to disk. Matches the format pdm.versions.sha256 is stored in. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

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
 *
 * Optional `signal` lets callers abort. The fetch itself can't be aborted
 * mid-flight (supabase-js's `storage.download` doesn't yet accept an
 * AbortSignal), but the function checks the signal at three safe points:
 *   - on entry (skip the whole attempt),
 *   - between retry attempts (skip remaining retries),
 *   - after download but before the local writeFile (so a superseded run
 *     never overwrites the destination with stale bytes).
 * This is the property useAutoSync / useBulkDownload need: a Cancel or
 * supersession of an in-flight pass must never produce a torn write to
 * disk, even if the network fetch already completed.
 */
export async function downloadVersionOnce(
  client: SupabaseClient,
  sha: string,
  destPath: string,
  opts?: { signal?: AbortSignal },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const signal = opts?.signal;
  if (signal?.aborted) return { ok: false, error: "aborted" };
  let lastError = "download failed";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) return { ok: false, error: "aborted" };
    try {
      const { data, error: dlErr } = await client.storage
        .from(BUCKET)
        .download(storagePath(String(sha)));
      if (signal?.aborted) return { ok: false, error: "aborted" };
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
      // Post-fetch abort check — the most important guard. Without this a
      // superseded run's bytes can land on disk after the new run has
      // already started a download to the same path.
      if (signal?.aborted) return { ok: false, error: "aborted" };
      // Decompress, then verify the bytes hash to the expected sha. Three
      // outcomes the verify-after-gunzip step protects against:
      //  (a) the file was uploaded raw (legacy / pre-gzip era) and happens
      //      to begin with 0x1f 0x8b — gunzipIfNeeded attempted to decode
      //      it as gzip and either threw "unknown compression method" or
      //      produced garbage that hashes wrong;
      //  (b) the storage object is genuinely corrupt;
      //  (c) a successful decompress whose bytes hash to the expected sha
      //      — the normal happy path.
      // For (a) we recover by treating the raw bytes as the authoritative
      // payload and re-verifying. For (b) both attempts mismatch and we
      // surface a real error rather than write corrupt bytes to disk.
      const expectedSha = String(sha).toLowerCase();
      let arr: Uint8Array | null = null;
      let gunzipError: string | null = null;
      try {
        arr = await gunzipIfNeeded(raw);
      } catch (e) {
        gunzipError = e instanceof Error ? e.message : String(e);
      }
      let actualSha = arr ? await sha256Hex(arr) : "";
      if (arr === null || actualSha !== expectedSha) {
        // gunzip either threw or produced wrong-hash bytes. If the raw
        // bytes happened to start with the gzip magic, this may be a
        // false-positive — retry the verify with the raw bytes themselves.
        if (isGzipped(raw)) {
          const actualRawSha = await sha256Hex(raw);
          if (actualRawSha === expectedSha) {
            arr = raw;
            actualSha = actualRawSha;
          }
        }
        if (arr === null || actualSha !== expectedSha) {
          return {
            ok: false,
            error: arr === null
              ? `decompression failed and raw bytes did not match expected sha: ${gunzipError ?? "unknown error"}`
              : `sha256 mismatch: expected ${expectedSha}, got ${actualSha} (storage object appears corrupt)`,
          };
        }
      }
      const dir = parentDir(destPath);
      if (dir) {
        try { await mkdir(dir, { recursive: true }); }
        catch { /* mkdir errors when the dir exists in some Tauri versions */ }
      }
      if (signal?.aborted) return { ok: false, error: "aborted" };
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
   *
   * Optional `signal` forwards to downloadVersionOnce — when triggered
   * (e.g. by useAutoSync supersession), the download still completes but
   * the bytes are never written to disk and the call returns `false`.
   */
  const run = useCallback(
    async (sha: string, destPath: string, signal?: AbortSignal): Promise<boolean> => {
      setLoading(true);
      setError(null);
      const result = await downloadVersionOnce(client, sha, destPath, { signal });
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
