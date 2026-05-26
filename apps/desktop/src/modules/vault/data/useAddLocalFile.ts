import { useCallback, useState } from "react";
import { useSupabaseClient, useUser } from "@helios/auth";
import { readFile } from "@tauri-apps/plugin-fs";
import type { FolderId, VaultId } from "./types";
import type { LocalFile } from "./useLocalFolderScan";
import { gzipBytes } from "./compression";

/**
 * Result of a single useAddLocalFile().run(...) call.
 *
 * `ok: true` means the file is in the vault with a version row pointing at
 * the uploaded sha. `lockAcquired` distinguishes whether the caller now holds
 * an exclusive lock on the file — false means the file already existed and
 * another user holds the lock. Callers should NOT proceed to edit/check-in
 * without first acquiring the lock when `lockAcquired === false`.
 *
 * `alreadyExisted` is true on the idempotent-replay path (file existed with
 * matching sha; no new version was created). Useful to distinguish "added
 * something new" from "this file was already up-to-date in the vault."
 */
export type AddLocalFileResult =
  | { ok: false; error: string }
  | { ok: true; lockAcquired: boolean; alreadyExisted: boolean };

const BUCKET = "vault-objects";

async function objectExists(client: ReturnType<typeof useSupabaseClient>, sha: string): Promise<boolean> {
  const prefix = sha.slice(0, 2);
  try {
    const { data, error } = await client.storage.from(BUCKET).list(prefix, {
      limit: 1,
      search: sha,
    });
    if (error) return false;
    return (data ?? []).some((o) => o.name === sha);
  } catch {
    return false;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Walks the local file's relative path; for each path segment that doesn't
 * already exist as a folder under the vault, creates it. Returns the leaf
 * folder_id (or null if the file is in the vault root).
 *
 * IMPORTANT: This function queries folders fresh from the database for EACH
 * segment, on EVERY call. The previous implementation accepted a `folders`
 * snapshot from React state, which went stale across batched bulk-adds —
 * adding two files into the same brand-new deep folder failed on the second
 * one with a unique-constraint violation. Querying live keeps a single hook
 * instance correct across N sequential `run()` calls in a bulk add, and also
 * handles concurrent races (two clients adding the same path) via a
 * post-failure retry-by-query.
 */
async function ensureFolderHierarchy(
  client: any,
  vaultId: VaultId,
  relativeDirSegments: string[],
): Promise<FolderId | null> {
  let parentId: FolderId | null = null;

  for (const seg of relativeDirSegments) {
    // Look up: does a folder with (vault_id, parent_id, name) already exist?
    // supabase-js distinguishes `IS NULL` (.is) from value match (.eq) for the
    // parent_id of root-level folders; using .eq with null silently misses.
    let q = client
      .from("folders")
      .select("*")
      .eq("vault_id", vaultId)
      .eq("name", seg);
    q = parentId === null ? q.is("parent_id", null) : q.eq("parent_id", parentId);
    const { data: existing, error: lookupErr } = await q;
    if (lookupErr) throw new Error(`lookup folder "${seg}": ${lookupErr.message}`);

    let found = existing?.[0];
    if (!found) {
      const { data: created, error } = await client
        .from("folders")
        .insert({ vault_id: vaultId, parent_id: parentId, name: seg })
        .select()
        .single();
      if (error) {
        // Race: another op (or another iteration in this same batch) may have
        // created it between our lookup and our insert. Re-query and reuse.
        let raceQ = client
          .from("folders")
          .select("*")
          .eq("vault_id", vaultId)
          .eq("name", seg);
        raceQ = parentId === null ? raceQ.is("parent_id", null) : raceQ.eq("parent_id", parentId);
        const { data: race } = await raceQ;
        if (race?.[0]) found = race[0];
        else throw new Error(`create folder "${seg}": ${error.message}`);
      } else {
        found = created;
      }
    }
    parentId = found.id;
  }

  return parentId;
}

export function useAddLocalFile() {
  const client = useSupabaseClient();
  const user = useUser();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  /**
   * Adds a local file to the vault:
   *   1. Ensures the folder hierarchy matches local relativePath (creates as needed)
   *   2. Reads local bytes + computes sha256
   *   3. Uploads bytes to Storage (skip if already present by sha)
   *   4. Calls pdm_add_and_lock RPC — atomically creates the file row,
   *      inserts version 1, sets latest_version_id, and acquires the lock for
   *      the caller. Single transaction; rolls back on any error.
   *
   * Previously this hook did create-file → acquire-lock → check_in (which
   * releases the lock) → re-acquire-lock as four separate client calls. That
   * was non-atomic: if the re-acquire raced with another user, the file ended
   * up added-but-unlocked while the UI surfaced a misleading "re-acquire lock"
   * error (ultrareview 2026-05-11, finding H13). The RPC fixes that.
   */
  const run = useCallback(
    async (vaultId: VaultId, local: LocalFile): Promise<AddLocalFileResult> => {
      if (!user) {
        const msg = "not authenticated";
        setError(new Error(msg));
        return { ok: false, error: msg };
      }
      setLoading(true);
      setError(null);
      try {
        // 1. Resolve folder hierarchy. e.g. "Chassis/Subframe/x.sldprt" → ["Chassis","Subframe"]
        const segments = local.relativePath.split("/");
        const fileName = segments[segments.length - 1];
        const dirSegments = segments.slice(0, -1);
        const folderId = await ensureFolderHierarchy(client, vaultId, dirSegments);

        // 2. Read local bytes + hash.
        const bytes = await readFile(local.absolutePath);
        const sha = await sha256Hex(bytes);

        // 3. Upload bytes (skip if content already exists in storage by sha).
        const path = `${sha.slice(0, 2)}/${sha}`;
        if (!(await objectExists(client, sha))) {
          const compressed = await gzipBytes(bytes);
          const { error: upErr } = await client.storage
            .from(BUCKET)
            .upload(path, compressed as BufferSource, { contentType: "application/octet-stream", upsert: false });
          if (upErr) {
            if (!(await objectExists(client, sha))) {
              throw new Error(`upload: ${upErr.message}`);
            }
          }
        }

        // 4. Atomic create-file + version 1 + acquire-lock.
        const { data, error: rpcErr } = await client.rpc("pdm_add_and_lock", {
          p_vault_id: vaultId,
          p_folder_id: folderId,
          p_name: fileName,
          p_sha256: sha,
          p_size: bytes.length,
          p_comment: "added from local folder",
        });
        if (rpcErr) throw new Error(`add_and_lock: ${rpcErr.message}`);

        // Surface the RPC's return: lock_id is null when the file already
        // existed and another user holds the lock. The previous implementation
        // returned `true` regardless, so the UI flashed a green tick and the
        // user only learned about the lock conflict at check-in time.
        const rpc = (data ?? {}) as {
          lock_id?: string | null;
          created?: boolean;
        };
        const lockAcquired = rpc.lock_id != null;
        const alreadyExisted = rpc.created === false;

        setLoading(false);
        return { ok: true, lockAcquired, alreadyExisted };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(new Error(msg));
        setLoading(false);
        return { ok: false, error: msg };
      }
    },
    [client, user],
  );

  return { run, loading, error };
}
