import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import type { ZoomRange } from "@helios/lib";
import type { LoadedSession } from "./session";

/** Export a session's channels to a CSV file at user-chosen path. When
 *  `zoom` is non-null, only samples within the zoom range are included.
 *
 *  Output format is one row per unique timestamp across all rate groups,
 *  with empty cells where a sample doesn't exist for that channel/time. The
 *  first column is `time_s`. This mirrors the MoTeC CSV export shape so
 *  Helios-generated CSVs can round-trip through other tools. */
export async function exportSessionCsv(
  session: LoadedSession,
  zoom: ZoomRange | null,
): Promise<string | null> {
  const path = await save({
    defaultPath: `${slug(session.label)}.csv`,
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (!path) return null;

  const groups = session.store.groups();
  // Union of all timestamps from all groups, optionally filtered to zoom.
  const tsSet = new Set<number>();
  for (const g of groups) {
    for (let i = 0; i < g.time.length; i++) {
      const t = Number(g.time[i]!);
      if (zoom && (t < zoom.startUs || t > zoom.endUs)) continue;
      tsSet.add(t);
    }
  }
  const times = [...tsSet].sort((a, b) => a - b);

  const metas = session.store.list();
  const ids = metas.map((m) => m.id);
  // Per-id index into its rate group, advanced as we walk the union timeline.
  const cursors = new Map<string, number>();
  for (const id of ids) cursors.set(id, 0);

  const headerNames = ["time_s", ...ids];
  const headerUnits = ["s", ...metas.map((m) => m.units || "")];
  const lines: string[] = [];
  lines.push(headerNames.map(csvCell).join(","));
  lines.push(headerUnits.map(csvCell).join(","));

  for (const tUs of times) {
    const row: string[] = [(tUs / 1_000_000).toFixed(6)];
    for (const meta of metas) {
      const g = session.store.groupOf(meta.id);
      if (!g) { row.push(""); continue; }
      const col = g.columns.get(meta.id);
      if (!col) { row.push(""); continue; }
      // Find the largest index in g.time with time <= tUs. Cursor never
      // rewinds since `times` is sorted.
      let i = cursors.get(meta.id) ?? 0;
      while (i < g.time.length && Number(g.time[i]!) <= tUs) i++;
      const idx = i - 1;
      cursors.set(meta.id, i);
      if (idx < 0) { row.push(""); continue; }
      // Only emit a value when this group has a sample exactly at this time —
      // otherwise we'd duplicate the previous value into every base-rate row,
      // bloating the file and lying about sample density.
      if (Number(g.time[idx]!) !== tUs) { row.push(""); continue; }
      const v = col[idx]!;
      row.push(Number.isFinite(v) ? formatValue(v, meta.decimals) : "");
    }
    lines.push(row.join(","));
  }

  await writeTextFile(path, lines.join("\n"));
  return path;
}

function csvCell(s: string): string {
  // Spreadsheet formula-injection guard: prefix cells that begin with a
  // formula-trigger character so a crafted channel id/unit can't be
  // executed as a formula when the CSV is opened in Excel/Sheets.
  const injectionPrefix = /^[=+\-@\t\r]/.test(s) ? "'" : "";
  if (/[",\n]/.test(s)) return `"${injectionPrefix}${s.replace(/"/g, '""')}"`;
  return injectionPrefix + s;
}

function formatValue(v: number, dp: number): string {
  return v.toFixed(Math.max(0, Math.min(8, dp)));
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
