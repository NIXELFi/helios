import { useCallback, useState } from "react";
import { useSupabaseClient, useUser } from "@helios/auth";
import { readFile } from "@tauri-apps/plugin-fs";
import type { FolderId, VaultId } from "./types";
import type { LocalFile } from "./useLocalFolderScan";
import { gzipBytes } from "./compression";
import { notifyLockChange } from "./lock-events";
import { ledgerRecord } from "./sync-ledger";
import { sanitizePathSegment } from "./folder-paths";
import { friendlyUploadError } from "./pg-errors";

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

/**
 * Tri-state existence probe for a content-addressed object.
 *   true     → the object is present in storage (skip upload)
 *   false    → the object is definitively absent (must upload)
 *   "unknown"→ we couldn't determine (transient list error / throw)
 *
 * The previous version collapsed "couldn't determine" into `false`, which
 * forced a doomed `upsert:false` upload of an object that already existed and
 * surfaced a spurious error (audit V7). We now re-probe once on an
 * indeterminate result; if it's still indeterminate, the caller proceeds and
 * lets the upload's own conflict handling + the RPC be the source of truth.
 */
async function probeObject(
  client: ReturnType<typeof useSupabaseClient>,
  sha: string,
): Promise<boolean | "unknown"> {
  // Probe via the pdm_object_exists definer RPC rather than storage list():
  // the bucket SELECT policy is vault-scoped (20260610110000), so a list()
  // probe can't see content that exists but belongs to another vault, which
  // would send us down the upload → "Duplicate" → re-probe → fail path for
  // content-addressed dedup across vaults.
  try {
    const { data, error } = await client.rpc("pdm_object_exists", { p_sha: sha });
    if (error) return "unknown";
    return data === true;
  } catch {
    return "unknown";
  }
}

/**
 * Resolve whether the object exists, re-probing once if the first probe is
 * indeterminate. Returns true/false definitively, or "unknown" if both probes
 * failed (caller must not treat "unknown" as "absent").
 */
async function objectExists(
  client: ReturnType<typeof useSupabaseClient>,
  sha: string,
): Promise<boolean | "unknown"> {
  const first = await probeObject(client, sha);
  if (first !== "unknown") return first;
  // Indeterminate — re-probe once before giving up.
  return probeObject(client, sha);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Walks the local file's relative path; for each path segment that doesn't
 * already exist as a folder under the vault, creates it. Returns the leaf
 * folder_id (or null if the file is in the vault root) plus the ids of every
 * folder THIS call brought into existence, deepest last — so a caller whose
 * later add step fails can undo them (see the cleanup in `run`'s catch).
 *
 * `createdOut` is filled AS folders are created, not on return — so when the
 * walk itself fails mid-chain (segment 2 of A/B/C), the ancestors already
 * created are still reported to the caller's failure cleanup rather than
 * stranded.
 *
 * IMPORTANT: This function queries folders fresh from the database for EACH
 * segment, on EVERY call. The previous implementation accepted a `folders`
 * snapshot from React state, which went stale across batched bulk-adds —
 * adding two files into the same brand-new deep folder failed on the second
 * one with a unique-constraint violation. Querying live keeps a single hook
 * instance correct across N sequential `run()` calls in a bulk add.
 *
 * Creation goes through the pdm_create_folder RPC (20260721000000), which
 * resolves both failure modes the old direct INSERT had: a concurrent create
 * race (returns the winner's row) and a recycle-bin tombstone squatting on
 * the name (resurrects it empty — previously a permanent unique-violation,
 * audit M2).
 */
export async function ensureFolderHierarchy(
  client: any,
  vaultId: VaultId,
  relativeDirSegments: string[],
  createdOut?: FolderId[],
): Promise<{ folderId: FolderId | null; createdFolderIds: FolderId[] }> {
  let parentId: FolderId | null = null;
  const createdFolderIds: FolderId[] = createdOut ?? [];

  for (const seg of relativeDirSegments) {
    // Look up: does a folder with (vault_id, parent_id, name) already exist?
    // supabase-js distinguishes `IS NULL` (.is) from value match (.eq) for the
    // parent_id of root-level folders; using .eq with null silently misses.
    // CASE-INSENSITIVE on the name (ilike with wildcards escaped): the DB's
    // identity is case-sensitive but Windows/macOS collapse `Chassis` and
    // `chassis` to ONE directory — a case-sensitive lookup here created a
    // sibling duplicate folder whose files then fought the original's over
    // the same on-disk path (alternating synced/modified re-download thrash).
    let q = client
      .from("folders")
      .select("*")
      .eq("vault_id", vaultId)
      .is("deleted_at", null)
      .ilike("name", seg.replace(/([\\%_])/g, "\\$1"));
    q = parentId === null ? q.is("parent_id", null) : q.eq("parent_id", parentId);
    const { data: existing, error: lookupErr } = await q;
    if (lookupErr) throw new Error(`lookup folder "${seg}": ${lookupErr.message}`);

    // Prefer an exact-case match when several case-variants exist (legacy
    // duplicates), otherwise take the case-insensitive hit.
    const rows = (existing ?? []) as Array<{ id: FolderId; name: string }>;
    const found = rows.find((r) => r.name === seg) ?? rows[0];
    if (found) {
      parentId = found.id;
      continue;
    }
    const { data, error } = await client.rpc("pdm_create_folder", {
      p_vault_id: vaultId,
      p_parent_id: parentId,
      p_name: seg,
    });
    if (error) throw new Error(`create folder "${seg}": ${error.message}`);
    const res = data as { folder: { id: FolderId }; created: boolean; resurrected: boolean };
    parentId = res.folder.id;
    // A row we found live (created:false, resurrected:false = another op won a
    // race) existed anyway — only rows this call materialized are ours to undo.
    if (res.created || res.resurrected) createdFolderIds.push(parentId);
  }

  return { folderId: parentId, createdFolderIds };
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
    async (
      vaultId: VaultId,
      local: LocalFile,
      // Optional vault-folder prefix (slash-joined UNSANITIZED DB folder names,
      // from folderNamePath) under which to land this import. When provided, the
      // effective relativePath used for BOTH folder-hierarchy creation and the
      // final file name becomes `${targetPrefix}/${local.relativePath}` — so a
      // drag-drop onto folder "Chassis" of a dropped "frame/x.sldprt" creates
      // Chassis/frame and names the file there. Backward compatible: omitting it
      // (or passing "") preserves the prior root-relative behavior verbatim.
      targetPrefix?: string,
    ): Promise<AddLocalFileResult> => {
      if (!user) {
        const msg = "not authenticated";
        setError(new Error(msg));
        return { ok: false, error: msg };
      }
      setLoading(true);
      setError(null);
      // Folders materialized by THIS call, for the failure-path undo below.
      // Passed INTO ensureFolderHierarchy so a mid-chain failure still leaves
      // the already-created ancestors here for cleanup.
      const createdFolderIds: FolderId[] = [];
      try {
        // 1. Resolve folder hierarchy. e.g. "Chassis/Subframe/x.sldprt" → ["Chassis","Subframe"]
        //    A targetPrefix re-parents the whole import beneath it.
        const effectiveRelPath = targetPrefix
          ? `${targetPrefix}/${local.relativePath}`
          : local.relativePath;
        const segments = effectiveRelPath.split("/");
        const fileName = segments[segments.length - 1];
        const dirSegments = segments.slice(0, -1);
        const { folderId } = await ensureFolderHierarchy(client, vaultId, dirSegments, createdFolderIds);

        // 2. Resolve sha256 + size. The local-folder scan already computed and
        //    cached local.sha256 (and sizeBytes) — reuse it instead of
        //    re-reading + re-hashing the entire file, which freezes the UI on
        //    100MB+ CAD parts / CSVs (audit V8). Only fall back to reading
        //    when the scan didn't provide a sha. Bytes are read lazily, and
        //    only when we actually need to upload them.
        let bytes: Uint8Array | null = local.bytes ?? null;
        const readBytes = async (): Promise<Uint8Array> => {
          if (bytes === null) bytes = await readFile(local.absolutePath);
          return bytes;
        };
        let sha: string;
        let size: number;
        if (local.sha256) {
          sha = local.sha256;
          size = local.sizeBytes;
        } else {
          const b = await readBytes();
          sha = await sha256Hex(b);
          size = b.length;
        }

        // 3. Upload bytes (skip if content already exists in storage by sha).
        //    An "unknown" probe (transient list error) is NOT treated as
        //    "absent": we still attempt the upload but let its conflict
        //    handling + a post-failure re-probe decide, rather than forcing a
        //    guaranteed-failing upload of an object that may already exist.
        const path = `${sha.slice(0, 2)}/${sha}`;
        if ((await objectExists(client, sha)) !== true) {
          const compressed = await gzipBytes(await readBytes());
          const { error: upErr } = await client.storage
            .from(BUCKET)
            .upload(path, compressed as BufferSource, { contentType: "application/octet-stream", upsert: false });
          if (upErr) {
            // The object may already exist (we uploaded with upsert:false, or
            // a concurrent caller raced us). Only fail if a re-probe confirms
            // it's still definitively absent.
            if ((await objectExists(client, sha)) === false) {
              throw new Error(`upload: ${friendlyUploadError(upErr.message)}`);
            }
          }
        }

        // 4. Atomic create-file + version 1 + acquire-lock.
        const { data, error: rpcErr } = await client.rpc("pdm_add_and_lock", {
          p_vault_id: vaultId,
          p_folder_id: folderId,
          p_name: fileName,
          p_sha256: sha,
          p_size: size,
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

        // Record the materialization in the sync ledger (T6): the local file is
        // now in the vault at this sha, so a later local delete of it should be
        // recognised as a deletion (not "never downloaded"). The EFFECTIVE
        // relative path (prefix-adjusted) is sanitized per segment so the key
        // matches how useAutoSync keys the ledger (vaultRelativePath →
        // folderPath, which sanitizes). Ordinary names are byte-identical; a
        // name needing sanitization would otherwise classify a later local
        // delete as "never-downloaded" instead of "locally-deleted".
        // Fire-and-forget; a ledger IO failure must not fail the user's add.
        const ledgerKey = effectiveRelPath.split("/").map(sanitizePathSegment).join("/");
        void ledgerRecord(vaultId, ledgerKey, sha);

        // Broadcast so useLocks() consumers (and the auto-sync reconciliation
        // pass) pick up the new checkout immediately rather than waiting on the
        // realtime channel — the freshly-added file should go writable promptly.
        if (lockAcquired) notifyLockChange();

        setLoading(false);
        return { ok: true, lockAcquired, alreadyExisted };
      } catch (e) {
        // Undo folders this add materialized but never filled (audit M5: a
        // failed read/upload/RPC used to strand the just-created chain).
        // Deepest-first so each parent is empty by the time we reach it. The
        // server refuses if anything live landed in one meanwhile (e.g. an
        // earlier file of a bulk add succeeded into it) — and any refusal or
        // error here is swallowed: the user's failure is the ADD error, and a
        // best-effort cleanup must never replace or mask it.
        for (const id of [...createdFolderIds].reverse()) {
          try {
            await client.rpc("pdm_cleanup_empty_folder", { p_folder_id: id });
          } catch {
            /* best-effort */
          }
        }
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
