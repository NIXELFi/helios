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
// @helios/auth. We need `.rpc(fn, args)` (the fast path) and `.from(table)`
// (the legacy fallback). `rpc` is optional so an older/stubbed client still
// type-checks against the fallback.
type SupabaseLike = {
  from: (table: string) => any;
  rpc?: (fn: string, args?: Record<string, unknown>) => any;
};

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
 * Has this process seen the server answer "no such function" for the cursor
 * RPC? A database that predates 20260909100000 answers that on EVERY probe, so
 * we latch it once and go straight to the legacy counts for the rest of the
 * session rather than pay for a doomed request every poll. Only a genuine
 * missing-function signal sets it — a 500 or an outage must NOT downgrade the
 * client permanently.
 */
let rpcMissing = false;

/** PostgREST answers PGRST202 for an unknown RPC; Postgres itself answers
 *  42883. Both wordings ("Could not find the function …", "… does not exist")
 *  are matched too, because some paths lose the code (see useBridgeSync). */
function isMissingFunction(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null;
  if (e?.code === "PGRST202" || e?.code === "42883") return true;
  return /could not find the function|does not exist/i.test(String(e?.message ?? ""));
}

/**
 * Fetch the current cursor for a vault.
 *
 * Fast path: one `pdm.vault_cursor(vault_id)` call. It is `security definer`,
 * so membership is checked once and the counts run without RLS — measured in
 * prod at 11 ms against 1,434 ms for the RLS'd versions count alone, which was
 * 32% of ALL database time. Falls back to the four-request legacy probe on a
 * database that does not have the function yet; any other error throws so the
 * caller runs a full reconcile instead of mistaking it for "nothing changed".
 */
export async function fetchVaultCursor(
  client: SupabaseLike,
  vaultId: VaultId,
): Promise<VaultCursor> {
  if (!rpcMissing && typeof client.rpc === "function") {
    // The vault client's default schema is `pdm` (packages/auth client.ts), so
    // the bare function name resolves to pdm.vault_cursor.
    const { data, error } = await client.rpc("vault_cursor", { p_vault_id: vaultId });
    if (error) {
      if (!isMissingFunction(error)) {
        const msg = (error as { message?: string })?.message;
        throw error instanceof Error ? error : new Error(msg ?? "vault_cursor failed");
      }
      rpcMissing = true;
    } else {
      // A `returns table` RPC comes back as an array of rows; tolerate a bare
      // object in case PostgREST is asked for a single object.
      const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
      if (!row) throw new Error("vault_cursor returned no row");
      return {
        liveFiles: Number(row.live_files ?? 0),
        versions: Number(row.versions ?? 0),
        liveFolders: Number(row.live_folders ?? 0),
        activeLocks: Number(row.active_locks ?? 0),
      };
    }
  }
  return fetchVaultCursorLegacy(client, vaultId);
}

/**
 * The pre-RPC probe: four head-only count queries (no row bodies). Kept as the
 * fallback for a database without 20260909100000, and still exercised by its
 * own tests — the FK-naming detail below is a shipped regression.
 */
export async function fetchVaultCursorLegacy(
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
    // The FK must be named explicitly: pdm.files and pdm.versions reference each
    // other BOTH ways (versions.file_id -> files.id, and files.latest_version_id
    // -> versions.id via files_latest_version_fk), so a bare `files!inner` is
    // ambiguous and PostgREST rejects the request with 300 / PGRST201 before it
    // ever reaches RLS. `locks` below needs no hint because it has exactly one FK
    // to files. See the regression test: this failing made countOf throw, which
    // rejected the whole Promise.all, which made useVaultCursor treat EVERY poll
    // as an error and run a full catalog reconcile on a 15s timer.
    countOf(
      client
        .from("versions")
        .select("id, files!versions_file_id_fkey!inner(vault_id)", head)
        .eq("files.vault_id", vaultId),
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
