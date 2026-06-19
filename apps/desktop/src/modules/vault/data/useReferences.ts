import { useEffect, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { FileId, VersionId } from "./types";

type SupabaseClientLike = ReturnType<typeof useSupabaseClient>;

// ---------------------------------------------------------------------------
// Pure helper — extracted so it can be unit-tested without a live DB
// ---------------------------------------------------------------------------

/** Raw shapes the helper operates on (subset of what the DB returns). */
interface _RefRow       { parent_version_id: string }
interface _VersionRow   { id: string; file_id: string }
interface _FileRow      { id: string; name: string; latest_version_id: string | null; deleted_at?: string | null }

/**
 * Given the raw rows fetched during a where-used query, return only the
 * parents whose referencing version IS their file's current latest version
 * AND whose file has not been soft-deleted.
 *
 * This matches SolidWorks PDM behaviour: only the HEAD revision of each
 * assembly counts as a live "user" of the child part.
 */
export function filterWhereUsedToLatest(
  refs: _RefRow[],
  versionsById: Map<string, _VersionRow>,
  filesById: Map<string, _FileRow>,
): WhereUsedRow[] {
  const seen = new Set<string>();
  const result: WhereUsedRow[] = [];
  for (const ref of refs) {
    const version = versionsById.get(ref.parent_version_id);
    if (!version) continue;
    const file = filesById.get(version.file_id);
    if (!file) continue;                          // soft-deleted parents were excluded from filesById
    if (file.deleted_at) continue;               // belt-and-suspenders soft-delete guard
    if (file.latest_version_id !== ref.parent_version_id) continue; // stale ref — not current head
    if (seen.has(file.id)) continue;             // de-duplicate
    seen.add(file.id);
    result.push({ parentFileId: file.id, parentVersionId: ref.parent_version_id, parentName: file.name });
  }
  return result;
}

export interface ContainsRow {
  childPathHint: string;
  childFileId: FileId | null;
  childVersionId: VersionId | null;
  childName: string;   // resolved file name, or the hint's basename when unresolved
  resolved: boolean;
}
export interface WhereUsedRow {
  parentFileId: FileId;
  parentVersionId: VersionId;
  parentName: string;
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * Children referenced BY a parent version ("Contains"). Two-step query (refs,
 * then files by id) rather than a PostgREST embed — `pdm.refs` has two FKs into
 * `versions` (parent + child), which makes an embed ambiguous.
 */
export function useContains(versionId: VersionId | null) {
  const client = useSupabaseClient();
  const [data, setData] = useState<ContainsRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    if (!versionId) { setData(null); setLoading(false); setError(null); return; }
    let alive = true;
    setLoading(true); setError(null);
    (async () => {
      const { data: refs, error: e1 } = await (client.from("refs") as any)
        .select("child_path_hint,child_file_id,child_version_id").eq("parent_version_id", versionId);
      if (!alive) return;
      if (e1) { setError(e1); setData(null); setLoading(false); return; }
      const fileIds = (refs ?? []).map((r: any) => r.child_file_id).filter(Boolean);
      // Resolve names from LIVE files only: a soft-deleted child is a broken
      // reference (the assembly still points at it, but it's in the recycle
      // bin), so it renders as unresolved rather than as a healthy link.
      const names = new Map<string, string>();
      if (fileIds.length) {
        const { data: files } = await (client.from("files") as any)
          .select("id,name").in("id", fileIds).is("deleted_at", null);
        for (const f of files ?? []) names.set(f.id, f.name);
      }
      if (!alive) return;
      setData((refs ?? []).map((r: any): ContainsRow => {
        const live = !!r.child_file_id && names.has(r.child_file_id);
        return {
          childPathHint: r.child_path_hint,
          childFileId: r.child_file_id,
          childVersionId: r.child_version_id,
          childName: live ? names.get(r.child_file_id)! : basename(r.child_path_hint),
          resolved: live,
        };
      }));
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [client, versionId]);
  return { data, loading, error };
}

/**
 * Async helper: fetch the current where-used parents for a file on demand.
 * Usable outside React (e.g. in click handlers). Same query + filter logic
 * as useWhereUsed.
 */
export async function fetchWhereUsed(
  client: SupabaseClientLike,
  fileId: FileId,
): Promise<WhereUsedRow[]> {
  const { data: refs, error: e1 } = await (client.from("refs") as any)
    .select("parent_version_id").eq("child_file_id", fileId);
  if (e1) throw e1;
  const verIds = Array.from(new Set((refs ?? []).map((r: any) => r.parent_version_id)));
  if (!verIds.length) return [];
  const { data: versions } = await (client.from("versions") as any).select("id,file_id").in("id", verIds);
  const fileIds = Array.from(new Set((versions ?? []).map((v: any) => v.file_id)));
  // LIVE parents only — a soft-deleted assembly is not a current "user"
  // of this part; listing it would block/confuse delete decisions.
  // latest_version_id is fetched so we can filter to head-revision refs only.
  const { data: files } = await (client.from("files") as any)
    .select("id,name,latest_version_id").in("id", fileIds).is("deleted_at", null);
  const versionsById = new Map<string, { id: string; file_id: string }>(
    (versions ?? []).map((v: any) => [v.id, v]),
  );
  const filesById = new Map<string, { id: string; name: string; latest_version_id: string | null; deleted_at: null }>(
    (files ?? []).map((f: any) => [f.id, { ...f, deleted_at: null }]),
  );
  return filterWhereUsedToLatest(refs ?? [], versionsById, filesById);
}

/** Parents that reference a given file ("Where Used"). */
export function useWhereUsed(fileId: FileId | null) {
  const client = useSupabaseClient();
  const [data, setData] = useState<WhereUsedRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    if (!fileId) { setData(null); setLoading(false); setError(null); return; }
    let alive = true;
    setLoading(true); setError(null);
    (async () => {
      try {
        const rows = await fetchWhereUsed(client, fileId);
        if (!alive) return;
        setData(rows);
      } catch (e) {
        if (!alive) return;
        setError(e as Error);
        setData(null);
      }
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [client, fileId]);
  return { data, loading, error };
}
