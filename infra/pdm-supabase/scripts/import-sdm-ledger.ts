/**
 * Import the standalone SDM ledger (sdm-purchasing-tool) into a LOCAL
 * Supabase stack: accounts, statements, transactions and splits, invoices and
 * order emails, weekly balances, reimbursements, budgets, discrepancy
 * resolutions, and the parts list.
 *
 *   # in sdm-purchasing-tool:  python -m sdm.export_helios <path outside the repo>/helios-export.json
 *   pnpm exec tsx scripts/import-sdm-ledger.ts <that file>
 *
 * Replaces all purchasing and finance data (demo users and their roles are
 * kept, so you can still sign in). Keeps the old ledger's ids so discrepancy
 * keys, and the resolutions made in the old ledger, still line up.
 *
 * The export holds real financial data: never commit it. This script refuses
 * to run against anything but localhost; importing into the team's hosted
 * project is a separate, deliberate step.
 */
import { config } from "dotenv";
import WebSocket from "ws";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// Node < 22 has no native WebSocket, which supabase-js needs at createClient() (as in tests/setup.ts).
(globalThis as any).WebSocket ??= WebSocket;
config();
const url = process.env.SUPABASE_URL ?? "";
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url)) throw new Error(`Refusing to import into non-local ${url}`);
const file = process.argv[2];
if (!file) throw new Error("Usage: tsx scripts/import-sdm-ledger.ts <helios-export.json>");

const svc = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const pm = svc.schema("pm");
const pur = svc.schema("purchasing");
const fin = svc.schema("finance");

type Row = Record<string, any>;
const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, Row[]> & { source: string };
if (data.source !== "sdm-ledger") throw new Error("That isn't an export from the SDM ledger.");

function must<T>(r: { data: T; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
}
async function insertAll(table: ReturnType<typeof svc.schema>, name: string, rows: Row[]) {
  for (let i = 0; i < rows.length; i += 200) must(await table.from(name).insert(rows.slice(i, i + 200)), `insert ${name}`);
}
async function wipe(table: ReturnType<typeof svc.schema>, name: string, col = "id") {
  must(await table.from(name).delete().not(col, "is", null), `clear ${name}`);
}
const day = (v: unknown) => (v ? String(v).slice(0, 10) : null);
const bool = (v: unknown) => v === 1 || v === true || v === "1";

// Subteam codes for names that aren't in Helios yet (matched by name first).
const CODES: Record<string, [string, string]> = {
  Aero: ["AER", "#3ecf8e"], Brakes: ["BRK", "#f25f5c"], Chassis: ["CHA", "#a78bfa"], "Data AQ": ["DAQ", "#4ea8ff"],
  "Driver Interface": ["DRI", "#f472b6"], Drivetrain: ["DRV", "#fb923c"], Engine: ["ENG", "#facc15"], Suspension: ["SUS", "#60a5fa"],
  "Low Voltage": ["LV", "#34d399"], "High Voltage": ["HV", "#f97316"], Battery: ["BAT", "#eab308"], Machining: ["MCH", "#94a3b8"],
  Manufacturing: ["MFG", "#9ca3af"], Marketing: ["MKT", "#e879f9"], Operations: ["OPS", "#c084fc"], "Overall Team": ["TEAM", "#d4d4d8"],
};

async function main() {
  // ---- cars and subteams
  const cars: Record<string, string | null> = { Team: null };
  for (const [prog, code, name] of [["IC", "SDM27", "SDM27 (IC)"], ["EV", "SDM27e", "SDM27e (EV)"]] as const) {
    const row = must(await pm.from("projects").upsert({ name, car_year: 2027, car_code: code }, { onConflict: "car_code" }).select("id").single(), "project") as Row;
    cars[prog] = row.id;
  }
  const existing = must(await pm.from("subteams").select("id,name,code"), "subteams") as Row[];
  const st = new Map<string, string>(existing.map((s) => [String(s.name).toLowerCase(), s.id]));
  const names = new Set<string>([
    ...data.subteams.map((s) => s.subteam), ...data.budgets.map((b) => b.subteam), ...data.allocations.map((a) => a.subteam),
    ...data.line_item_allocations.map((a) => a.subteam), ...data.evidence.filter((e) => e.subteam).map((e) => e.subteam),
  ]);
  let order = existing.length;
  for (const name of names) {
    if (st.has(name.toLowerCase())) continue;
    const [code, color] = CODES[name] ?? [name.replace(/[^A-Za-z]/g, "").slice(0, 4).toUpperCase(), "#8d8d97"];
    const row = must(await pm.from("subteams").insert({ name, code, slug: code.toLowerCase(), color, sort_order: order++ }).select("id").single(), `subteam ${name}`) as Row;
    st.set(name.toLowerCase(), row.id);
  }
  const sid = (name: string | null | undefined) => (name ? st.get(name.toLowerCase()) ?? null : null);
  const car = (program: string | null | undefined) => (program ? cars[program] ?? null : null);

  // ---- clear purchasing and finance
  await wipe(pur, "items");
  await wipe(pur, "budget_lines");
  await wipe(pur, "seasons");
  await wipe(pur, "notifications");
  await wipe(fin, "imports");
  for (const t of ["reimbursement_receipts", "reimbursements", "evidence", "balance_entries", "txn_allocations", "transactions", "statements"]) await wipe(fin, t);
  must(await fin.from("accounts").update({ paid_from_account_id: null }).not("id", "is", null), "unlink accounts");
  await wipe(fin, "accounts");
  await wipe(fin, "discrepancy_resolutions", "key");
  // receipt files belong to the reimbursements just cleared
  const { data: folders } = await svc.storage.from("receipts").list("", { limit: 1000 });
  for (const f of folders ?? []) {
    const { data: files } = await svc.storage.from("receipts").list(f.name, { limit: 1000 });
    if (files?.length) await svc.storage.from("receipts").remove(files.map((x) => `${f.name}/${x.name}`));
  }

  // ---- ledger
  for (const c of data.categories) must(await fin.from("categories").upsert({ name: c.name, direction: c.direction, description: c.description ?? "" }), "category");
  const cats = new Set(data.categories.map((c) => c.name));
  for (const v of data.vendors ?? []) {
    must(await fin.from("vendors").upsert({
      name: v.name, aliases: String(v.aliases ?? "").split("|").map((a: string) => a.trim()).filter(Boolean),
      merchant_pattern: v.merchant_pattern ?? "", default_category: cats.has(v.default_category) ? v.default_category : "Needs category",
      review_note: v.review_note ?? "",
    }), `vendor ${v.name}`);
  }
  await insertAll(fin, "accounts", data.accounts.map((a) => ({
    id: a.id, name: a.name, kind: a.kind, last4: a.last4, holder: a.holder, credit_limit_cents: a.credit_limit_cents,
    project_id: car(a.program_scope), active: bool(a.active), notes: a.notes ?? "",
  })));
  for (const a of data.accounts.filter((x) => x.paid_from_account_id)) {
    must(await fin.from("accounts").update({ paid_from_account_id: a.paid_from_account_id }).eq("id", a.id), "card link");
  }
  await insertAll(fin, "statements", data.statements.map((s) => ({
    id: s.id, account_id: s.account_id, period_start: day(s.period_start), closing_date: day(s.closing_date), opening_cents: s.opening_cents,
    ending_cents: s.ending_cents, net_charges_cents: s.net_charges_cents, purchases_cents: s.purchases_cents, credits_cents: s.credits_cents,
    source_file: s.source_file, sha256: s.sha256, imported_at: s.imported_at,
  })));
  await insertAll(fin, "transactions", data.transactions.map((t) => ({
    id: t.id, account_id: t.account_id, date: day(t.date), post_date: day(t.post_date), cleared_date: day(t.cleared_date),
    amount_cents: t.amount_cents, description: t.description ?? "", vendor: t.vendor, kind: t.kind, category: t.category, reference: t.reference,
    status: t.status, transfer_group: t.transfer_group, needs_review: bool(t.needs_review), review_note: t.review_note ?? "",
    source: t.source, source_key: t.source_key ?? `sdm:txn:${t.id}`, statement_id: t.statement_id, notes: t.notes ?? "",
    allocation_basis: t.allocation_basis ?? "", created_by: null, created_at: t.created_at, updated_at: t.updated_at,
  })));
  const missing: string[] = [];
  await insertAll(fin, "txn_allocations", data.allocations.flatMap((a) => {
    const s = sid(a.subteam);
    if (!s) { missing.push(`${a.program} ${a.subteam}`); return []; }
    return [{ id: a.id, txn_id: a.txn_id, project_id: car(a.program), subteam_id: s, amount_cents: a.amount_cents }];
  }));
  await insertAll(fin, "evidence", data.evidence.map((e) => ({
    id: e.id, kind: e.kind, source_file: e.source_file, source_key: e.source_key, vendor: e.vendor, vendor_raw: e.vendor_raw,
    order_ref: e.order_ref, date: day(e.date), total_cents: e.total_cents, items: e.items ?? "", project_id: car(e.program),
    subteam_id: sid(e.subteam), status: e.status ?? "", ship_to: e.ship_to ?? "", payment_hint: e.payment_hint ?? "", link: e.link ?? "",
    record_type: e.record_type ?? "", flags: JSON.parse(e.flags_json || "[]"), txn_id: e.txn_id, match_method: e.match_method ?? "",
    match_score: e.match_score ?? 0,
  })));
  await insertAll(fin, "balance_entries", data.balance_entries.map((b) => ({
    id: b.id, account_id: b.account_id, as_of: day(b.as_of), balance_cents: b.balance_cents, measure: b.measure ?? "balance",
    confirmed: bool(b.confirmed), note: b.note ?? "", entered_by: null, entered_by_name: b.entered_by, entered_at: b.entered_at,
    source_key: b.source_key,
  })));
  await insertAll(fin, "reimbursements", data.reimbursements.map((r) => ({
    id: r.id, person_name: r.person, amount_cents: r.amount_cents, reason: r.reason ?? "", requested_date: day(r.requested_date),
    status: bool(r.paid) ? "paid" : "owed", check_number: r.check_number, check_txn_id: r.check_txn_id, paid_date: day(r.paid_date),
    notes: r.notes ?? "", source_key: r.source_key ?? `sdm:reimb:${r.id}`,
  })));
  await insertAll(fin, "discrepancy_resolutions", data.discrepancy_resolutions.map((r) => ({
    key: r.key, resolved_by: null, resolved_by_name: r.resolved_by, resolved_at: r.resolved_at, note: r.note ?? "",
  })));

  // ---- budgets
  const seasons = [...new Set(data.budgets.map((b) => b.season))];
  const seasonId: Record<string, string> = {};
  for (const name of seasons.length ? seasons : ["2026-27"]) {
    const row = must(await pur.from("seasons").insert({ name, is_current: name === (seasons.sort().at(-1) ?? "2026-27") }).select("id").single(), "season") as Row;
    seasonId[name] = row.id;
  }
  for (const b of data.budgets) {
    const s = sid(b.subteam);
    if (!s || !car(b.program)) { missing.push(`budget ${b.program} ${b.subteam}`); continue; }
    const line = must(await pur.from("budget_lines").insert({
      season_id: seasonId[b.season], project_id: car(b.program), name: b.subteam, amount_cents: b.amount_cents, notes: b.notes ?? "",
    }).select("id").single(), "budget line") as Row;
    must(await pur.from("budget_line_subteams").insert({ budget_line_id: line.id, subteam_id: s }), "budget subteam");
  }

  // ---- parts list
  const current = Object.values(seasonId).at(-1) ?? null;
  const acctName = new Map(data.accounts.map((a) => [a.id, a.name]));
  const allocs = new Map<number, Row[]>();
  for (const a of data.line_item_allocations) allocs.set(a.item_id, [...(allocs.get(a.item_id) ?? []), a]);
  const itemRows = data.line_items.map((i) => ({
    code: i.item_code, title: i.title, status: i.status, priority: i.priority, season_id: current, requester_id: null,
    requester_name: i.requester_name ?? "", justification: i.justification ?? "", needed_by: day(i.needed_by), date_needed_raw: i.date_needed_raw ?? "",
    vendor: i.vendor, product_url: i.product_url ?? "", part_number: i.part_number ?? "", quantity: i.quantity, unit_price_cents: i.unit_price_cents,
    tax_shipping_cents: i.tax_shipping_cents, total_estimate_cents: i.total_estimate_cents, notes: i.notes ?? "", helios_ref: i.helios_ref ?? "",
    ready_at: i.ready_at, approved_at: i.approved_at, denied_reason: i.denied_reason ?? "",
    payment_method: i.payment_account_id ? acctName.get(i.payment_account_id) ?? "" : (i.payment_note ?? ""),
    vendor_order_id: i.vendor_order_id, actual_total_cents: i.actual_total_cents, ordered_at: day(i.ordered_at), carrier: i.carrier ?? "",
    tracking_number: i.tracking_number ?? "", tracking_status: i.tracking_status ?? "", shipped_at: i.shipped_at, est_delivery: day(i.est_delivery),
    delivered_at: i.delivered_at, received_at: i.received_at, reconciled_at: i.reconciled_at, finance_txn_id: i.txn_id, match_method: i.match_method ?? "",
    source: i.source ?? "app", created_at: i.created_at, updated_at: i.updated_at,
  }));
  const idByCode = new Map<string, string>();
  for (let k = 0; k < itemRows.length; k += 200) {
    const got = must(await pur.from("items").insert(itemRows.slice(k, k + 200)).select("id,code"), "items") as Row[];
    for (const g of got) idByCode.set(g.code, g.id);
  }
  const itemAllocs = data.line_items.flatMap((i) => (allocs.get(i.id) ?? []).flatMap((a) => {
    const s = sid(a.subteam), p = car(a.program);
    if (!s || !p) { missing.push(`item ${i.item_code} ${a.program} ${a.subteam}`); return []; }
    return [{ item_id: idByCode.get(i.item_code), project_id: p, subteam_id: s, percent: a.percent }];
  }));
  await insertAll(pur, "item_allocations", itemAllocs);

  must(await fin.rpc("sync_ids"), "sync ids");

  console.log(`Imported: ${data.accounts.length} accounts, ${data.statements.length} statements, ${data.transactions.length} transactions `
    + `(${data.allocations.length} splits), ${data.evidence.length} invoices/emails, ${data.balance_entries.length} balances, `
    + `${data.reimbursements.length} reimbursements, ${data.budgets.length} budget lines, ${data.line_items.length} parts, `
    + `${data.discrepancy_resolutions.length} resolved discrepancies, ${(data.vendors ?? []).length} vendors.`);
  if (missing.length) console.log(`Skipped (no matching car or subteam): ${missing.join("; ")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
