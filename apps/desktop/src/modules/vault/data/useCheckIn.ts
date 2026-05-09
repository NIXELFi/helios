import { useCallback, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { FileId, Version } from "./types";

const BUCKET = "vault-objects";

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

        const { error: upErr } = await client.storage
          .from(BUCKET)
          .upload(path, bytes, {
            contentType: "application/octet-stream",
            upsert: false,
          });
        if (upErr && !/already exists/i.test(upErr.message)) {
          throw new Error(`upload: ${upErr.message}`);
        }

        const { data: ver, error: rpcErr } = await client.rpc("pdm_check_in", {
          p_file_id: file_id,
          p_sha256: sha,
          p_size: bytes.byteLength,
          p_comment: comment,
        });
        if (rpcErr) throw new Error(rpcErr.message ?? String(rpcErr));
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
