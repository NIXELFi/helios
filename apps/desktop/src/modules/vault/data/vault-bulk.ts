// Shared bulk-query helpers for Vault data hooks.
//
// WHY THIS FILE EXISTS
//   PostgREST caps responses at 1 000 rows (configurable per project but
//   effectively immutable from the client). Several vault hooks issue
//   large .in() queries against `versions` that can exceed 1 000 rows AND
//   can exceed the HTTP URL length limit (414) for large vaults like SDM26
//   (4 446 files). This file provides three building blocks:
//
//   chunkIds              — pure split; splits an id array into ≤chunkSize batches
//   fetchByIdsChunked     — issues one .in() query per chunk, merges rows
//   fetchLatestVersionProperties — shared properties fetch used by useVaultBom,
//                                  useVaultMass, and useVaultProperties (DRY)
//
// fetchAllRows (pagination) lives in paginate.ts and is imported by hooks
// that scan all rows of a table (useAllFiles, useVaultBom Query 1).

import type { SwProperty } from "./types";

// Default chunk size: chosen to keep URL well under common 8 KB limits
// (each UUID is 36 chars; 300 × 36 = 10 800 chars total, but PostgREST uses
// a binary-encoded IN which is much shorter). Matches the documented
// recommendation for Supabase projects.
const DEFAULT_CHUNK_SIZE = 300;

// ---------------------------------------------------------------------------
// chunkIds — pure helper (no I/O), exported so callers can test it directly
// ---------------------------------------------------------------------------

/**
 * Split `ids` into batches of at most `chunkSize` elements.
 * Returns an empty array when `ids` is empty (no query needed).
 */
export function chunkIds(ids: string[], chunkSize: number = DEFAULT_CHUNK_SIZE): string[][] {
  if (ids.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    chunks.push(ids.slice(i, i + chunkSize));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Minimal type for the Supabase client so helpers are usable outside React
// (e.g. in async action handlers) without importing the full client type.
// ---------------------------------------------------------------------------
type SupabaseClientLike = {
  from: (table: string) => any;
};

// ---------------------------------------------------------------------------
// fetchByIdsChunked
// ---------------------------------------------------------------------------

/**
 * Issue `.select(selectStr).in("id", chunk)` queries in batches, merging all
 * rows into a single flat array.
 *
 * Prevents two failure modes for large id lists:
 *   1. PostgREST 1 000-row cap silently truncating results.
 *   2. HTTP 414 (URI Too Long) for vaults with 1 000+ ids.
 *
 * For small lists (ids.length ≤ chunkSize) this is equivalent to a single
 * `.in("id", ids)` call — behaviour is identical.
 *
 * @param client     Supabase client
 * @param table      Table name (e.g. "versions")
 * @param selectStr  Columns to select (e.g. "file_id,properties")
 * @param ids        List of values to match
 * @param column     Column to match `ids` against (default "id"; e.g.
 *                   "parent_version_id" when fetching refs by their parent)
 * @param chunkSize  Max ids per query (default 300)
 * @returns Flat merged array of all matching rows
 * @throws  Error if any chunk query returns a Supabase error
 */
export async function fetchByIdsChunked<T = Record<string, unknown>>(
  client: SupabaseClientLike,
  table: string,
  selectStr: string,
  ids: string[],
  column: string = "id",
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): Promise<T[]> {
  if (ids.length === 0) return [];

  const chunks = chunkIds(ids, chunkSize);
  const results: T[] = [];

  for (const chunk of chunks) {
    const { data, error } = await (client.from(table) as any)
      .select(selectStr)
      .in(column, chunk);

    if (error) {
      throw new Error(error.message ?? String(error));
    }

    if (data) results.push(...(data as T[]));
  }

  return results;
}

// ---------------------------------------------------------------------------
// fetchLatestVersionProperties  (DRY — replaces duplicate queries in 3 hooks)
// ---------------------------------------------------------------------------

/** Shape of a file object this helper needs — a subset of VaultFile. */
interface FileLike {
  id: string;
  latest_version_id: string | null;
}

/** Row shape returned by the versions query. */
interface VersionPropsRow {
  file_id: string;
  properties: SwProperty[] | null;
}

/**
 * Fetch `properties` for the latest version of every file in `files`, returned
 * as a `Map<fileId, SwProperty[]>`.
 *
 * Only files with a non-null `latest_version_id` are queried. Files whose
 * version row has `null` properties (not yet parsed) are absent from the map
 * (callers treat a missing key identically to an empty property list).
 *
 * Queries are chunked via fetchByIdsChunked to avoid the 1 000-row PostgREST
 * cap and HTTP 414 errors on large vaults.
 *
 * @param client     Supabase client
 * @param files      List of files (only id + latest_version_id are used)
 * @param chunkSize  Max version IDs per query (default 300)
 * @returns          Map<fileId, SwProperty[]> — only files with properties set
 * @throws           Error if any chunk query fails
 */
export async function fetchLatestVersionProperties(
  client: SupabaseClientLike,
  files: FileLike[],
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): Promise<Map<string, SwProperty[]>> {
  const map = new Map<string, SwProperty[]>();

  const versionIds = files
    .map((f) => f.latest_version_id)
    .filter((id): id is string => id !== null);

  if (versionIds.length === 0) return map;

  const rows = await fetchByIdsChunked<VersionPropsRow>(
    client,
    "versions",
    "file_id,properties",
    versionIds,
    "id",
    chunkSize,
  );

  for (const row of rows) {
    if (row.properties !== null) {
      map.set(row.file_id, row.properties);
    }
  }

  return map;
}
