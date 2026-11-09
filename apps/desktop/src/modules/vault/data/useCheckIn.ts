import { useCallback, useRef, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { FileId, Version } from "./types";
import { gzipBytes } from "./compression";
import { friendlyPgError, friendlyUploadError } from "./pg-errors";
import { notifyLockChange } from "./lock-events";
import { setLockOverlay } from "./lock-overlay";
import { HUGE_UPLOAD_DECLINED, confirmHugeUpload } from "./huge-file-guard";

const BUCKET = "vault-objects";

/** Time limits so a dropped connection ends a check-in with an error instead
 *  of a spinner that never stops (a 2026-10-29 report: "it just loaded for
 *  like 20 mins"). On a timeout the user keeps the checkout and can retry. */
const PROBE_TIMEOUT_MS = 30_000;
const CHECK_IN_RPC_TIMEOUT_MS = 60_000;
/** Two minutes plus one second per 128 KB (an upload slower than about
 *  1 Mbit/s is treated as stalled). */
export function uploadTimeoutMs(uploadBytes: number): number {
  return 120_000 + Math.ceil(uploadBytes / (128 * 1024)) * 1000;
}

class CheckInTimeout extends Error {}

function withTimeout<T>(work: PromiseLike<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CheckInTimeout(message)), ms);
  });
  return Promise.race([Promise.resolve(work), timeout]).finally(() => clearTimeout(timer));
}

/** Storage paths in this bucket are content-addressed (path === sha256 of
 *  bytes), so if the object already exists the bytes are guaranteed identical.
 *  We probe first and only upload when missing — this avoids the fragile
 *  dance of trying to identify Supabase's "Duplicate" 400 response, whose
 *  error shape varies across versions / proxies. The probe is the
 *  pdm_object_exists definer RPC rather than storage list(): the bucket
 *  SELECT policy is vault-scoped (20260610110000), so list() can't see
 *  content that already exists under another vault, which would make this
 *  flow fail on the cross-vault duplicate-content path. */
/** Tri-state on purpose: "unknown" (the probe itself failed — transient 5xx,
 *  offline, proxy hiccup) is NOT the same as "absent". Collapsing them meant a
 *  transient probe failure on content ALREADY in the bucket sent us down the
 *  upload path, where Supabase's duplicate response is an error, and the
 *  re-probe failed the same way — so a check-in that should have been a no-op
 *  threw and left the user's lock held. On "unknown" we still attempt the
 *  upload (it's the only way to make progress) but treat a duplicate-shaped
 *  rejection as success rather than a hard failure. */
type ObjectProbe = "present" | "absent" | "unknown";

async function objectExists(
  client: ReturnType<typeof useSupabaseClient>,
  sha: string,
): Promise<ObjectProbe> {
  try {
    const { data, error } = await withTimeout(
      client.rpc("pdm_object_exists", { p_sha: sha }),
      PROBE_TIMEOUT_MS,
      "object probe timed out",
    );
    if (error) return "unknown";
    return data === true ? "present" : "absent";
  } catch {
    return "unknown";
  }
}

/** True iff a storage upload error is the "this content is already here" shape.
 *  Deliberately loose (message/status sniffing) — the exact shape varies across
 *  Supabase versions and proxies, which is why the probe exists at all. Since
 *  storage paths are content-addressed (path === sha256), an object already at
 *  this path is byte-identical to what we were uploading, so treating a
 *  duplicate as success can never publish the wrong bytes. */
function isDuplicateUploadError(err: { message?: string; statusCode?: string | number }): boolean {
  const msg = (err.message ?? "").toLowerCase();
  const status = String(err.statusCode ?? "");
  return (
    status === "409" ||
    msg.includes("duplicate") ||
    msg.includes("already exists") ||
    msg.includes("resource already exists")
  );
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  // Wrap in a Uint8Array first — this normalises the buffer across realms
  // (e.g. jsdom vs Node in tests) so SubtleCrypto always sees a TypedArray.
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function useCheckIn() {
  const client = useSupabaseClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [result, setResult] = useState<Version | null>(null);
  // Mirror of `error` that updates synchronously inside run(), so a caller that
  // awaits run() and gets null can read the actual failure reason in the SAME
  // tick — the `error` state only lands on the next render, which is stale inside
  // the awaiting closure (e.g. a per-row check-in handler).
  const errorRef = useRef<Error | null>(null);

  const run = useCallback(
    async (
      file_id: FileId,
      bytes: ArrayBuffer,
      comment: string | null,
      opts: {
        // Per-call failure callback. errorRef is shared by every in-flight call
        // on this hook instance, so a caller running several check-ins at once
        // (the batch hook) reads its own row's reason here instead.
        onError?: (err: Error) => void;
        // sha of the version the local copy was made from (the sync ledger
        // entry). The server refuses the check-in if a different version is
        // latest now, instead of silently replacing it. Omit to skip the check.
        baseSha?: string | null;
        /** Shown in the huge-file warning. */
        fileName?: string;
      } = {},
    ): Promise<Version | null> => {
      setLoading(true);
      setError(null);
      errorRef.current = null;
      try {
        const sha = await sha256Hex(bytes);
        const path = `${sha.slice(0, 2)}/${sha}`;

        // Huge files ask first (a warning, not a limit): see huge-file-guard.ts.
        // Declining keeps the checkout so nothing is lost.
        const go = await confirmHugeUpload({
          key: `checkin|${file_id}|${sha}`,
          name: opts.fileName ?? "This file",
          bytes: bytes.byteLength,
          action: "check in",
        });
        if (!go) throw new Error(HUGE_UPLOAD_DECLINED);

        // "unknown" falls through to the upload attempt — the duplicate handling
        // below makes that safe even when the content was in fact already there.
        if ((await objectExists(client, sha)) !== "present") {
          // Gzip before upload — keeps payloads under Supabase's 50 MiB free-
          // plan cap for typical MoTeC / Link logs. Stored bytes are gzipped;
          // the version's sha256 (and storage path) still identify the
          // ORIGINAL uncompressed content, so download can decompress and
          // verify integrity.
          const compressed = await gzipBytes(new Uint8Array(bytes));
          // storage-js upload() takes no AbortSignal, so a stalled request is
          // abandoned rather than cancelled. Content addressing makes that
          // safe: if it completes later, the next attempt finds it present.
          const { error: upErr } = await withTimeout(
            client.storage.from(BUCKET).upload(path, compressed as BufferSource, {
              contentType: "application/octet-stream",
              upsert: false,
            }),
            uploadTimeoutMs(compressed.byteLength),
            "Upload timed out. Your connection may have dropped. You still have the file checked out; try checking it in again.",
          );
          if (upErr) {
            // Race: another client uploaded the same content between our
            // check and our upload. Re-probe once before giving up. We log
            // the original upload error first — when the re-probe succeeds
            // we'd otherwise swallow the error message even if it was a
            // legit failure (auth, quota) coinciding with another client's
            // independent upload. The console line gives diagnostics
            // without forcing a user-visible error on the race path.
            console.warn(
              `[vault] storage upload returned an error (${upErr.message}); re-probing for sha=${sha}`,
            );
            const reprobe = await objectExists(client, sha);
            // Only "absent" is a real failure. A duplicate-shaped rejection
            // means the content-addressed object is already there — identical
            // bytes by construction — so the check-in can proceed even when the
            // re-probe ALSO came back "unknown" (the same outage that broke the
            // first probe usually breaks the second). Throwing there is what
            // turned a no-op into a hard failure with the lock retained.
            const duplicate = isDuplicateUploadError(
              upErr as { message?: string; statusCode?: string | number },
            );
            if (reprobe === "absent" || (reprobe === "unknown" && !duplicate)) {
              throw new Error(`upload: ${friendlyUploadError(upErr.message)}`);
            }
          }
        }

        const { data: ver, error: rpcErr } = await withTimeout(
          client.rpc("pdm_check_in", {
            p_file_id: file_id,
            p_sha256: sha,
            p_size: bytes.byteLength,
            p_comment: comment,
            ...(opts.baseSha ? { p_base_sha256: opts.baseSha } : {}),
          }),
          CHECK_IN_RPC_TIMEOUT_MS,
          "The vault server didn't answer in time. The check-in may still have gone through; wait a moment and check the file's history before trying again.",
        );
        if (rpcErr) throw new Error(friendlyPgError(rpcErr, "version").message);
        // pdm_check_in releases the caller's lock server-side. Clear the pill
        // this frame (optimistic remove) so check-in feels as instant as
        // checkout, then broadcast so every mounted useLocks() refetches rather
        // than waiting on the realtime channel — closes the window where
        // auto-sync could clobber the file the user just checked in (see
        // lock-events.ts). reconcile drops the overlay once the refetch lands.
        setLockOverlay(file_id, { kind: "remove" });
        notifyLockChange();
        setResult(ver as Version);
        return ver as Version;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        errorRef.current = err;
        setError(err);
        opts.onError?.(err);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  return { run, loading, error, result, errorRef };
}
