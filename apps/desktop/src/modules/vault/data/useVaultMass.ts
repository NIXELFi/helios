// Fetches latest-version `properties` for every live file in a vault, then
// joins them to the file list so aggregateMass can compute vehicle mass stats.
//
// Why a separate hook (not bundled in useAllFiles)?
//   FILE_WITH_LATEST_SELECT intentionally omits `properties` to keep the bulk
//   file-list payload small at thousands-of-files scale. Mass/weight-budget is
//   a secondary, on-demand view — fetching properties only when the Insights
//   screen is mounted is the right trade-off.
//
// Implementation: chunked queries on `pdm.versions` that select
//   (file_id, properties)
// filtered to the vault's live latest_version_ids via fetchLatestVersionProperties
// (vault-bulk.ts). Chunking prevents the PostgREST 1 000-row cap and HTTP 414
// URL-length errors for large vaults (SDM26: 4 446 files).

import { useCallback, useEffect, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { SwProperty, QueryResult, VaultId, VaultFile } from "./types";
import type { FileMassRow } from "../lib/massStats";
import { fetchLatestVersionProperties } from "./vault-bulk";

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
      // Fetch file_id → properties via the shared chunked helper.
      // fetchLatestVersionProperties chunks the .in("id", versionIds) query at
      // 300 IDs per request, preventing the PostgREST 1 000-row cap and HTTP 414
      // URL-length errors that would silently truncate large vaults (SDM26: 4 446 files).
      let propsByFileId: Map<string, SwProperty[]>;
      try {
        propsByFileId = await fetchLatestVersionProperties(client, files);
      } catch (err) {
        if (!mounted) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setData(null);
        setLoading(false);
        return;
      }

      if (!mounted) return;

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
