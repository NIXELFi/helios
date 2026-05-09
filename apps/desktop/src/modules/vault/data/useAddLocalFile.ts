import { useCallback, useState } from "react";
import { useSupabaseClient, useUser } from "@helios/auth";
import { readFile } from "@tauri-apps/plugin-fs";
import type { FolderId, VaultId } from "./types";
import type { LocalFile } from "./useLocalFolderScan";

const BUCKET = "vault-objects";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
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
   *   2. Creates the pdm.files row
   *   3. Reads local bytes + computes sha256
   *   4. Uploads bytes to Storage
   *   5. Acquires lock (RLS requires holding a lock to insert a version)
   *   6. Calls pdm_check_in to insert version 1 — check_in releases the lock
   *   7. Re-acquires the lock so the user owns the file post-add
   *
   * Steps 5-7 are a deliberate dance because pdm_check_in's contract releases
   * the lock; we re-acquire so the file lands in "checked out by me" state.
   * A future server-side `pdm.add_file` RPC could do this atomically.
   */
  const run = useCallback(
    async (vaultId: VaultId, local: LocalFile): Promise<boolean> => {
      if (!user) {
        setError(new Error("not authenticated"));
        return false;
      }
      setLoading(true);
      setError(null);
      try {
        // 1. Resolve folder hierarchy. e.g. "Chassis/Subframe/x.sldprt" → ["Chassis","Subframe"]
        const segments = local.relativePath.split("/");
        const fileName = segments[segments.length - 1];
        const dirSegments = segments.slice(0, -1);
        const folderId = await ensureFolderHierarchy(client, vaultId, dirSegments);

        // 2. Create file row.
        const { data: file, error: fileErr } = await (client.from("files") as any)
          .insert({ vault_id: vaultId, folder_id: folderId, name: fileName })
          .select()
          .single();
        if (fileErr) throw new Error(`create file: ${fileErr.message}`);

        // 3. Read local bytes + hash.
        const bytes = await readFile(local.absolutePath);
        const sha = await sha256Hex(bytes);

        // 4. Upload bytes (skip if content already exists in storage by sha).
        const path = `${sha.slice(0, 2)}/${sha}`;
        const { error: upErr } = await client.storage
          .from(BUCKET)
          .upload(path, bytes, { contentType: "application/octet-stream", upsert: false });
        if (upErr && !/already exists/i.test(upErr.message)) {
          throw new Error(`upload: ${upErr.message}`);
        }

        // 5. Acquire lock (required before check_in can insert a version).
        const { error: lockErr } = await (client.from("locks") as any)
          .insert({ file_id: file.id, user_id: user.id });
        if (lockErr) throw new Error(`acquire lock: ${lockErr.message}`);

        // 6. Check in as version 1 — this also releases the lock.
        const { error: ciErr } = await client.rpc("pdm_check_in", {
          p_file_id: file.id,
          p_sha256: sha,
          p_size: bytes.length,
          p_comment: "added from local folder",
        });
        if (ciErr) throw new Error(`check_in: ${ciErr.message}`);

        // 7. Re-acquire lock so the user owns the file post-add ("default checked out").
        const { error: relockErr } = await (client.from("locks") as any)
          .insert({ file_id: file.id, user_id: user.id });
        if (relockErr) throw new Error(`re-acquire lock: ${relockErr.message}`);

        setLoading(false);
        return true;
      } catch (e) {
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
        return false;
      }
    },
    [client, user],
  );

  return { run, loading, error };
}
