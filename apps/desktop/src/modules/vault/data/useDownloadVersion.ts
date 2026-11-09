import { useCallback, useRef, useState } from "react";
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
        const transient = isTransientDownloadError(msg);
        if (!transient || attempt === 2) {
          return { ok: false, error: msg };
        }
        lastError = msg;
        await new Promise((r) => setTimeout(r, retryDelayMs(lastError, attempt)));
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
        // Last-chance abort check: the temp write above is awaited IO, so a
        // supersede/abort can land while it runs. Without this re-check the
        // rename still commits a superseded pass's bytes over a path a newer
        // pass (or a fresh check-out) now owns. Checked BEFORE un-protecting
        // the destination: an aborted download must leave the old copy
        // read-only — a writable stale copy reads as an unsaved edit that sync
        // holds back (and bulk Get Latest "keeps") forever.
        if (signal?.aborted) {
          try { await remove(tmpPath); } catch { /* best-effort */ }
          return { ok: false, error: "aborted" };
        }
        // The real-vault model leaves non-checked-out files read-only. Renaming
        // onto a read-only destination fails on Windows (MoveFileExW →
        // ACCESS_DENIED), so clear the bit first; the caller (auto-sync
        // reconciliation / check-in) re-applies read-only after. Best-effort:
        // no-ops when the dest doesn't exist yet (first download).
        await setReadonly(destPath, false);
        await rename(tmpPath, destPath);
      } catch (writeErr) {
        try { await remove(tmpPath); } catch { /* best-effort; temp may not exist */ }
        throw writeErr;
      }
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const transient = isTransientDownloadError(msg);
      if (!transient || attempt === 2) {
        return { ok: false, error: msg };
      }
      lastError = msg;
      await new Promise((r) => setTimeout(r, retryDelayMs(lastError, attempt)));
    }
  }
  return { ok: false, error: lastError };
}

/** Retry only on transient signals: 5xx, network/abort, a generic "fetch
 *  failed", and 429 (storage rate-limits a large pull, as it did to a
 *  1,500-object sync on 2026-11-03). Anything else 4xx is permanent. */
function isTransientDownloadError(msg: string): boolean {
  return /504|502|503|429|too many requests|timeout|gateway|network|fetch failed|abort/i.test(msg);
}

/** Exponential backoff; a rate limit waits longer before trying again. */
function retryDelayMs(msg: string, attempt: number): number {
  const base = /429|too many requests/i.test(msg) ? 2000 : 500;
  return base * Math.pow(2, attempt);
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
): Promise<NativeDownloadResult | null> {
  // Shipped builds bake in no Supabase project: the URL and anon key are typed
  // into the Connect step and live only on the client. Read them from the
  // client first; the VITE_* env exists only in dev. Reading the key from env
  // alone made every production download fall back to the webview path.
  const own = client as unknown as { supabaseUrl?: string; supabaseKey?: string };
  const supabaseUrl = (own.supabaseUrl || (import.meta.env.VITE_SUPABASE_URL as string | undefined))
    ?.replace(/\/+$/, "");
  const apikey = own.supabaseKey || (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined);
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
 * Native transfers in flight, keyed by `sha|dest`, so a caller that wants the
 * same bytes at the same place JOINS the running transfer instead of starting
 * another one.
 *
 * Why: auto-sync supersedes (aborts) its in-flight pass whenever vault data
 * changes, which on a busy team is every time anyone checks a file in or out.
 * The native transfer can't be cancelled mid-stream, so before this the old
 * transfer ran to the end and was thrown away while the new pass started the
 * same file from zero. A 1 GB file on a busy afternoon was fetched again and
 * again and never landed; on 2026-11-03 that was ~290 GB of storage egress.
 *
 * Ownership of the finished temp file: the first caller still interested
 * (not aborted) claims it and renames it into place. Callers that gave up
 * leave it for the others; the last one out deletes it if nobody claimed it.
 */
interface SharedTransfer {
  promise: Promise<NativeDownloadResult | null>;
  waiters: number;
  claimed: boolean;
  /** Settles once the claimer has renamed the file into place (true) or
   *  given up (false). Joiners wait on it so they never report "ok" before,
   *  or without, the bytes actually landing. */
  placed: Promise<boolean>;
  settlePlaced: (ok: boolean) => void;
}
const sharedTransfers = new Map<string, SharedTransfer>();

/** Test hook: number of distinct native transfers currently running. */
export function inFlightNativeTransfers(): number {
  return sharedTransfers.size;
}

type JoinResult =
  /** This caller owns the temp file and MUST call `settle` exactly once. */
  | { kind: "claimed"; native: NativeDownloadResult; settle: (ok: boolean) => void }
  /** Another caller wanting the same sha at the same path placed it. */
  | { kind: "placed-by-other" }
  /** The caller that took the bytes failed to place them: start over. */
  | { kind: "other-failed" }
  | { kind: "aborted" }
  | { kind: "no-native" };

async function joinNativeDownload(
  client: SupabaseClient,
  sha: string,
  destPath: string,
  signal: AbortSignal | undefined,
): Promise<JoinResult> {
  const key = `${String(sha).toLowerCase()}|${destPath}`;
  let entry = sharedTransfers.get(key);
  if (!entry) {
    let settlePlaced: (ok: boolean) => void = () => {};
    const placed = new Promise<boolean>((resolve) => { settlePlaced = resolve; });
    const created: SharedTransfer = {
      promise: nativeDownload(client, sha, destPath),
      waiters: 0,
      claimed: false,
      placed,
      settlePlaced,
    };
    sharedTransfers.set(key, created);
    // A finished transfer is no longer joinable: later callers must start a
    // fresh one (the temp file may already have been renamed or removed).
    const forget = () => {
      if (sharedTransfers.get(key) === created) sharedTransfers.delete(key);
    };
    created.promise.then(forget, forget);
    entry = created;
  }
  entry.waiters++;
  let native: NativeDownloadResult | null;
  try {
    native = await entry.promise;
  } finally {
    entry.waiters--;
  }
  if (!native) return { kind: "no-native" };
  if (signal?.aborted) {
    // Someone else may still want these bytes; the last one out cleans up.
    if (entry.waiters === 0 && !entry.claimed) {
      entry.claimed = true;
      entry.settlePlaced(false);
      try { await remove(native.tempPath); } catch { /* best-effort */ }
    }
    return { kind: "aborted" };
  }
  if (entry.claimed) {
    return (await entry.placed) ? { kind: "placed-by-other" } : { kind: "other-failed" };
  }
  entry.claimed = true;
  let settled = false;
  const settle = (ok: boolean) => {
    if (settled) return;
    settled = true;
    entry!.settlePlaced(ok);
  };
  return { kind: "claimed", native, settle };
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
  opts?: { signal?: AbortSignal },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const signal = opts?.signal;
  if (signal?.aborted) return { ok: false, error: "aborted" };
  let lastError = "download failed";
  let otherFailedRestarts = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) return { ok: false, error: "aborted" };
    try {
      let joined: JoinResult;
      try {
        joined = await joinNativeDownload(client, sha, destPath, signal);
      } catch (e) {
        if (!isMissingTauriHost(e)) throw e;
        joined = { kind: "no-native" };
      }
      if (joined.kind === "no-native") {
        return await downloadVersionOnceInWebview(client, sha, destPath, opts);
      }
      if (joined.kind === "aborted") return { ok: false, error: "aborted" };
      if (joined.kind === "placed-by-other") return { ok: true };
      if (joined.kind === "other-failed") {
        // Not counted as a failed attempt: the transfer we joined is gone,
        // so the next join starts a fresh one for this caller.
        if (signal?.aborted) return { ok: false, error: "aborted" };
        attempt--;
        if (++otherFailedRestarts > 3) return { ok: false, error: lastError };
        continue;
      }
      const { native, settle } = joined;
      let placedOk = false;
      try {
        const dir = parentDir(destPath);
        if (dir) {
          try { await mkdir(dir, { recursive: true }); }
          catch { /* mkdir errors when the dir exists in some Tauri versions */ }
        }
        try {
          // Last-chance abort check: a supersede can land while the transfer
          // ran. Without this the rename commits a superseded pass's bytes over
          // a path a newer pass now owns. Checked BEFORE un-protecting the
          // destination so an aborted download leaves the old copy read-only.
          if (signal?.aborted) {
            try { await remove(native.tempPath); } catch { /* best-effort */ }
            return { ok: false, error: "aborted" };
          }
          // The real-vault model leaves non-checked-out files read-only, and
          // renaming onto a read-only destination fails on Windows.
          await setReadonly(destPath, false);
          await rename(native.tempPath, destPath);
        } catch (writeErr) {
          try { await remove(native.tempPath); } catch { /* best-effort */ }
          throw writeErr;
        }
        placedOk = true;
        return { ok: true };
      } finally {
        settle(placedOk);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const transient = isTransientDownloadError(msg);
      if (!transient || attempt === 2) {
        return { ok: false, error: msg };
      }
      lastError = msg;
      await new Promise((r) => setTimeout(r, retryDelayMs(lastError, attempt)));
    }
  }
  return { ok: false, error: lastError };
}

export function useDownloadVersion() {
  const client = useSupabaseClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // Mirror of `error` updated synchronously inside run(), so a caller that
  // awaits run() and gets false can read the failure reason in the SAME tick
  // (the `error` state is stale inside the awaiting closure).
  const errorRef = useRef<Error | null>(null);

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
      errorRef.current = null;
      const result = await downloadVersionOnce(client, sha, destPath, { signal });
      if (result.ok) {
        setLoading(false);
        return true;
      }
      const err = new Error(result.error);
      errorRef.current = err;
      setError(err);
      setLoading(false);
      return false;
    },
    [client],
  );

  return { run, loading, error, errorRef };
}
