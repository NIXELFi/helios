import { useCallback, useState } from "react";
import { useSupabaseClient, useUser } from "@helios/auth";
import { readFile } from "@tauri-apps/plugin-fs";
import type { Folder, FolderId, VaultId } from "./types";
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
 */
async function ensureFolderHierarchy(
  client: any,
  vaultId: VaultId,
  folders: Folder[],
  relativeDirSegments: string[],
): Promise<FolderId | null> {
  let parentId: FolderId | null = null;
  let known = [...folders];
  for (const seg of relativeDirSegments) {
    let existing = known.find((f) => f.parent_id === parentId && f.name === seg);
    if (!existing) {
      const { data: created, error } = await client
        .from("folders")
        .insert({ vault_id: vaultId, parent_id: parentId, name: seg })
        .select()
        .single();
      if (error) throw new Error(`create folder "${seg}": ${error.message}`);
      existing = created;
      known = [...known, created];
    }
    parentId = existing!.id;
  }
  return parentId;
}

export function useAddLocalFile(folders: Folder[]) {
  const client = useSupabaseClient();
  const user = useUser();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  /**
   * Adds a local file to the vault:
   *   1. Ensures the folder hierarchy matches local relativePath
   *   2. Creates the pdm.files row
   *   3. Reads local bytes + computes sha256
   *   4. Uploads bytes to Storage
   *   5. Acquires lock (RLS requires holding a lock to insert a version)
   *   6. Calls pdm_check_in to insert version 1 — check_in releases the lock
   *   7. Re-acquires the lock so the user owns the file post-add
   *
   * NOTE: Steps 5-7 are a deliberate dance. pdm_check_in's contract is
   * "caller holds the lock, RPC releases it after recording the version".
   * We re-acquire immediately after so the file lands in "checked out by me"
   * state, matching the UX promise: drop a file → Add to Vault → it's yours
   * (locked), ready for further edits or explicit Check In. A future
   * pdm.add_file RPC could do this atomically server-side.
   *
   * Returns true on success.
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
        const folderId = await ensureFolderHierarchy(client, vaultId, folders, dirSegments);

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
    [client, user, folders],
  );

  return { run, loading, error };
}
