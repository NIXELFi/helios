// Fetches latest-version `properties` for every live file in a vault and
// returns them as a Map<fileId, SwProperty[]> for O(1) lookup.
//
// Pattern mirrors useVaultMass: chunked queries on `pdm.versions` that select
// (file_id, properties) filtered to the vault's live latest_version_ids, via
// fetchLatestVersionProperties (vault-bulk.ts) to avoid the 1 000-row PostgREST
// cap and HTTP 414 URL-length errors on large vaults.
//
// Why a separate hook?
//   FILE_WITH_LATEST_SELECT intentionally omits `properties` to keep the bulk
//   file-list payload small. Properties are loaded lazily — only when a screen
//   that needs property-aware search is mounted.

import { useEffect, useRef, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { SwProperty, VaultId, VaultFile } from "./types";
import { fetchLatestVersionProperties } from "./vault-bulk";

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

    // FIX: clear the previous vault's map BEFORE the async fetch begins, so a
    // vault switch never leaves stale cross-vault data visible while the new
    // fetch is in-flight or if the fetch errors. We stamp the key only after a
    // successful load so a retry (new files ref) will re-fetch correctly.
    loadedKeyRef.current = null;
    setPropsMap(null);

    if (versionIds.length === 0) {
      loadedKeyRef.current = loadKey;
      setPropsMap(new Map());
      return;
    }

    let mounted = true;

    (async () => {
      // Chunked via fetchLatestVersionProperties to prevent the PostgREST
      // 1 000-row cap and HTTP 414 URL-length errors for large vaults.
      // On error we fall back to null (not an empty map) so callers can
      // distinguish "not yet loaded" from "loaded with no properties" — and
      // we do NOT retain the previous vault's successful map (FIX 4).
      let map: VaultPropertiesMap;
      try {
        map = await fetchLatestVersionProperties(client, files);
      } catch (_err) {
        if (!mounted) return;
        // Error: leave propsMap null so the caller uses filename-only search.
        // Do NOT set an empty map here — that would hide the prior vault's
        // successful data but still show as "loaded" (stale cross-vault data).
        setPropsMap(null);
        return;
      }

      if (!mounted) return;
      loadedKeyRef.current = loadKey;
      setPropsMap(map);
    })();

    return () => {
      mounted = false;
    };
  }, [client, vaultId, files]);

  return propsMap;
}
