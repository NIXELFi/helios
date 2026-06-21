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
import { fetchAllRows } from "./paginate";
import { fetchByIdsChunked, fetchLatestVersionProperties } from "./vault-bulk";

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
      // Paginated via fetchAllRows — vaults can hold thousands of files and
      // PostgREST's default response cap is 1 000 rows. The SDM26 vault has
      // 4 446 files; without pagination the BOM graph silently truncated.
      const { rows: fileRows, error: e1 } = await fetchAllRows<{
        id: string;
        name: string;
        latest_version_id: string | null;
      }>(
        () => (client.from("files") as any)
          .select("id,name,latest_version_id")
          .eq("vault_id", vaultId)
          .is("deleted_at", null)
          .order("id", { ascending: true }),
      );

      if (!mounted) return;
      if (e1) {
        setError(e1);
        setData(null);
        setLoading(false);
        return;
      }

      const files = fileRows;

      // ── Query 2: Properties for all latest versions ───────────────────────
      // Chunked via fetchLatestVersionProperties (DRY: same helper used by
      // useVaultMass and useVaultProperties) to avoid the 1 000-row cap and
      // HTTP 414 URL-length errors for large version-id lists.
      let propsByFileId: Map<string, SwProperty[]>;
      try {
        propsByFileId = await fetchLatestVersionProperties(client, files);
      } catch (e2) {
        if (!mounted) return;
        setError(e2 instanceof Error ? e2 : new Error(String(e2)));
        setData(null);
        setLoading(false);
        return;
      }

      if (!mounted) return;

      const versionIds = files
        .map((f) => f.latest_version_id)
        .filter((id): id is string => id !== null);

      // ── Query 3: All refs whose parent version is in our live version set ─
      // Chunked via fetchByIdsChunked — large vaults produce large versionIds
      // lists that can exceed 1 000 rows or the URL length limit.
      const refsMap = new Map<string, { childFileId: string | null; childPathHint: string }[]>();

      if (versionIds.length > 0) {
        let refRows: { parent_version_id: string; child_file_id: string | null; child_path_hint: string }[];
        try {
          refRows = await fetchByIdsChunked<{
            parent_version_id: string;
            child_file_id: string | null;
            child_path_hint: string;
          }>(client, "refs", "parent_version_id,child_file_id,child_path_hint", versionIds, "parent_version_id");
        } catch (e3) {
          if (!mounted) return;
          setError(e3 instanceof Error ? e3 : new Error(String(e3)));
          setData(null);
          setLoading(false);
          return;
        }

        if (!mounted) return;

        // Build a version_id → file_id lookup so we can key refsMap by fileId
        // (the assembler graph uses file IDs, not version IDs, as keys).
        const versionToFile = new Map<string, string>(
          files
            .filter((f) => f.latest_version_id != null)
            .map((f) => [f.latest_version_id!, f.id]),
        );

        for (const r of refRows) {
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
