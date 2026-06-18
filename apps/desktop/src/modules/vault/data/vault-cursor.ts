import type { VaultId } from "./types";

/**
 * A cheap "did anything change?" signature for a vault, used as a safety net
 * behind realtime. Instead of blindly re-pulling the full file catalog on a
 * timer (megabytes per cycle), we fetch only these four counts — via head-only
 * PostgREST count requests, so the response body is empty (~zero egress) — and
 * compare against the last seen signature. The heavy reconcile runs only when
 * the signature actually moves.
 *
 * The four counts between them detect every change that matters to sync:
 * - liveFiles   — a file added / soft-deleted / restored
 * - versions    — a check-in (a new version row; versions are append-only)
 * - liveFolders — a folder added / soft-deleted / restored
 * - activeLocks — a lock acquired / released (scoped to this vault's files)
 *
 * A pure rename/move (no count change) is the only mutation a counts signature
 * can miss, and realtime is the fast path for that; this poll only has to cover
 * the case where realtime dropped, where a rename in isolation is both rare and
 * self-healing on the next real event.
 */
export interface VaultCursor {
  liveFiles: number;
  versions: number;
  liveFolders: number;
  activeLocks: number;
}

// The codebase treats the supabase client/query builder as `any` at helper
// boundaries (cf. paginate.ts `buildQuery: () => any`) to avoid pulling the
// @supabase/supabase-js types into app source — the client comes from
// @helios/auth. We only need `.from(table)` here.
type SupabaseLike = { from: (table: string) => any };

/** Deterministic string form of a cursor for cheap equality comparison. */
export function cursorKey(c: VaultCursor): string {
  return `${c.liveFiles}:${c.versions}:${c.liveFolders}:${c.activeLocks}`;
}

/**
 * Did the vault change since the last seen cursor? `prev === null` is the first
 * observation: it establishes a baseline and is NOT a change, so opening a vault
 * never triggers an immediate full re-pull.
 */
export function cursorChanged(prev: VaultCursor | null, next: VaultCursor): boolean {
  if (!prev) return false;
  return cursorKey(prev) !== cursorKey(next);
}

/**
 * Fetch the current cursor for a vault with four head-only count queries (no
 * row bodies). Throws if any sub-count errors so the caller can fall back to a
 * full reconcile rather than mistake an error for "nothing changed".
 */
export async function fetchVaultCursor(
  client: SupabaseLike,
  vaultId: VaultId,
): Promise<VaultCursor> {
  const countOf = async (q: PromiseLike<{ count: number | null; error: unknown }>): Promise<number> => {
    const { count, error } = await q;
    if (error) {
      const msg = (error as { message?: string })?.message;
      throw error instanceof Error ? error : new Error(msg ?? "count failed");
    }
    return count ?? 0;
  };
  const head = { count: "exact", head: true } as const;

  const [liveFiles, versions, liveFolders, activeLocks] = await Promise.all([
    countOf(client.from("files").select("id", head).eq("vault_id", vaultId).is("deleted_at", null)),
    // versions has no vault_id — scope by an inner join on the parent file.
    countOf(
      client.from("versions").select("id, files!inner(vault_id)", head).eq("files.vault_id", vaultId),
    ),
    countOf(client.from("folders").select("id", head).eq("vault_id", vaultId).is("deleted_at", null)),
    // locks have no vault_id — scope to THIS vault via an inner join on the
    // parent file (like versions). Without this the count is cross-vault, so a
    // lock change in ANY vault moved the signature and triggered a full
    // reconcile of the active vault for an event that didn't touch it.
    countOf(
      client.from("locks").select("id, files!inner(vault_id)", head).eq("files.vault_id", vaultId).is("released_at", null),
    ),
  ]);

  return { liveFiles, versions, liveFolders, activeLocks };
}
