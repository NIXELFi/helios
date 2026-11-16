// Fetches latest-version `properties` for every live file in a vault and
// returns them as a Map<fileId, SwProperty[]> for O(1) lookup (property-aware
// search in VaultSearch).
//
// Why a separate hook?
//   FILE_WITH_LATEST_SELECT intentionally omits `properties` to keep the bulk
//   file-list payload small. Properties are loaded lazily here.
//
// INCREMENTAL (2026-11-16). The first version re-pulled the properties of EVERY
// file in the vault (one `versions?id=in.(…300 ids…)` request per 300 files)
// whenever the catalog array changed identity — i.e. after every single add or
// check-in — and a superseded pull kept paging to the end. A 240-file
// test-data drop into SDM27 (3,091 files) therefore fired ~50 property
// requests per added file, 4–6 overlapping copies of the same chunks, ~4.9 k
// requests in two hours, plus the main-thread work of rebuilding the map each
// time. Now:
//   - results are cached per version id. A version's properties are written
//     at check-in or by the data-card backfill, so "none" can later become
//     set — only for SOLIDWORKS files, which are re-checked at most every
//     SW_RECHECK_MS. (A rare overwrite of already-set properties is picked up
//     on the file's next check-in, i.e. its next version id.)
//   - only version ids not in the cache are fetched — usually the one new file,
//   - bursts of catalog changes are coalesced (DEBOUNCE_MS, at most MAX_WAIT_MS),
//   - a superseded fetch stops between chunks,
//   - the previous map stays visible while a refresh is in flight (same vault).

import { useEffect, useRef, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { SwProperty, VaultId, VaultFile } from "./types";
import { chunkIds } from "./vault-bulk";

/** Properties keyed by file id. Null while loading or on error. */
export type VaultPropertiesMap = Map<string, SwProperty[]>;

/** One cached version row: its file and its properties (null = none stored). */
export interface CachedVersionProps {
  fileId: string;
  properties: SwProperty[] | null;
  /** When this row was fetched (epoch ms). */
  checkedAt: number;
}

/** Collapse a burst of catalog changes (one per add/check-in) into one fetch. */
export const DEBOUNCE_MS = 750;
/** A continuous stream of changes (a bulk add) still refreshes this often. */
export const MAX_WAIT_MS = 5_000;
/** How long a SOLIDWORKS file's "no properties" answer is trusted. Most such
 *  files never get any (add / auto-add / batch check-in don't record them),
 *  so re-asking on every catalog change re-pulled thousands of rows. */
export const SW_RECHECK_MS = 5 * 60_000;

// Only SOLIDWORKS files ever get properties written, and possibly AFTER their
// version row exists (check-in records them right after, and the lazy backfill
// fills old versions). A cached "none" for those must be re-checked; for every
// other file type "none" is final.
const SW_EXTS = [".sldprt", ".sldasm", ".slddrw"];
function mayGainProperties(name: string): boolean {
  const l = name.toLowerCase();
  return SW_EXTS.some((e) => l.endsWith(e));
}

/**
 * Pure planning step (exported for tests): which latest-version ids still need
 * a fetch, given what is cached. A version is fetched when it was never cached,
 * or when it is cached as "no properties", belongs to a SOLIDWORKS file (whose
 * properties may have been recorded since) and was last checked at least
 * SW_RECHECK_MS ago.
 */
export function versionIdsToFetch(
  files: Pick<VaultFile, "name" | "latest_version_id">[],
  cache: Map<string, CachedVersionProps>,
  now: number = Date.now(),
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const vid = f.latest_version_id;
    if (!vid || seen.has(vid)) continue;
    seen.add(vid);
    const hit = cache.get(vid);
    if (
      !hit ||
      (hit.properties === null && mayGainProperties(f.name) && now - hit.checkedAt >= SW_RECHECK_MS)
    ) {
      out.push(vid);
    }
  }
  return out;
}

/**
 * Pure assembly step (exported for tests): the file → properties map for the
 * CURRENT files, from the cache. A file is keyed by its own id (not the cached
 * row's), so a moved/renamed file still resolves. Files without stored
 * properties are absent (callers treat a missing key as an empty list).
 */
export function buildPropertiesMap(
  files: Pick<VaultFile, "id" | "latest_version_id">[],
  cache: Map<string, CachedVersionProps>,
): VaultPropertiesMap {
  const map: VaultPropertiesMap = new Map();
  for (const f of files) {
    const vid = f.latest_version_id;
    if (!vid) continue;
    const hit = cache.get(vid);
    if (hit?.properties) map.set(f.id, hit.properties);
  }
  return map;
}

/**
 * Loads latest-version `properties` for all live files in the vault and
 * returns them as a Map<fileId, SwProperty[]>.
 *
 * @param vaultId - The active vault id (undefined while loading/no vault)
 * @param files   - The live file list from useAllFiles
 *
 * Returns null until the first load for this vault completes (or if it
 * failed); the caller then falls back to filename-only matching.
 */
export function useVaultProperties(
  vaultId: VaultId | undefined,
  files: VaultFile[] | null,
): VaultPropertiesMap | null {
  const client = useSupabaseClient();
  const [propsMap, setPropsMap] = useState<VaultPropertiesMap | null>(null);

  // Cache of version id → properties, for ONE vault. Reset on vault switch so
  // another vault's data can never leak into this one's search.
  const cacheRef = useRef<{ vaultId: VaultId | undefined; rows: Map<string, CachedVersionProps> }>({
    vaultId: undefined,
    rows: new Map(),
  });

  // When the oldest not-yet-served catalog change arrived (for MAX_WAIT_MS).
  const firstPendingRef = useRef<number | null>(null);

  useEffect(() => {
    if (!vaultId || !files) {
      setPropsMap(null);
      return;
    }
    if (cacheRef.current.vaultId !== vaultId) {
      // Clear the previous vault's map BEFORE any fetch begins, so a vault
      // switch never shows stale cross-vault data while loading or on error.
      cacheRef.current = { vaultId, rows: new Map() };
      setPropsMap(null);
    }
    const cache = cacheRef.current.rows;

    let cancelled = false;
    // Trailing debounce with a ceiling: each change restarts the wait, but a
    // burst that never pauses still refreshes MAX_WAIT_MS after it began.
    const now = Date.now();
    if (firstPendingRef.current === null) firstPendingRef.current = now;
    const delay = Math.min(DEBOUNCE_MS, Math.max(0, firstPendingRef.current + MAX_WAIT_MS - now));
    const timer = setTimeout(() => {
      firstPendingRef.current = null;
      void (async () => {
        const missing = versionIdsToFetch(files, cache);
        try {
          for (const chunk of chunkIds(missing)) {
            if (cancelled) return;
            const { data, error } = await (client.from("versions") as any)
              .select("id,file_id,properties")
              .in("id", chunk);
            if (error) throw new Error(error.message ?? String(error));
            const got = new Set<string>();
            for (const row of (data ?? []) as Array<{ id: string; file_id: string; properties: SwProperty[] | null }>) {
              got.add(row.id);
              cache.set(row.id, { fileId: row.file_id, properties: row.properties ?? null, checkedAt: Date.now() });
            }
            // An id RLS hid (or that vanished) comes back empty: remember it as
            // "none" so it isn't re-requested on every catalog change.
            for (const id of chunk) {
              if (!got.has(id) && !cache.has(id)) cache.set(id, { fileId: "", properties: null, checkedAt: Date.now() });
            }
          }
        } catch {
          if (cancelled) return;
          // Keep whatever map is already showing (same vault); a first-load
          // failure stays null so search uses filename-only matching.
          return;
        }
        if (cancelled || cacheRef.current.vaultId !== vaultId) return;
        // Drop cached versions no longer referenced (superseded by a newer
        // check-in, or the file was deleted) so the cache tracks the vault.
        const live = new Set(files.map((f) => f.latest_version_id).filter(Boolean) as string[]);
        for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);
        setPropsMap(buildPropertiesMap(files, cache));
      })();
    }, delay);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, vaultId, files]);

  return propsMap;
}
