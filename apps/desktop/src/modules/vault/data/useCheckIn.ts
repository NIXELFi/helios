import { useCallback, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { FileId, Version } from "./types";
import { gzipBytes } from "./compression";
import { friendlyPgError } from "./pg-errors";
import { notifyLockChange } from "./lock-events";
import { setLockOverlay } from "./lock-overlay";

const BUCKET = "vault-objects";

/** Storage paths in this bucket are content-addressed (path === sha256 of
 *  bytes), so if the object already exists the bytes are guaranteed identical.
 *  We probe first and only upload when missing — this avoids the fragile
 *  dance of trying to identify Supabase's "Duplicate" 400 response, whose
 *  error shape varies across versions / proxies. The probe is the
 *  pdm_object_exists definer RPC rather than storage list(): the bucket
 *  SELECT policy is vault-scoped (20260610110000), so list() can't see
 *  content that already exists under another vault, which would make this
 *  flow fail on the cross-vault duplicate-content path. */
async function objectExists(client: ReturnType<typeof useSupabaseClient>, sha: string): Promise<boolean> {
  try {
    const { data, error } = await client.rpc("pdm_object_exists", { p_sha: sha });
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
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

  const run = useCallback(
    async (
      file_id: FileId,
      bytes: ArrayBuffer,
      comment: string | null,
    ): Promise<Version | null> => {
      setLoading(true);
      setError(null);
      try {
        const sha = await sha256Hex(bytes);
        const path = `${sha.slice(0, 2)}/${sha}`;

        if (!(await objectExists(client, sha))) {
          // Gzip before upload — keeps payloads under Supabase's 50 MiB free-
          // plan cap for typical MoTeC / Link logs. Stored bytes are gzipped;
          // the version's sha256 (and storage path) still identify the
          // ORIGINAL uncompressed content, so download can decompress and
          // verify integrity.
          const compressed = await gzipBytes(new Uint8Array(bytes));
          const { error: upErr } = await client.storage
            .from(BUCKET)
            .upload(path, compressed as BufferSource, {
              contentType: "application/octet-stream",
              upsert: false,
            });
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
            if (!(await objectExists(client, sha))) {
              throw new Error(`upload: ${upErr.message}`);
            }
          }
        }

        const { data: ver, error: rpcErr } = await client.rpc("pdm_check_in", {
          p_file_id: file_id,
          p_sha256: sha,
          p_size: bytes.byteLength,
          p_comment: comment,
        });
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
        setError(err);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  return { run, loading, error, result };
}
