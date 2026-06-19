// Loads the refs + files + latest-version properties needed to build a BOM
// for any assembly in the active vault, then assembles the BomGraph input
// that buildBomTree expects.
//
// Strategy (three queries, no new migrations):
//   1. files — fetch ALL live (non-deleted) files for the vault: id + name +
//              latest_version_id.
//   2. versions — fetch `properties` for all latest_version_ids in a single
//                 .in() call (same pattern as useVaultMass).
//   3. refs — fetch ALL pdm.refs rows for the vault's live versions in one
//             .in() call so we can do the full recursive walk client-side.
//
// The result is a BomGraph (Map-based, pure data) plus the buildBomTree /
// flattenBom helpers — callers only need to invoke those with the rootFileId.

import { useCallback, useEffect, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import { parseMassGrams } from "../lib/massStats";
import type { BomGraph } from "../lib/bom";
import type { QueryResult, VaultId } from "./types";
import type { SwProperty } from "./types";

export type VaultBomResult = QueryResult<BomGraph>;

/**
 * Fetch the full BomGraph for a vault.
 *
 * The graph is vault-wide: once loaded, callers can walk it from any
 * assembly root without another fetch. Refreshes when vaultId changes or
 * when refetch() is called.
 */
export function useVaultBom(vaultId: VaultId | undefined): VaultBomResult {
  const client = useSupabaseClient();
  const [data, setData] = useState<BomGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!vaultId) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }

    let mounted = true;
    setLoading(true);
    setError(null);

    (async () => {
      // ── Query 1: All live files in the vault ──────────────────────────────
      const { data: fileRows, error: e1 } = await (client.from("files") as any)
        .select("id,name,latest_version_id")
        .eq("vault_id", vaultId)
        .is("deleted_at", null);

      if (!mounted) return;
      if (e1) {
        setError(e1 instanceof Error ? e1 : new Error(String(e1.message ?? e1)));
        setData(null);
        setLoading(false);
        return;
      }

      const files = (fileRows ?? []) as { id: string; name: string; latest_version_id: string | null }[];
      const versionIds = files
        .map((f) => f.latest_version_id)
        .filter((id): id is string => id !== null);

      // ── Query 2: Properties for all latest versions ───────────────────────
      const propsByFileId = new Map<string, SwProperty[] | null>();

      if (versionIds.length > 0) {
        const { data: versionRows, error: e2 } = await (client.from("versions") as any)
          .select("file_id,properties")
          .in("id", versionIds);

        if (!mounted) return;
        if (e2) {
          setError(e2 instanceof Error ? e2 : new Error(String(e2.message ?? e2)));
          setData(null);
          setLoading(false);
          return;
        }

        for (const v of (versionRows ?? []) as { file_id: string; properties: SwProperty[] | null }[]) {
          propsByFileId.set(v.file_id, v.properties);
        }
      }

      // ── Query 3: All refs whose parent version is in our live version set ─
      const refsMap = new Map<string, { childFileId: string | null; childPathHint: string }[]>();

      if (versionIds.length > 0) {
        const { data: refRows, error: e3 } = await (client.from("refs") as any)
          .select("parent_version_id,child_file_id,child_path_hint")
          .in("parent_version_id", versionIds);

        if (!mounted) return;
        if (e3) {
          setError(e3 instanceof Error ? e3 : new Error(String(e3.message ?? e3)));
          setData(null);
          setLoading(false);
          return;
        }

        // Build a version_id → file_id lookup so we can key refsMap by fileId
        // (the assembler graph uses file IDs, not version IDs, as keys).
        const versionToFile = new Map<string, string>(
          files
            .filter((f) => f.latest_version_id != null)
            .map((f) => [f.latest_version_id!, f.id]),
        );

        for (const r of (refRows ?? []) as {
          parent_version_id: string;
          child_file_id: string | null;
          child_path_hint: string;
        }[]) {
          const parentFileId = versionToFile.get(r.parent_version_id);
          if (!parentFileId) continue; // version not in our live set (race), skip

          const list = refsMap.get(parentFileId) ?? [];
          list.push({
            childFileId: r.child_file_id,
            childPathHint: r.child_path_hint,
          });
          refsMap.set(parentFileId, list);
        }
      }

      // ── Assemble BomGraph ────────────────────────────────────────────────
      const filesMap = new Map<string, { name: string; massGrams: number | null }>();

      for (const f of files) {
        const props = propsByFileId.get(f.id) ?? null;
        const massProp = props?.find((p) => p.name.toLowerCase() === "mass");
        const massGrams = massProp ? parseMassGrams(massProp.value) : null;
        filesMap.set(f.id, { name: f.name, massGrams });
      }

      if (!mounted) return;
      setData({ files: filesMap, refs: refsMap });
      setLoading(false);
    })();

    return () => {
      mounted = false;
    };
  }, [client, vaultId, tick]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, refetch };
}
