// Fetches latest-version `properties` for every live file in a vault, then
// joins them to the file list so aggregateMass can compute vehicle mass stats.
//
// Why a separate hook (not bundled in useAllFiles)?
//   FILE_WITH_LATEST_SELECT intentionally omits `properties` to keep the bulk
//   file-list payload small at thousands-of-files scale. Mass/weight-budget is
//   a secondary, on-demand view — fetching properties only when the Insights
//   screen is mounted is the right trade-off.
//
// Implementation: one Supabase query on `pdm.versions` that selects
//   (file_id, properties)
// filtered to the vault's live latest_version_ids. No pagination needed —
// we request exactly N rows for N files (max ≈ 5 000 for the largest vaults).

import { useCallback, useEffect, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { SwProperty, QueryResult, VaultId, VaultFile } from "./types";
import type { FileMassRow } from "../lib/massStats";

/** Vault file augmented with its latest-version properties. */
export type FileMassRecord = FileMassRow;

/** Query result: the list of files enriched with `_properties`. */
export type VaultMassResult = QueryResult<FileMassRecord[]>;

/**
 * Loads latest-version `properties` for all live files in the vault and
 * joins them onto a FileMassRow shape that aggregateMass can consume.
 *
 * @param vaultId - The active vault id (undefined while loading/no vault)
 * @param files   - The live file list from useAllFiles (already paginated)
 */
export function useVaultMass(
  vaultId: VaultId | undefined,
  files: VaultFile[] | null,
): VaultMassResult {
  const client = useSupabaseClient();
  const [data, setData] = useState<FileMassRecord[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!vaultId || !files) {
      setData(null);
      setLoading(files === null ? false : false);
      setError(null);
      return;
    }

    // Collect the latest_version_id for every file that has one.
    const versionIds = files
      .map((f) => f.latest_version_id)
      .filter((id): id is string => id !== null);

    if (versionIds.length === 0) {
      // No versions at all — return empty rows with no properties.
      setData(
        files.map((f) => ({
          id: f.id,
          name: f.name,
          folder_id: f.folder_id,
          _properties: null,
        })),
      );
      setLoading(false);
      setError(null);
      return;
    }

    let mounted = true;
    setLoading(true);
    setError(null);

    (async () => {
      // Select only the fields we need: file_id + properties.
      // Filter to exactly the latest_version_ids for this vault's live files.
      // PostgREST will return at most versionIds.length rows — well under 1 000
      // for most vaults and under 5 000 even for the largest SDM26 import, so
      // a single un-paginated call is safe here.
      const { data: rows, error: err } = await (client.from("versions") as any)
        .select("file_id, properties")
        .in("id", versionIds);

      if (!mounted) return;

      if (err) {
        setError(err instanceof Error ? err : new Error(String(err.message ?? err)));
        setData(null);
        setLoading(false);
        return;
      }

      // Build a map from file_id → properties for O(1) join.
      const propsByFileId = new Map<string, SwProperty[] | null>();
      for (const row of rows as { file_id: string; properties: SwProperty[] | null }[]) {
        propsByFileId.set(row.file_id, row.properties);
      }

      const enriched: FileMassRecord[] = files.map((f) => ({
        id: f.id,
        name: f.name,
        folder_id: f.folder_id,
        _properties: propsByFileId.get(f.id) ?? null,
      }));

      setData(enriched);
      setLoading(false);
    })();

    return () => {
      mounted = false;
    };
  }, [client, vaultId, files, tick]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, refetch };
}
