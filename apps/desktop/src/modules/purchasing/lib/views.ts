// Abacus views, as in Airtable: a saved way of looking at the parts list.
// Which parts show (statuses, priorities, "mine", "missing info"), how they
// are grouped and sorted, and which columns are hidden. Pure functions, no
// React; the views themselves are stored in purchasing.views.

import { STATUSES, STATUS_LABEL, itemCost, type Item, type Priority, type Status, type Subteam } from "./api";

export type GroupBy = "none" | "status" | "priority" | "vendor" | "subteam" | "requester" | "needed_by" | "funding_source";
export type SortBy = "sheet" | "needed_by" | "priority" | "total" | "newest" | "vendor" | "title";

export interface ViewConfig {
  /** Only these statuses (none = all). */
  statuses?: Status[];
  /** Only these priorities (none = all). */
  priorities?: Priority[];
  /** Only parts the viewer asked for. */
  mine?: boolean;
  /** Only parts missing a price, a vendor or a link. */
  missing?: boolean;
  groupBy?: GroupBy;
  sortBy?: SortBy;
  /** Column keys not shown (the item name always is). */
  hidden?: string[];
}

export interface SavedView { id: string; name: string; config: ViewConfig; shared: boolean; owner_id: string | null; owner_name: string }

export const GROUP_LABEL: Record<GroupBy, string> = {
  none: "No grouping", status: "Status", priority: "Priority", vendor: "Vendor", subteam: "Subteam",
  requester: "Asked by", needed_by: "Needed by", funding_source: "Funding",
};
export const SORT_LABEL: Record<SortBy, string> = {
  sheet: "Sheet order", needed_by: "Needed by (soonest)", priority: "Priority (high first)", total: "Total (biggest)",
  newest: "Newest first", vendor: "Vendor (A-Z)", title: "Item (A-Z)",
};

const ON_THE_WAY: Status[] = ["APPROVED", "ORDERED", "BACKORDERED", "SHIPPED", "DELIVERED"];

/** The views everyone has. Their ids start with "builtin:". */
export const BUILTIN_VIEWS: SavedView[] = ([
  ["all", "All parts", {}],
  ["status", "By status", { groupBy: "status" }],
  ["not-ready", "Not ready", { statuses: ["PLANNED"] }],
  ["ready", "Ready to order", { statuses: ["READY"], sortBy: "priority" }],
  ["moving", "On the way", { statuses: ON_THE_WAY, groupBy: "status" }],
  ["done", "Done", { statuses: ["RECEIVED", "RECONCILED", "HAVE"] }],
  ["mine", "My parts", { mine: true, groupBy: "status" }],
  ["missing", "Missing info", { missing: true, statuses: ["PLANNED", "READY"] }],
] as [string, string, ViewConfig][]).map(([id, name, config]) => ({ id: `builtin:${id}`, name, config, shared: true, owner_id: null, owner_name: "" }));

/** A part that can't be priced or bought as it is: no unit price (or total), no vendor, or no link. */
export function missingInfo(i: Item): string[] {
  const out: string[] = [];
  if (i.unit_price_cents === null && i.total_estimate_cents === null) out.push("price");
  if (!i.vendor) out.push("vendor");
  if (!i.product_url.trim()) out.push("link");
  return out;
}

export interface Group { key: string; label: string; items: Item[]; total_cents: number }

const PRIORITY_RANK: Record<Priority, number> = { HIGH: 0, Medium: 1, Low: 2 };

/** Needed-by buckets, soonest first. */
function neededBucket(d: string | null, today: string): [number, string] {
  if (!d) return [5, "No date"];
  if (d < today) return [0, "Overdue"];
  const days = (Date.parse(d) - Date.parse(today)) / 86_400_000;
  if (days <= 7) return [1, "This week"];
  if (days <= 30) return [2, "Within a month"];
  return [3, "Later"];
}

/** Which group a part falls in: [sort key, label]. */
function groupOf(i: Item, by: GroupBy, subteams: Subteam[], today: string): [string, string] {
  switch (by) {
    case "status": return [String(STATUSES.indexOf(i.status)).padStart(2, "0"), STATUS_LABEL[i.status]];
    case "priority": return [String(PRIORITY_RANK[i.priority] ?? 9), i.priority === "HIGH" ? "High" : i.priority];
    case "needed_by": { const [n, l] = neededBucket(i.needed_by, today); return [String(n), l]; }
    case "subteam": {
      const s = subteams.find((x) => x.id === i.item_allocations[0]?.subteam_id);
      return s ? [`${String(s.sort_order).padStart(4, "0")} ${s.name}`, s.name] : ["~", "No subteam"];
    }
    case "vendor": return i.vendor ? [i.vendor.toLowerCase(), i.vendor] : ["~", "No vendor"];
    case "requester": return i.requester_name ? [i.requester_name.toLowerCase(), i.requester_name] : ["~", "Nobody"];
    case "funding_source": return i.funding_source?.trim() ? [i.funding_source.trim().toLowerCase(), i.funding_source.trim()] : ["~", "Not set"];
    default: return ["", ""];
  }
}

function compare(by: SortBy): ((a: Item, b: Item) => number) | null {
  switch (by) {
    case "needed_by": return (a, b) => (a.needed_by ?? "9999") < (b.needed_by ?? "9999") ? -1 : (a.needed_by ?? "9999") > (b.needed_by ?? "9999") ? 1 : 0;
    case "priority": return (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    case "total": return (a, b) => itemCost(b) - itemCost(a);
    case "newest": return (a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0);
    case "vendor": return (a, b) => (a.vendor ?? "~").localeCompare(b.vendor ?? "~");
    case "title": return (a, b) => a.title.localeCompare(b.title);
    default: return null;
  }
}

/** Does a part show in this view? */
export function inView(i: Item, v: ViewConfig, userId: string | null): boolean {
  if (v.statuses?.length && !v.statuses.includes(i.status)) return false;
  if (v.priorities?.length && !v.priorities.includes(i.priority)) return false;
  if (v.mine && (!userId || i.requester_id !== userId)) return false;
  if (v.missing && !missingInfo(i).length) return false;
  return true;
}

/**
 * The parts a view shows, grouped and sorted. Without grouping there is one
 * group with an empty label. Collapsed groups keep their count and total but
 * no rows, so `rows` (what's on screen, in order) skips them.
 */
export function applyView(items: Item[], v: ViewConfig, ctx: { userId: string | null; subteams: Subteam[]; today: string; collapsed?: Set<string> }): { groups: Group[]; rows: Item[] } {
  const shown = items.filter((i) => inView(i, v, ctx.userId));
  const cmp = compare(v.sortBy ?? "sheet");
  const sorted = cmp ? [...shown].sort(cmp) : shown;   // a stable sort keeps sheet order within ties
  const by = v.groupBy ?? "none";
  const map = new Map<string, Group & { sortKey: string }>();
  for (const i of sorted) {
    const [sortKey, label] = by === "none" ? ["", ""] : groupOf(i, by, ctx.subteams, ctx.today);
    const key = `${by}:${label}`;
    const g = map.get(key) ?? { key, label, items: [], total_cents: 0, sortKey };
    g.items.push(i);
    g.total_cents += itemCost(i);
    map.set(key, g);
  }
  const groups: Group[] = [...map.values()].sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0))   // "~" (none) last
    .map((g) => ({ key: g.key, label: g.label, items: g.items, total_cents: g.total_cents }));
  const rows = groups.flatMap((g) => (ctx.collapsed?.has(g.key) ? [] : g.items));
  return { groups, rows };
}

/** One line saying what a view does, for its tooltip. */
export function describeView(v: ViewConfig): string {
  const bits: string[] = [];
  if (v.statuses?.length) bits.push(v.statuses.map((s) => STATUS_LABEL[s]).join(", "));
  if (v.priorities?.length) bits.push(`${v.priorities.join("/")} priority`);
  if (v.mine) bits.push("asked by you");
  if (v.missing) bits.push("missing a price, vendor or link");
  if (v.groupBy && v.groupBy !== "none") bits.push(`grouped by ${GROUP_LABEL[v.groupBy].toLowerCase()}`);
  if (v.sortBy && v.sortBy !== "sheet") bits.push(`sorted by ${SORT_LABEL[v.sortBy].toLowerCase()}`);
  if (v.hidden?.length) bits.push(`${v.hidden.length} column${v.hidden.length === 1 ? "" : "s"} hidden`);
  return bits.length ? bits.join("; ") : "Every part";
}
