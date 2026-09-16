import { useCallback, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import { invoke } from "@tauri-apps/api/core";
import { writeFile, mkdir, rename, remove } from "@tauri-apps/plugin-fs";
import { gunzipIfNeeded, isGzipped } from "./compression";
import { setReadonly } from "./fs-readonly";

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
 * Whole-transfer-in-the-webview download. This was `downloadVersionOnce`
 * until v5.7.1 and is now the FALLBACK: it runs when the native
 * `download_object_to_temp` command isn't reachable (no Tauri host — vitest,
 * the Lite web build — or an older shell). Behaviour is unchanged.
 *
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
 *   - after download but before the local write (so a superseded run never
 *     overwrites the destination with stale bytes).
 * This is the property useAutoSync / useBulkDownload need: a Cancel or
 * supersession of an in-flight pass must never produce a torn write to
 * disk, even if the network fetch already completed.
 *
 * The on-disk write itself is also made atomic: verified bytes are written
 * to a `<dest>.part` temp file and then renamed onto the real destination,
 * so an interrupted write or a concurrent writer can never leave a corrupt
 * file at the real path.
 */
export async function downloadVersionOnceInWebview(
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
      // Atomic write: stage the verified bytes at a sibling temp path, then
      // rename onto the real destination. A rename within the same directory
      // is atomic on the local filesystems we target, so a torn/interrupted
      // write (crash, abort mid-write) can only ever leave a stale ".part"
      // file — never a half-written file at the real path that a reader /
      // sha-match would treat as valid. We do the verify BEFORE the write
      // above, so the temp file only ever holds correct bytes.
      //
      // The temp name carries a random UUID so two concurrent writers to the
      // SAME dest (a retry racing the original, or two callers) stage to
      // distinct files instead of clobbering one shared `${dest}.part` and
      // corrupting each other's rename (PART-FILES). On any write/rename
      // failure we best-effort remove() the temp so an orphaned `.part` can't
      // accumulate (the local scan would otherwise surface it as a candidate).
      const tmpPath = `${destPath}.${crypto.randomUUID()}.part`;
      try {
        await writeFile(tmpPath, arr);
        // The real-vault model leaves non-checked-out files read-only. Renaming
        // onto a read-only destination fails on Windows (MoveFileExW →
        // ACCESS_DENIED), so clear the bit first; the caller (auto-sync
        // reconciliation / check-in) re-applies read-only after. Best-effort:
        // no-ops when the dest doesn't exist yet (first download).
        await setReadonly(destPath, false);
        // Last-chance abort check: the temp write above is awaited IO, so a
        // supersede/abort can land while it runs. Without this re-check the
        // rename still commits a superseded pass's bytes over a path a newer
        // pass (or a fresh check-out) now owns.
        if (signal?.aborted) {
          try { await remove(tmpPath); } catch { /* best-effort */ }
          return { ok: false, error: "aborted" };
        }
        await rename(tmpPath, destPath);
      } catch (writeErr) {
        try { await remove(tmpPath); } catch { /* best-effort; temp may not exist */ }
        throw writeErr;
      }
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

/** Shape of `commands::download::DownloadResult` (serde camelCase). */
interface NativeDownloadResult {
  tempPath: string;
  bytes: number;
  wasGzip: boolean;
}

/** Messages Tauri's `invoke` produces when there is no host to talk to. */
const NO_TAURI_HOST = /window\.__TAURI|__TAURI_INTERNALS__|not a tauri|invoke is not a function/i;

function isMissingTauriHost(e: unknown): boolean {
  return NO_TAURI_HOST.test(e instanceof Error ? e.message : String(e));
}

/**
 * Ask the native layer to stream one object into a temp file next to
 * `destPath`, verifying its sha256 on the way through. Nothing is buffered in
 * the webview and no file bytes cross the IPC bridge — only the temp path
 * comes back.
 *
 * Returns null when the command isn't reachable (no Tauri host, or the
 * Supabase URL / anon key aren't configured), which sends the caller to the
 * webview implementation. Real download failures THROW, so the retry loop
 * below sees them and can back off on a 5xx.
 */
async function nativeDownload(
  client: SupabaseClient,
  sha: string,
  destPath: string,
  expectedBytes?: number,
): Promise<NativeDownloadResult | null> {
  const supabaseUrl =
    (client as unknown as { supabaseUrl?: string }).supabaseUrl ??
    (import.meta.env.VITE_SUPABASE_URL as string | undefined);
  const apikey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!supabaseUrl || !apikey) return null;
  // supabase-js sends the user's access token when a session exists and the
  // anon key otherwise. Mirror that exactly so storage RLS sees the same role
  // it saw before this moved out of the webview.
  let bearer = apikey;
  try {
    const session = await client.auth.getSession();
    bearer = session?.data?.session?.access_token ?? apikey;
  } catch {
    // No session (or a stub client) — the anon key is the right fallback.
  }
  const req = {
    url: `${supabaseUrl}/storage/v1/object/${BUCKET}/${storagePath(String(sha))}`,
    bearer,
    apikey,
    destPath,
    expectedSha256: String(sha).toLowerCase(),
    // Lets the native layer size its stall timeout to the file instead of
    // reqwest's 30 s default, which capped every download at ~30 s of link.
    ...(expectedBytes != null && expectedBytes > 0 ? { expectedBytes } : {}),
  };
  const res = (await invoke("download_object_to_temp", { req })) as
    | NativeDownloadResult
    | null;
  // jsdom's stub transport resolves every invoke to null instead of throwing,
  // so a shape-less result means "no native layer" just as a throw does.
  if (!res || typeof res !== "object" || typeof res.tempPath !== "string") return null;
  return res;
}

/**
 * Download the bytes for `sha` and put them at `destPath`.
 *
 * The transfer itself runs in Rust (`download_object_to_temp`), which leaves
 * a verified `<dest>.<uuid>.part` behind; the rename onto the destination
 * stays here so the abort guard, the read-only clear and the temp cleanup are
 * exactly the ones the Vault has always used. Without a native layer the
 * whole thing falls back to `downloadVersionOnceInWebview`.
 *
 * Retries up to 3 times with exponential backoff on transient errors; the
 * command puts the HTTP status number in its message so the same regex keeps
 * classifying 502/503/504 as retryable.
 */
export async function downloadVersionOnce(
  client: SupabaseClient,
  sha: string,
  destPath: string,
  opts?: { signal?: AbortSignal; expectedBytes?: number },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const signal = opts?.signal;
  if (signal?.aborted) return { ok: false, error: "aborted" };
  let lastError = "download failed";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) return { ok: false, error: "aborted" };
    try {
      let native: NativeDownloadResult | null;
      try {
        native = await nativeDownload(client, sha, destPath, opts?.expectedBytes);
      } catch (e) {
        if (!isMissingTauriHost(e)) throw e;
        native = null;
      }
      if (!native) {
        return await downloadVersionOnceInWebview(client, sha, destPath, opts);
      }
      const dir = parentDir(destPath);
      if (dir) {
        try { await mkdir(dir, { recursive: true }); }
        catch { /* mkdir errors when the dir exists in some Tauri versions */ }
      }
      try {
        // The real-vault model leaves non-checked-out files read-only, and
        // renaming onto a read-only destination fails on Windows.
        await setReadonly(destPath, false);
        // Last-chance abort check: a supersede can land while the transfer
        // ran. Without this the rename commits a superseded pass's bytes over
        // a path a newer pass now owns.
        if (signal?.aborted) {
          try { await remove(native.tempPath); } catch { /* best-effort */ }
          return { ok: false, error: "aborted" };
        }
        await rename(native.tempPath, destPath);
      } catch (writeErr) {
        try { await remove(native.tempPath); } catch { /* best-effort */ }
        throw writeErr;
      }
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
    async (sha: string, destPath: string, signal?: AbortSignal, expectedBytes?: number): Promise<boolean> => {
      setLoading(true);
      setError(null);
      const result = await downloadVersionOnce(client, sha, destPath, { signal, expectedBytes });
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
