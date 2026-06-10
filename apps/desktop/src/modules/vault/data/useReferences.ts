import { useEffect, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { FileId, VersionId } from "./types";

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
      const { data: refs, error: e1 } = await (client.from("refs") as any)
        .select("parent_version_id").eq("child_file_id", fileId);
      if (!alive) return;
      if (e1) { setError(e1); setData(null); setLoading(false); return; }
      const verIds = Array.from(new Set((refs ?? []).map((r: any) => r.parent_version_id)));
      if (!verIds.length) { setData([]); setLoading(false); return; }
      const { data: versions } = await (client.from("versions") as any).select("id,file_id").in("id", verIds);
      const fileIds = Array.from(new Set((versions ?? []).map((v: any) => v.file_id)));
      // LIVE parents only — a soft-deleted assembly is not a current "user"
      // of this part; listing it would block/confuse delete decisions.
      const { data: files } = await (client.from("files") as any)
        .select("id,name").in("id", fileIds).is("deleted_at", null);
      if (!alive) return;
      const fileName = new Map<string, string>();
      for (const f of files ?? []) fileName.set(f.id, f.name);
      setData((versions ?? [])
        .filter((v: any) => fileName.has(v.file_id))
        .map((v: any): WhereUsedRow => ({
          parentFileId: v.file_id, parentVersionId: v.id, parentName: fileName.get(v.file_id)!,
        })));
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [client, fileId]);
  return { data, loading, error };
}
