// Pure shaping helpers for the Admin > Pulse dashboard. No React, no I/O, so
// every rule the charts rely on is unit-testable.
import type { OpsDay, OpsHourCell, OpsPerson } from "./types";

export type GrowthMetric = "users_total" | "files_total" | "versions_total" | "content_bytes";
export type RangeDays = 30 | 90 | 365;

export const GROWTH_METRICS: Array<{ key: GrowthMetric; label: string }> = [
  { key: "users_total", label: "Members" },
  { key: "files_total", label: "Files" },
  { key: "versions_total", label: "Versions" },
  { key: "content_bytes", label: "Content" },
];

/** Series point for the line/area/column charts: x label + numeric value. */
export interface Point {
  label: string; // short axis label (e.g. "Sep 14")
  iso: string; // full day for tooltips
  value: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-14" becomes "Sep 14". Day strings are UTC dates; parse without Date to
 *  dodge local-timezone day shifts. */
export function shortDay(iso: string): string {
  const [, m, d] = iso.split("-");
  const mi = Number(m) - 1;
  return `${MONTHS[mi] ?? m} ${Number(d)}`;
}

export function toPoints(days: OpsDay[], key: keyof OpsDay): Point[] {
  return days.map((d) => ({ label: shortDay(d.day), iso: d.day, value: Number(d[key] ?? 0) }));
}

/** Clip to the last `n` days (the RPC already bounds the range; this keeps
 *  the client toggle instant without a refetch). */
export function lastDays<T>(rows: T[], n: number): T[] {
  return n >= rows.length ? rows : rows.slice(rows.length - n);
}

/** Percent change from the first to the last point, or null when the start is
 *  zero or absent (a delta from nothing is meaningless, not infinite). */
export function deltaPct(points: Point[]): number | null {
  if (points.length < 2) return null;
  const a = points[0]!.value;
  const b = points[points.length - 1]!.value;
  if (a <= 0) return null;
  return ((b - a) / a) * 100;
}

/** Absolute change from the first to the last point. */
export function deltaAbs(points: Point[]): number {
  if (points.length < 2) return 0;
  return points[points.length - 1]!.value - points[0]!.value;
}

/** Mean of the values, 0 for an empty list. */
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Trailing 7-day mean per point (window shrinks at the start). Smooths the
 *  daily-active columns so weekday/weekend noise doesn't hide the trend. */
export function rolling7(points: Point[]): Point[] {
  return points.map((p, i) => {
    const from = Math.max(0, i - 6);
    const win = points.slice(from, i + 1).map((q) => q.value);
    return { ...p, value: mean(win) };
  });
}

/** Sum of the three per-module activity counts for a day. */
export function actionsOf(d: OpsDay): number {
  return d.vault_actions + d.pm_actions + d.games_plays;
}

/** Engineering work only (vault + PM). Games are kept apart because a single
 *  plinko grinder can log hundreds of bets a day and bury the real signal. */
export function workActionsOf(d: OpsDay): number {
  return d.vault_actions + d.pm_actions;
}

/** Sources counted as "work" for the heatmap and action totals. */
export const WORK_SOURCES: ReadonlySet<string> = new Set(["vault", "pm"]);

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  const digits = v >= 100 || u === 0 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${units[u]}`;
}

export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return Math.round(n).toLocaleString();
}

export function formatMetric(key: GrowthMetric, v: number): string {
  return key === "content_bytes" ? formatBytes(v) : formatCount(v);
}

/** "3m ago", "2h ago", "5d ago"; "never" for null. `now` injectable for tests. */
export function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "never";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d}d ago`;
  const mo = Math.round(d / 30);
  return `${mo}mo ago`;
}

/** Bucket a person's last activity for the presence pill. */
export type PresenceBucket = "online" | "today" | "week" | "month" | "idle" | "never";

export function presenceBucket(p: Pick<OpsPerson, "online" | "last_active">, now: number = Date.now()): PresenceBucket {
  if (p.online) return "online";
  if (!p.last_active) return "never";
  const age = now - Date.parse(p.last_active);
  if (age < 24 * 3600e3) return "today";
  if (age < 7 * 24 * 3600e3) return "week";
  if (age < 30 * 24 * 3600e3) return "month";
  return "idle";
}

/** 7x24 grid (row = Monday..Sunday, col = hour) filled from sparse cells.
 *  Hours are shifted from UTC into the viewer's zone so the picture matches
 *  the team's actual day; `tzOffsetMinutes` = Date.getTimezoneOffset(). */
export function toHeatGrid(
  cells: OpsHourCell[],
  tzOffsetMinutes: number = 0,
  include: (source: string) => boolean = () => true,
): number[][] {
  const grid: number[][] = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  const shiftH = Math.round(-tzOffsetMinutes / 60);
  for (const c of cells) {
    if (!include(c.source)) continue;
    let h = c.hour + shiftH;
    let d = c.dow;
    if (h < 0) {
      h += 24;
      d = (d + 6) % 7;
    } else if (h >= 24) {
      h -= 24;
      d = (d + 1) % 7;
    }
    if (d < 0 || d > 6 || h < 0 || h > 23) continue;
    grid[d]![h]! += c.n;
  }
  return grid;
}

export const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Sort people: online first, then most recently active; nulls last. */
export function sortPeople(people: OpsPerson[]): OpsPerson[] {
  return [...people].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    const ta = a.last_active ? Date.parse(a.last_active) : -Infinity;
    const tb = b.last_active ? Date.parse(b.last_active) : -Infinity;
    return tb - ta;
  });
}

export function personLabel(p: Pick<OpsPerson, "display_name" | "email">): string {
  const n = p.display_name?.trim();
  if (n) return n;
  const e = p.email?.trim();
  if (e) return e.split("@")[0]!;
  return "unknown";
}

/** Case-insensitive match on name / email / subteam / role. */
export function filterPeople(people: OpsPerson[], q: string): OpsPerson[] {
  const s = q.trim().toLowerCase();
  if (!s) return people;
  return people.filter((p) =>
    [p.display_name, p.email, p.subteam, p.role].some((f) => (f ?? "").toLowerCase().includes(s)),
  );
}

/** Nice axis ticks: 0, mid, max rounded to a clean step. */
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(max)));
  const f = max / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * exp;
}
