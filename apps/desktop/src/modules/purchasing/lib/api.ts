import type { SupabaseClient } from "@helios/auth";
import type { NewRow } from "./paste";

// Data layer for the Purchasing module. Reads come straight from the
// `purchasing` schema (RLS returns only what the caller may see); every write
// goes through a SECURITY DEFINER RPC that checks capabilities server-side
// (infra/pdm-supabase/supabase/migrations/20261001000000_purchasing_schema.sql).

export type Status =
  | "PLANNED" | "READY" | "APPROVED" | "ORDERED" | "BACKORDERED" | "SHIPPED"
  | "DELIVERED" | "RECEIVED" | "RECONCILED" | "DENIED" | "CANCELLED" | "HAVE";

export const STATUSES: Status[] = [
  "PLANNED", "READY", "APPROVED", "ORDERED", "BACKORDERED", "SHIPPED",
  "DELIVERED", "RECEIVED", "RECONCILED", "DENIED", "CANCELLED", "HAVE",
];

/** Bought (or further along): ordered, on its way, here, or matched to its charge. */
export const ORDERED_STATUSES: ReadonlySet<Status> = new Set(["ORDERED", "BACKORDERED", "SHIPPED", "DELIVERED", "RECEIVED", "RECONCILED"]);
/** Approved, or bought since: what may be ordered or recorded as ordered. */
export const APPROVED_OR_LATER: ReadonlySet<Status> = new Set<Status>(["APPROVED", ...ORDERED_STATUSES]);
/** Bought but not here yet. */
export const ON_THE_WAY: ReadonlySet<Status> = new Set(["ORDERED", "BACKORDERED", "SHIPPED", "DELIVERED"]);

export const STATUS_LABEL: Record<Status, string> = {
  PLANNED: "Not ready to order", READY: "Ready to order", APPROVED: "Approved", ORDERED: "Ordered",
  BACKORDERED: "Backordered", SHIPPED: "Shipped", DELIVERED: "Delivered", RECEIVED: "Received",
  RECONCILED: "Reconciled", DENIED: "Denied", CANCELLED: "Cancelled", HAVE: "Already have",
};

/** What a requester (any member) may do to their subteam's items; execs may do anything. */
export const REQUESTER_MOVES: Partial<Record<Status, Status[]>> = {
  PLANNED: ["READY", "CANCELLED"],
  READY: ["PLANNED", "CANCELLED"],
  ORDERED: ["RECEIVED"],
  SHIPPED: ["RECEIVED"],
  DELIVERED: ["RECEIVED"],
};

export type Priority = "HIGH" | "Medium" | "Low";

export interface Allocation { project_id: string; subteam_id: string; percent: number }

export interface Item {
  id: string;
  code: string;
  title: string;
  status: Status;
  priority: Priority;
  requester_id: string | null;
  requester_name: string;
  justification: string;
  needed_by: string | null;
  vendor: string | null;
  product_url: string;
  part_number: string;
  quantity: number | null;
  unit_price_cents: number | null;
  tax_shipping_cents: number | null;
  total_estimate_cents: number | null;
  notes: string;
  ready_at: string | null;
  vendor_order_id: string | null;
  actual_total_cents: number | null;
  payment_method: string;
  ordered_at: string | null;
  carrier: string;
  tracking_number: string;
  est_delivery: string | null;
  created_at: string;
  finance_txn_id?: number | null;   // the statement line that paid for it (finance)
  match_method?: string;
  item_allocations: Allocation[];
}

export interface Approval { item_id: string; user_id: string; decision: "approve" | "deny"; note: string; at: string }
export interface Subteam { id: string; name: string; code: string; color: string | null; sort_order: number }
export interface Project { id: string; name: string; car_code: string; status: string; program?: "ic" | "ev" | null }
export interface Notification { id: number; item_id: string | null; kind: string; message: string; created_at: string; read_at: string | null }
export interface BudgetRow {
  budget_line_id: string | null; project_id: string | null; project_code: string; name: string; subteam_ids: string[];
  budget_cents: number; spent_cents: number; committed_cents: number; planned_cents: number;
}

/** Best known cost: charged, else estimate, else qty x unit + tax/ship. */
export function itemCost(i: Item): number {
  if (i.actual_total_cents !== null) return i.actual_total_cents;
  if (i.total_estimate_cents !== null) return i.total_estimate_cents;
  if (i.quantity !== null && i.unit_price_cents !== null) return Math.round(i.quantity * i.unit_price_cents) + (i.tax_shipping_cents ?? 0);
  return 0;
}

function unwrap<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

const P = (c: SupabaseClient) => c.schema("purchasing");

/**
 * Every row of a query, page by page. PostgREST caps a response at max_rows
 * (1000) and drops the rest without an error, which would silently cut the
 * newest ledger lines. `query` must build a fresh, deterministically ordered
 * query each call. Steps by what came back, so a smaller server cap is fine.
 */
export async function allRows<T>(
  query: () => { range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }> },
  page = 1000,
): Promise<T[]> {
  const out: T[] = [];
  for (;;) {
    const rows = unwrap(await query().range(out.length, out.length + page - 1)) ?? [];
    if (rows.length === 0) return out;
    out.push(...rows);
  }
}

export async function fetchItems(c: SupabaseClient): Promise<Item[]> {
  return allRows<Item>(() => P(c).from("items").select("*, item_allocations(project_id, subteam_id, percent)").order("code"));
}
export async function fetchApprovals(c: SupabaseClient): Promise<Approval[]> {
  return allRows<Approval>(() => P(c).from("approvals").select("*").order("item_id").order("user_id"));
}
export async function fetchSubteams(c: SupabaseClient): Promise<Subteam[]> {
  return unwrap(await c.schema("pm").from("subteams").select("id,name,code,color,sort_order").order("sort_order").order("name"));
}
export async function fetchProjects(c: SupabaseClient): Promise<Project[]> {
  return unwrap(await c.schema("pm").from("projects").select("id,name,car_code,status,program").order("car_code"));
}
export async function fetchNotifications(c: SupabaseClient): Promise<Notification[]> {
  return unwrap(await P(c).from("notifications").select("*").order("id", { ascending: false }).limit(200));
}
export async function fetchBudgets(c: SupabaseClient): Promise<BudgetRow[]> {
  return unwrap(await P(c).rpc("budget_rows"));
}

/** The caller's capabilities: org-wide keys, and per-subteam keys. */
export interface Caps { org: Set<string>; bySubteam: Map<string, Set<string>> }
export async function fetchCaps(c: SupabaseClient): Promise<Caps> {
  const rows = unwrap(await c.schema("pm").rpc("my_capabilities")) as Array<{ capability_key: string; subteam_id: string | null }>;
  const caps: Caps = { org: new Set(), bySubteam: new Map() };
  for (const r of rows ?? []) {
    if (!r.subteam_id) caps.org.add(r.capability_key);
    else {
      if (!caps.bySubteam.has(r.subteam_id)) caps.bySubteam.set(r.subteam_id, new Set());
      caps.bySubteam.get(r.subteam_id)!.add(r.capability_key);
    }
  }
  return caps;
}
export const can = (caps: Caps | null, key: string, subteamId?: string) =>
  !!caps && (caps.org.has(key) || (!!subteamId && !!caps.bySubteam.get(subteamId)?.has(key)));

export async function addItems(c: SupabaseClient, projectId: string, subteamId: string, rows: NewRow[], ready: boolean): Promise<string[]> {
  return unwrap(await P(c).rpc("add_items", { p_project: projectId, p_subteam: subteamId, p_rows: rows, p_ready: ready }));
}
export async function updateItem(c: SupabaseClient, id: string, patch: Record<string, unknown>): Promise<Item> {
  return unwrap(await P(c).rpc("update_item", { p_id: id, p_patch: patch }));
}
export async function setStatus(c: SupabaseClient, ids: string[], status: Status, note = ""): Promise<void> {
  unwrap(await P(c).rpc("set_status", { p_ids: ids, p_status: status, p_note: note }));
}
export async function decide(c: SupabaseClient, id: string, decision: "approve" | "deny", note = ""): Promise<string> {
  return unwrap(await P(c).rpc("decide", { p_id: id, p_decision: decision, p_note: note }));
}
export async function recordOrder(c: SupabaseClient, ids: string[], orderId: string, payment: string, orderedOn: string | null, totalCents: number | null, paidBy: string): Promise<void> {
  unwrap(await P(c).rpc("record_order", {
    p_ids: ids, p_order_id: orderId, p_payment: payment, p_ordered_on: orderedOn, p_total_cents: totalCents, p_paid_by: paidBy,
  }));
}
/** Each part's share of a vendor order: [{id, actual_total_cents, tax_shipping_cents}]. */
export async function recordOrderLines(c: SupabaseClient, lines: { id: string; actual_total_cents: number; tax_shipping_cents: number }[],
  orderId: string, payment: string, orderedOn: string | null, totalCents: number | null, paidBy: string): Promise<void> {
  unwrap(await P(c).rpc("record_order_lines", {
    p_lines: lines, p_order_id: orderId, p_payment: payment, p_ordered_on: orderedOn, p_total_cents: totalCents, p_paid_by: paidBy,
  }));
}
/** Execs: bring in rows with their Airtable status (Ordered, Received...). Returns how many were added. */
export async function importItems(c: SupabaseClient, projectId: string, subteamId: string, rows: NewRow[]): Promise<number> {
  return unwrap(await P(c).rpc("import_items", { p_project: projectId, p_subteam: subteamId, p_rows: rows }));
}
/** Execs: undo an order recorded by mistake (back to Approved). */
export async function undoOrder(c: SupabaseClient, ids: string[]): Promise<void> {
  unwrap(await P(c).rpc("undo_order", { p_ids: ids }));
}
export async function addTracking(c: SupabaseClient, ids: string[], trackingNumber: string, carrier: string, eta: string | null): Promise<void> {
  unwrap(await P(c).rpc("add_tracking", { p_ids: ids, p_number: trackingNumber, p_carrier: carrier, p_eta: eta }));
}
export async function markNotificationsRead(c: SupabaseClient): Promise<void> {
  unwrap(await P(c).rpc("mark_notifications_read"));
}

/** Carrier from a tracking number's shape. */
export function detectCarrier(n: string): string {
  const s = n.replace(/[\s-]/g, "").toUpperCase();
  if (/^1Z[0-9A-Z]{16}$/.test(s)) return "UPS";
  if (/^(9[0-9]{15,21}|[A-Z]{2}[0-9]{9}US)$/.test(s)) return "USPS";
  if (/^([0-9]{12}|[0-9]{15}|[0-9]{20}|[0-9]{22})$/.test(s)) return "FedEx";
  if (/^TBA[0-9]{9,12}$/.test(s)) return "Amazon";
  if (/^[0-9]{10}$/.test(s)) return "DHL";
  return "";
}
export function trackingUrl(carrier: string, n: string): string {
  const s = n.replace(/[\s-]/g, "").toUpperCase();
  const c = carrier || detectCarrier(s);
  const urls: Record<string, string> = {
    UPS: `https://www.ups.com/track?tracknum=${s}`,
    USPS: `https://tools.usps.com/go/TrackConfirmAction?tLabels=${s}`,
    FedEx: `https://www.fedex.com/fedextrack/?trknbr=${s}`,
    DHL: `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${s}`,
    Amazon: `https://track.amazon.com/tracking/${s}`,
  };
  return s && urls[c] ? urls[c] : "";
}

// ---- which subteams each car has: Helios's org structure (Admin > Org Structure)

export interface CarSubteam { project_id: string; subteam_id: string }
export async function fetchCarSubteams(c: SupabaseClient): Promise<CarSubteam[]> {
  return unwrap(await c.schema("pm").from("project_subteams").select("project_id,subteam_id"));
}
/** Put a subteam on a car or take it off, in the org structure (needs org.manage_structure, like Admin). */
export async function setCarSubteam(c: SupabaseClient, projectId: string, subteamId: string, on: boolean): Promise<void> {
  unwrap(await c.schema("pm").rpc("set_project_subteam", { p_project_id: projectId, p_subteam_id: subteamId, p_present: on }));
}
/** Execs: delete parts (not ones matched to a ledger charge). Returns how many went. */
export async function deleteItems(c: SupabaseClient, ids: string[]): Promise<number> {
  let n = 0;
  for (let k = 0; k < ids.length; k += 200) n += unwrap(await P(c).rpc("delete_items", { p_ids: ids.slice(k, k + 200) })) as number;
  return n;
}
/**
 * A car's own subteams, in the usual order: the ones the org structure puts on
 * it, plus any that already have parts on it (so nothing is hidden). A car the
 * org structure says nothing about shows every subteam.
 */
export function subteamsOfCar(subteams: Subteam[], carSubteams: CarSubteam[], items: Item[], projectId: string | null): Subteam[] {
  if (!projectId) return subteams;
  const on = new Set(carSubteams.filter((x) => x.project_id === projectId).map((x) => x.subteam_id));
  // as add_items(): a car nobody has set up takes any subteam; once it is set
  // up, its subteams plus any that already have parts on it
  if (!on.size) return subteams;
  for (const i of items) for (const a of i.item_allocations) if (a.project_id === projectId) on.add(a.subteam_id);
  return subteams.filter((s) => on.has(s.id));
}

// ---- seasons and budget lines (execs)

export interface Season { id: string; name: string; starts_on: string | null; ends_on: string | null; is_current: boolean }
export interface BudgetLine { id: string; season_id: string; project_id: string; name: string; amount_cents: number; notes: string; budget_line_subteams: { subteam_id: string }[] }

export async function fetchSeasons(c: SupabaseClient): Promise<Season[]> {
  return unwrap(await P(c).from("seasons").select("id,name,starts_on,ends_on,is_current").order("name", { ascending: false }));
}
export async function fetchBudgetLines(c: SupabaseClient, seasonId: string): Promise<BudgetLine[]> {
  return unwrap(await P(c).from("budget_lines").select("id,season_id,project_id,name,amount_cents,notes,budget_line_subteams(subteam_id)")
    .eq("season_id", seasonId).order("name"));
}
export async function upsertSeason(c: SupabaseClient, s: { id: string | null; name: string; starts_on: string | null; ends_on: string | null; is_current: boolean }): Promise<string> {
  return unwrap(await P(c).rpc("upsert_season", { p_id: s.id, p_name: s.name, p_starts_on: s.starts_on, p_ends_on: s.ends_on, p_current: s.is_current }));
}
export async function upsertBudgetLine(c: SupabaseClient, l: { id: string | null; season_id: string; project_id: string; name: string; amount_cents: number; subteam_ids: string[] }): Promise<string> {
  return unwrap(await P(c).rpc("upsert_budget_line", {
    p_id: l.id, p_season: l.season_id, p_project: l.project_id, p_name: l.name, p_amount_cents: l.amount_cents, p_subteams: l.subteam_ids,
  }));
}
export async function deleteBudgetLine(c: SupabaseClient, id: string): Promise<void> {
  unwrap(await P(c).rpc("delete_budget_line", { p_id: id }));
}
/** A purchasing setting ("estimated_tax_percent"...), or null. */
export async function fetchSetting(c: SupabaseClient, key: string): Promise<string | null> {
  const r = await P(c).from("settings").select("value").eq("key", key).maybeSingle();
  return r.error ? null : ((r.data as { value: string } | null)?.value ?? null);
}
