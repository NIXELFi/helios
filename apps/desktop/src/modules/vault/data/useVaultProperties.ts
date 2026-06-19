// Fetches latest-version `properties` for every live file in a vault and
// returns them as a Map<fileId, SwProperty[]> for O(1) lookup.
//
// Pattern mirrors useVaultMass: one Supabase query on `pdm.versions` that
// selects (file_id, properties) filtered to the vault's live latest_version_ids.
//
// Why a separate hook?
//   FILE_WITH_LATEST_SELECT intentionally omits `properties` to keep the bulk
//   file-list payload small. Properties are loaded lazily — only when a screen
//   that needs property-aware search is mounted.

import { useEffect, useRef, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { SwProperty, VaultId, VaultFile } from "./types";

/** Properties keyed by file id. Null while loading or on error. */
export type VaultPropertiesMap = Map<string, SwProperty[]>;

/**
 * Loads latest-version `properties` for all live files in the vault and
 * returns them as a Map<fileId, SwProperty[]>.
 *
 * @param vaultId - The active vault id (undefined while loading/no vault)
 * @param files   - The live file list from useAllFiles
 *
 * If `files` is null (still loading) the hook returns null and does nothing.
 * If properties aren't loaded yet the caller should fall back to filename-only
 * matching (no errors thrown).
 */
export function useVaultProperties(
  vaultId: VaultId | undefined,
  files: VaultFile[] | null,
): VaultPropertiesMap | null {
  const client = useSupabaseClient();
  const [propsMap, setPropsMap] = useState<VaultPropertiesMap | null>(null);

  // Track the last vaultId+files combination we already loaded so we don't
  // re-query on every render while the data is stable.
  const loadedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!vaultId || !files) {
      setPropsMap(null);
      loadedKeyRef.current = null;
      return;
    }

    // Collect the latest_version_id for every file that has one.
    const versionIds = files
      .map((f) => f.latest_version_id)
      .filter((id): id is string => id !== null);

    // Stable key to avoid redundant re-fetches when the same vault+files
    // reference hasn't changed (e.g. parent component re-renders).
    const loadKey = `${vaultId}:${versionIds.sort().join(",")}`;
    if (loadedKeyRef.current === loadKey) return;
    loadedKeyRef.current = loadKey;

    if (versionIds.length === 0) {
      setPropsMap(new Map());
      return;
    }

    let mounted = true;

    (async () => {
      const { data: rows, error: err } = await (client.from("versions") as any)
        .select("file_id, properties")
        .in("id", versionIds);

      if (!mounted) return;

      if (err || !rows) {
        // On error fall back gracefully — search will use filename-only.
        setPropsMap(new Map());
        return;
      }

      const map: VaultPropertiesMap = new Map();
      for (const row of rows as { file_id: string; properties: SwProperty[] | null }[]) {
        if (row.properties) {
          map.set(row.file_id, row.properties);
        }
      }
      setPropsMap(map);
    })();

    return () => {
      mounted = false;
    };
  }, [client, vaultId, files]);

  return propsMap;
}
