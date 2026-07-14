/**
 * Maps Postgres / PostgREST / Supabase error codes to user-readable messages.
 *
 * Direct-INSERT/UPDATE hooks (useCreateFolder, useAcquireLock, etc.) surface
 * raw PostgreSQL error strings to the UI today, which leak SQLSTATE codes
 * and table names. This helper normalizes the common cases to actionable
 * messages without losing the original error for diagnostics.
 *
 * Coverage policy: only map codes the Vault module actually triggers.
 * Unmapped codes pass through the raw message — better to surface an
 * unfamiliar error than a generic "An error occurred."
 */

/** Shape of error objects returned by supabase-js v2. The wire format
 *  carries SQL code in `code`, occasional HTTP status in `status`, the
 *  human message in `message`, and Postgres `details` / `hint` fields. */
export interface PgErrorShape {
  code?: string;
  status?: number;
  message?: string;
  details?: string | null;
  hint?: string | null;
}

/** What was the user trying to do? Lets the mapper pick a context-specific
 *  phrasing for the same SQL code (e.g. 23505 on a folder vs. a lock). */
export type PgErrorContext =
  | "lock"
  | "folder"
  | "file"
  | "vault"
  | "version"
  | "role"
  | "generic";

interface FriendlyError {
  /** One-line message suitable for display in a UI toast or inline error. */
  message: string;
  /** Lowercase tag the UI can branch on without re-parsing the SQL code. */
  kind: "permission" | "duplicate" | "not-found" | "missing-field" | "constraint" | "auth" | "unknown";
}

/**
 * Convert a Supabase / Postgres error into a friendly message. Returns the
 * raw message verbatim when no mapping applies, so unfamiliar errors aren't
 * masked behind a vague catch-all.
 */
export function friendlyPgError(
  err: PgErrorShape | Error | null | undefined,
  context: PgErrorContext = "generic",
): FriendlyError {
  if (!err) return { message: "Unknown error", kind: "unknown" };

  // A bare native Error (no SQL `code` and no HTTP `status`) can't be mapped,
  // so surface its message. But Supabase's AuthApiError is a real Error
  // subclass that carries a `status` (e.g. 401/403) without a `code` — those
  // must fall through to the status-based mapping below, not early-return.
  if (err instanceof Error && !("code" in err) && !("status" in err)) {
    return { message: err.message || "Unknown error", kind: "unknown" };
  }

  const e = err as PgErrorShape;
  const code = e.code ?? "";
  const raw = e.message ?? "";

  // 42501 — insufficient privilege (grant denied / RLS denied).
  if (code === "42501") {
    const noun = nounFor(context, "this action");
    return {
      message: `Permission denied — you don't have the required role to ${verbFor(context)} ${noun}.`,
      kind: "permission",
    };
  }

  // 23505 — unique_violation. Per-context phrasing.
  if (code === "23505") {
    switch (context) {
      case "folder":
        return { message: "A folder with this name already exists here.", kind: "duplicate" };
      case "file":
        return { message: "A file with this name already exists in this folder.", kind: "duplicate" };
      case "vault":
        return { message: "A vault with this name already exists.", kind: "duplicate" };
      case "lock":
        return { message: "This file is already checked out.", kind: "duplicate" };
      case "version":
        return { message: "A revision with that number already exists — refresh and try again.", kind: "duplicate" };
      default:
        return { message: "This item already exists.", kind: "duplicate" };
    }
  }

  // 23503 — foreign_key_violation. Typically means a referenced parent was
  // deleted between read and write.
  if (code === "23503") {
    return {
      message: "Referenced item not found — it may have been deleted by another user. Refresh and try again.",
      kind: "not-found",
    };
  }

  // 23502 — not_null_violation. Programmer error in most cases.
  if (code === "23502") {
    return { message: "A required field is missing.", kind: "missing-field" };
  }

  // 23514 — check_violation. Custom constraints (role enum, etc.).
  if (code === "23514") {
    return { message: "Value doesn't meet a database constraint.", kind: "constraint" };
  }

  // PGRST116 — 0 rows on .single() / .maybeSingle() when one was expected.
  if (code === "PGRST116") {
    return { message: "Item not found.", kind: "not-found" };
  }

  // PostgREST + Supabase auth: JWT errors. AuthApiError surfaces a 401 on an
  // expired/invalid session and a 403 when authenticated but unauthorized;
  // both point the user at re-authenticating.
  if (code === "PGRST301" || e.status === 401 || e.status === 403) {
    return { message: "Your session has expired — please sign in again.", kind: "auth" };
  }

  // P0001 — RAISE EXCEPTION from a SECURITY DEFINER RPC. The message body
  // is hand-authored by the migration; pass it through (truncate the
  // Postgres "(context)" suffix if present).
  if (code === "P0001") {
    const trimmed = raw.replace(/\s+\(SQLSTATE.*?\)$/i, "").trim();
    return { message: trimmed || "Operation refused by the database.", kind: "permission" };
  }

  // Unmapped — return the original message verbatim so diagnostics aren't
  // hidden behind a generic catch-all.
  return { message: raw || "Unknown database error", kind: "unknown" };
}

/** Storage uploads fail through StorageApiError (HTTP, no SQL code), so the
 *  RLS denial arrives as raw policy text. It has exactly one user-actionable
 *  cause — the account holds no role with vault write permission — so name
 *  the remedy instead of quoting Postgres. Everything else passes through. */
export function friendlyUploadError(message: string): string {
  return /row-level security/i.test(message)
    ? "you don't have vault write permission — ask your team lead (or an admin) to grant you a role that can check in files."
    : message;
}

function verbFor(context: PgErrorContext): string {
  switch (context) {
    case "lock": return "lock";
    case "folder": return "create a folder in";
    case "file": return "add a file to";
    case "vault": return "create";
    case "version": return "check in";
    case "role": return "modify";
    default: return "perform";
  }
}

function nounFor(context: PgErrorContext, fallback: string): string {
  switch (context) {
    case "lock": return "this file";
    case "folder": return "this vault";
    case "file": return "this folder";
    case "vault": return "a vault";
    case "version": return "this file";
    case "role": return "user roles";
    default: return fallback;
  }
}
