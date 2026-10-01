import type { SupabaseClient } from "@helios/auth";
import { invoke } from "@tauri-apps/api/core";
import type { Account, BalanceEntry, Reimbursement, Statement, Txn, TxnAllocation } from "./ledger";
import type { Evidence } from "./discrepancies";
import { allRows, type Item } from "../lib/api";
import type { NewTxn, Plan, VendorRule } from "./importers";

// Data layer for the finance side (infra/pdm-supabase/supabase/migrations/
// 20261001010000_finance_schema.sql). RLS returns the ledger only to execs; a
// member only ever gets their own reimbursement requests and receipts.

export interface Category { name: string; direction: "in" | "out" | "transfer"; description: string }
export interface EvidenceRow {
  id: number; kind: "invoice" | "email" | "airtable" | "slack"; source_file: string; vendor: string | null;
  vendor_raw: string | null; order_ref: string | null; date: string | null; total_cents: number | null; items: string;
  project_id: string | null; subteam_id: string | null; status: string; ship_to: string; payment_hint: string; link: string;
  record_type: string; flags: string[]; txn_id: number | null; match_method: string; object_path?: string | null;
  source_key?: string | null; match_score?: number;
}
export interface Receipt {
  id: number; reimbursement_id: number; object_path: string; file_name: string; content_type: string;
  size_bytes: number | null; uploaded_at: string;
}
export type ReimbursementWithReceipts = Reimbursement & { reimbursement_receipts: Receipt[] };
export interface Resolution { key: string; resolved_by_name: string; resolved_at: string; note: string }
export interface FinanceEvent {
  id: number; at: string; actor_id: string | null; entity: string; entity_id: string; field: string;
  old_value: string | null; new_value: string | null;
}

function unwrap<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}
const F = (c: SupabaseClient) => c.schema("finance");

export const fetchAccounts = async (c: SupabaseClient): Promise<Account[]> =>
  unwrap(await F(c).from("accounts").select("*").order("id"));
const DIRECTION_ORDER = { out: 0, in: 1, transfer: 2 } as const;
/** Spending categories first, then money in, then transfers ("Needs category" last of all). */
export const fetchCategories = async (c: SupabaseClient): Promise<Category[]> =>
  (unwrap(await F(c).from("categories").select("*").order("name")) as Category[]).sort((a, b) =>
    Number(a.name === "Needs category") - Number(b.name === "Needs category") || DIRECTION_ORDER[a.direction] - DIRECTION_ORDER[b.direction]);
export const fetchStatements = async (c: SupabaseClient): Promise<Statement[]> =>
  unwrap(await F(c).from("statements").select("*").order("closing_date"));
export const fetchTransactions = async (c: SupabaseClient): Promise<Txn[]> =>
  allRows<Txn>(() => F(c).from("transactions").select("*, txn_allocations(id, project_id, subteam_id, amount_cents)").order("date").order("id"));
export const fetchBalances = async (c: SupabaseClient): Promise<BalanceEntry[]> =>
  allRows<BalanceEntry>(() => F(c).from("balance_entries").select("*").order("as_of").order("id"));
export const fetchEvidence = async (c: SupabaseClient): Promise<EvidenceRow[]> =>
  allRows<EvidenceRow>(() => F(c).from("evidence").select("*").order("id"));
export const fetchResolutions = async (c: SupabaseClient): Promise<Resolution[]> =>
  allRows<Resolution>(() => F(c).from("discrepancy_resolutions").select("*").order("key"));
export const fetchReimbursements = async (c: SupabaseClient): Promise<ReimbursementWithReceipts[]> =>
  allRows<ReimbursementWithReceipts>(() => F(c).from("reimbursements").select("*, reimbursement_receipts(*)").order("id"));
export const fetchEvents = async (c: SupabaseClient, entity: string, entityId: string): Promise<FinanceEvent[]> =>
  unwrap(await F(c).from("events").select("*").eq("entity", entity).eq("entity_id", entityId).order("id", { ascending: false }).limit(100));

// ---- ledger writes (execs; RLS enforces)

export type TxnFields = Partial<Pick<Txn, "account_id" | "date" | "post_date" | "cleared_date" | "amount_cents" | "description"
  | "vendor" | "kind" | "category" | "reference" | "status" | "needs_review" | "review_note" | "notes">>;

export async function insertTxn(c: SupabaseClient, fields: TxnFields): Promise<number> {
  const row = unwrap(await F(c).from("transactions").insert({ source: "manual", ...fields }).select("id").single()) as { id: number };
  return row.id;
}
export async function updateTxn(c: SupabaseClient, id: number, fields: TxnFields): Promise<void> {
  unwrap(await F(c).from("transactions").update(fields).eq("id", id));
}
export async function deleteTxn(c: SupabaseClient, id: number): Promise<void> {
  const rows = unwrap(await F(c).from("transactions").delete().eq("id", id).select("id")) as unknown[];
  if (!rows.length) throw new Error("Only hand-entered transactions can be deleted. Statement lines can be edited or marked for review.");
}
export async function setAllocations(c: SupabaseClient, txnId: number, allocs: TxnAllocation[], basis = "manual"): Promise<void> {
  unwrap(await F(c).rpc("set_allocations", {
    p_txn: txnId, p_basis: basis,
    p_allocations: allocs.map((a) => ({ project_id: a.project_id, subteam_id: a.subteam_id, amount_cents: a.amount_cents })),
  }));
}
export async function addBalance(c: SupabaseClient, e: { account_id: number; as_of: string; balance_cents: number; measure: BalanceEntry["measure"]; note: string; entered_by_name: string }): Promise<void> {
  unwrap(await F(c).from("balance_entries").insert(e));
}
export async function saveAccount(c: SupabaseClient, a: Partial<Account> & { id?: number }): Promise<void> {
  const { id, ...fields } = a;
  if (id) unwrap(await F(c).from("accounts").update(fields).eq("id", id));
  else unwrap(await F(c).from("accounts").insert(fields));
}
export async function resolveDiscrepancy(c: SupabaseClient, key: string, note: string, name: string): Promise<void> {
  unwrap(await F(c).from("discrepancy_resolutions").upsert({ key, note, resolved_by_name: name, resolved_at: new Date().toISOString() }));
}
export async function reopenDiscrepancy(c: SupabaseClient, key: string): Promise<void> {
  unwrap(await F(c).from("discrepancy_resolutions").delete().eq("key", key));
}
/** Attach an invoice/email to a statement line (null detaches; the matcher won't re-attach it). */
export async function linkEvidence(c: SupabaseClient, evidenceId: number, txnId: number | null): Promise<void> {
  unwrap(await F(c).from("evidence").update({ txn_id: txnId, match_method: txnId ? "manual" : "rejected", match_score: txnId ? 1 : 0 }).eq("id", evidenceId));
}
export async function linkItem(c: SupabaseClient, itemId: string, txnId: number | null): Promise<void> {
  unwrap(await F(c).rpc("link_item", { p_item: itemId, p_txn: txnId }));
}

// ---- reimbursements

export async function requestReimbursement(c: SupabaseClient, r: {
  amount_cents: number; reason: string; date: string | null; project_id: string | null; subteam_id: string | null; item_id: string | null;
}): Promise<number> {
  return unwrap(await F(c).rpc("request_reimbursement", {
    p_amount_cents: r.amount_cents, p_reason: r.reason, p_date: r.date, p_project: r.project_id, p_subteam: r.subteam_id, p_item: r.item_id,
  })) as number;
}
export async function withdrawReimbursement(c: SupabaseClient, r: ReimbursementWithReceipts): Promise<void> {
  if (r.reimbursement_receipts.length) {
    await c.storage.from("receipts").remove(r.reimbursement_receipts.map((x) => x.object_path));
  }
  unwrap(await F(c).rpc("withdraw_reimbursement", { p_id: r.id }));
}
export async function decideReimbursement(c: SupabaseClient, id: number, decision: "approve" | "deny", note = ""): Promise<void> {
  unwrap(await F(c).rpc("decide_reimbursement", { p_id: id, p_decision: decision, p_note: note }));
}
export async function payReimbursements(c: SupabaseClient, ids: number[], paidDate: string | null, checkNumber: string, addCheck: boolean): Promise<number | null> {
  return unwrap(await F(c).rpc("pay_reimbursements", { p_ids: ids, p_paid_date: paidDate, p_check_number: checkNumber, p_add_check: addCheck })) as number | null;
}
export async function addReimbursement(c: SupabaseClient, r: Partial<Reimbursement>): Promise<number> {
  return (unwrap(await F(c).from("reimbursements").insert({ status: "owed", ...r }).select("id").single()) as { id: number }).id;
}
export async function updateReimbursement(c: SupabaseClient, id: number, fields: Partial<Reimbursement>): Promise<void> {
  unwrap(await F(c).from("reimbursements").update(fields).eq("id", id));
}

export const RECEIPT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"];
export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;

/** Upload receipt files for a reimbursement (the owner while it's being reviewed, or an exec). */
export async function uploadReceipts(c: SupabaseClient, reimbursementId: number, files: File[]): Promise<void> {
  for (const f of files) {
    if (!RECEIPT_TYPES.includes(f.type)) throw new Error(`${f.name}: receipts must be a photo or a PDF`);
    if (f.size > RECEIPT_MAX_BYTES) throw new Error(`${f.name} is over 10 MB`);
    const safe = f.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80) || "receipt";
    const path = `${reimbursementId}/${crypto.randomUUID().slice(0, 8)}-${safe}`;
    const up = await c.storage.from("receipts").upload(path, f, { contentType: f.type, upsert: false });
    if (up.error) throw new Error(`${f.name}: ${up.error.message}`);
    unwrap(await F(c).from("reimbursement_receipts").insert({
      reimbursement_id: reimbursementId, object_path: path, file_name: f.name, content_type: f.type, size_bytes: f.size,
    }));
  }
}
/**
 * Upload receipts for a reimbursement that was just created, or undo it. If
 * an upload fails, the half-made request is removed (its files first, while
 * the owner may still delete them) so a retry doesn't create a second one.
 */
export async function attachReceiptsOrUndo(c: SupabaseClient, reimbursementId: number, files: File[], asExec: boolean): Promise<void> {
  try {
    await uploadReceipts(c, reimbursementId, files);
  } catch (e) {
    const { data } = await F(c).from("reimbursement_receipts").select("object_path").eq("reimbursement_id", reimbursementId);
    const paths = ((data ?? []) as { object_path: string }[]).map((r) => r.object_path);
    if (paths.length) await c.storage.from("receipts").remove(paths);
    if (asExec) await F(c).from("reimbursements").delete().eq("id", reimbursementId);
    else await F(c).rpc("withdraw_reimbursement", { p_id: reimbursementId });
    throw new Error(`${e instanceof Error ? e.message : String(e)}. Nothing was sent; try again.`);
  }
}
export async function deleteReceipt(c: SupabaseClient, r: Receipt): Promise<void> {
  await c.storage.from("receipts").remove([r.object_path]);
  unwrap(await F(c).from("reimbursement_receipts").delete().eq("id", r.id));
}
/** A link to a receipt that works for a few minutes (the bucket is private). */
export async function receiptUrl(c: SupabaseClient, r: Receipt): Promise<string> {
  const { data, error } = await c.storage.from("receipts").createSignedUrl(r.object_path, 300);
  if (error || !data) throw new Error(error?.message ?? "couldn't open the receipt");
  return data.signedUrl;
}

/** Open a link in the system browser (the desktop shell), or a new tab in a browser. */
export function openExternal(url: string): void {
  invoke("open_external_url", { url }).catch(() => { window.open(url, "_blank", "noopener"); });
}

// ---- evidence for the discrepancy checker

const ORDERED = new Set(["ORDERED", "BACKORDERED", "SHIPPED", "DELIVERED", "RECEIVED", "RECONCILED"]);
export const itemEvidenceId = (i: Item) => -Number(i.code.replace(/\D/g, "") || 0);

/** Invoices and emails, plus every ordered parts-list item as a "request". */
export function evidenceFor(rows: EvidenceRow[], items: Item[], where: (projectId: string | null, subteamId: string | null) => string): Evidence[] {
  const docs: Evidence[] = rows.map((e) => ({
    id: e.id, kind: e.kind, source_file: e.source_file, vendor: e.vendor, order_ref: e.order_ref, date: e.date,
    total_cents: e.total_cents, items: e.items, where: where(e.project_id, e.subteam_id), status: e.status,
    payment_hint: e.payment_hint, record_type: e.record_type, flags: Array.isArray(e.flags) ? e.flags : [],
    txn_id: e.txn_id, match_method: e.match_method, object_path: e.object_path ?? null,
  }));
  const reqs: Evidence[] = items.filter((i) => ORDERED.has(i.status)).map((i) => {
    const a = i.item_allocations.length === 1 ? i.item_allocations[0] : undefined;
    const cost = i.actual_total_cents ?? i.total_estimate_cents
      ?? (i.quantity !== null && i.unit_price_cents !== null ? Math.round(i.quantity * i.unit_price_cents) + (i.tax_shipping_cents ?? 0) : 0);
    return {
      id: itemEvidenceId(i), kind: "request", source_file: i.code, vendor: i.vendor, order_ref: i.vendor_order_id,
      date: i.ordered_at, total_cents: cost || null, items: `${i.title} ${i.part_number} ${i.notes}`.trim(),
      where: a ? where(a.project_id, a.subteam_id) : "", status: "ORDERED", payment_hint: i.payment_method,
      record_type: "request", flags: [], txn_id: i.finance_txn_id ?? null, match_method: i.match_method ?? "", item_id: i.id,
    };
  });
  return [...docs, ...reqs];
}

// ---- CSV

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]!);
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? "" : String(v);
    // a bank description like "=HYPERLINK(...)" must not run as a formula in Excel
    if (typeof v === "string" && /^[=+@\t\r]|^-[^0-9.]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((k) => cell(r[k])).join(","))].join("\n");
}

/** Save a CSV through the desktop save dialog, or download it in a browser. */
export async function saveCsv(filename: string, csv: string): Promise<boolean> {
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({ defaultPath: filename, filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (!path) return false;
    await writeTextFile(path, csv);
    return true;
  } catch {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
    return true;
  }
}

// ---- uploads (execs)

export interface ImportLog { id: number; sha256: string; file_name: string; format: string; account_id: number | null; rows_added: number; imported_at: string }
export const fetchImports = async (c: SupabaseClient): Promise<ImportLog[]> =>
  unwrap(await F(c).from("imports").select("*").order("id", { ascending: false }).limit(50));
export const fetchVendors = async (c: SupabaseClient): Promise<VendorRule[]> =>
  unwrap(await F(c).from("vendors").select("*").order("name"));

export async function importTransactions(c: SupabaseClient, args: {
  file: { sha256: string; file_name: string; format: string; account_id: number | null };
  statement: Plan["statement"]; rows: NewTxn[]; clears: { txn_id: number; cleared_date: string }[];
  confirms: { transfer_group: string; date: string }[]; balances: Plan["balances"];
}): Promise<{ added: number; cleared: number; confirmed: number; balances: number }> {
  return unwrap(await F(c).rpc("import_transactions", {
    p_file: args.file, p_statement: args.statement, p_rows: args.rows, p_clears: args.clears, p_confirms: args.confirms, p_balances: args.balances,
  }));
}

/** Invoices from a list: one evidence row each, linked to its charge when the match is clear. */
export async function insertInvoices(c: SupabaseClient, rows: Array<Partial<EvidenceRow> & { source_key: string }>): Promise<number> {
  const got = unwrap(await F(c).from("evidence").upsert(rows, { onConflict: "source_key", ignoreDuplicates: true }).select("id")) as unknown[];
  return got.length;
}

/** Attach an invoice or receipt file to a ledger line. */
export async function attachDocument(c: SupabaseClient, t: Txn, file: File): Promise<void> {
  if (!RECEIPT_TYPES.includes(file.type)) throw new Error(`${file.name}: attach a PDF or a photo`);
  const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80) || "invoice";
  const path = `${t.id}/${crypto.randomUUID().slice(0, 8)}-${safe}`;
  const up = await c.storage.from("finance-docs").upload(path, file, { contentType: file.type });
  if (up.error) throw new Error(up.error.message);
  unwrap(await F(c).from("evidence").insert({
    kind: "invoice", source_file: file.name, source_key: `file:${path}`, vendor: t.vendor, date: t.date,
    total_cents: Math.abs(t.amount_cents), txn_id: t.id, match_method: "manual", match_score: 1, object_path: path, record_type: "invoice",
  }));
}
export async function documentUrl(c: SupabaseClient, path: string): Promise<string> {
  const { data, error } = await c.storage.from("finance-docs").createSignedUrl(path, 300);
  if (error || !data) throw new Error(error?.message ?? "couldn't open the file");
  return data.signedUrl;
}

// ---- budget breakdown (anyone, in their scope)

export interface BudgetShare { bucket: "spent" | "committed" | "planned"; source: "part" | "ledger"; ref: string; on_date: string | null; label: string; cents: number; txn_id: number | null; item_id: string | null }
export const fetchBudgetDetail = async (c: SupabaseClient, projectId: string | null, subteamIds: string[]): Promise<BudgetShare[]> =>
  unwrap(await c.schema("purchasing").rpc("budget_detail", { p_project: projectId, p_subteams: subteamIds }));
