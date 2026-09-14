import type { TaskHistoryRow } from "@pm/lib/productivityMetrics";

// ---------------------------------------------------------------------------
// CSV rendering of the raw task-history rows — the "export the numbers and go
// analyse them in a spreadsheet" path. Pure: no file system, no dialogs. The
// view owns the Tauri save plumbing (same split as deadlineReport.ts).
// ---------------------------------------------------------------------------

const BASE_COLUMNS = [
  "event_time",
  "action",
  "task_id",
  "task_title",
  "subteam",
  "status_from",
  "status_to",
] as const;

const TAIL_COLUMNS = [
  "task_created_at",
  "task_due_date",
  "task_status_now",
  "estimate_days",
  "actual_days",
] as const;

/**
 * RFC 4180 field escaping: quote whenever the value contains a comma, a quote,
 * a newline or leading/trailing whitespace, and double any embedded quote.
 * null/undefined render as an empty field.
 */
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s === "") return "";
  const needsQuotes = /[",\r\n]/.test(s) || s !== s.trim();
  if (!needsQuotes) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

export function csvRow(fields: ReadonlyArray<string | number | null | undefined>): string {
  return fields.map(csvField).join(",");
}

/**
 * Render history rows as CSV.
 *
 * The `actor` column is OMITTED entirely — not blanked — when the server
 * returned no actors, so an export taken by someone without
 * pm.manage_dashboard has no person-shaped hole inviting a guess. Pass
 * `includeActor` to force the decision; by default it is inferred from the
 * data, which is the same signal buildProductivity uses.
 *
 * Rows are emitted CRLF-terminated (Excel's dialect) with a trailing newline.
 */
export function taskHistoryToCsv(
  rows: ReadonlyArray<TaskHistoryRow>,
  opts: { includeActor?: boolean } = {},
): string {
  const includeActor = opts.includeActor ?? rows.some((r) => r.actor_id !== null);
  const header = [...BASE_COLUMNS, ...(includeActor ? (["actor"] as const) : []), ...TAIL_COLUMNS];

  const lines = [csvRow(header)];
  for (const r of rows) {
    lines.push(
      csvRow([
        r.event_time,
        r.action,
        r.task_id,
        r.task_title,
        r.subteam_name,
        r.status_from,
        r.status_to,
        ...(includeActor ? [r.actor_name ?? r.actor_id] : []),
        r.task_created_at,
        r.due_date,
        r.task_status_now,
        r.estimate_days,
        r.actual_days,
      ]),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** Suggested file name, e.g. "task-history-aero-2026-06-01_2026-09-14.csv". */
export function taskHistoryFileName(
  scopeLabel: string | null,
  fromDay: string,
  toDay: string,
): string {
  const slug = (scopeLabel ?? "all-teams")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `task-history-${slug || "all-teams"}-${fromDay}_${toDay}.csv`;
}
