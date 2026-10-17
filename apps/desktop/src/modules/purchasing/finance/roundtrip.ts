// The Claude round trip. Agora exports one JSON "snapshot" of the books and
// the parts list, with instructions for Claude written into it. The CFO gives
// Claude that file plus new order emails, invoices and notes, and Claude
// answers with a "changes" file: a list of small, named edits (mark a part
// shipped, attach an invoice to a charge, split a charge). Agora checks every
// change against what's in Agora now, shows it with the reason Claude gave,
// and writes only the ones an exec ticks.
//
// A changes file never adds money: ledger lines still only come from
// statements (Upload files). It can't change a statement line's amount or
// date, or delete anything. It can't approve a part either, except that the
// CFO's own override applies as usual: marking a part ordered approves it, as
// it would by hand. The server's own rules apply to every write, as if the
// exec had made it by hand. The snapshot leaves out shipping addresses.
//
// Pure: no Supabase or React (tests in __tests__/roundtrip.test.ts).

import {
  APPROVED_OR_LATER, ORDERED_STATUSES, STATUSES, STATUS_LABEL, itemCost,
  type Item, type Priority, type Project, type Status, type Subteam,
} from "../lib/api";
import type { CarSubteam } from "../lib/api";
import { fmtCents, parseCents } from "../lib/money";
import type { NewRow } from "../lib/paste";
import type { Category, EvidenceRow, TxnFields } from "./api";
import type { ReimbursementWithReceipts } from "./api";
import { isoDate, normalizeVendor, type VendorRule } from "./importers";
import type { Account, Txn, TxnAllocation } from "./ledger";
import { GAP_LABEL, type LooseEnd } from "./looseEnds";

export const SNAPSHOT_SOURCE = "agora-snapshot";
export const CHANGES_SOURCE = "agora-changes";
export const FORMAT_VERSION = 1;

// ---------------------------------------------------------------- export

export interface SnapshotInput {
  items: Item[];
  projects: Project[];
  subteams: Subteam[];
  carSubteams: CarSubteam[];
  vendors: VendorRule[];
  accounts: Account[];
  categories: Category[];
  txns: Txn[];
  evidence: EvidenceRow[];
  reimbursements: ReimbursementWithReceipts[];
  looseEnds: LooseEnd[];
  exportedAt: string;
  exportedBy: string;
}

const dollars = (c: number | null | undefined): number | null => (c === null || c === undefined ? null : c / 100);

/** Drop empty fields so the file stays readable (the format lists every field). */
function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

/** What Claude is told, inside the file itself, so the CFO only has to hand it over. */
export const INSTRUCTIONS: string[] = [
  "You are helping the CFO of Sun Devil Motorsports (ASU's Formula SAE team) keep the team's books in Agora, the purchasing and finance part of the team app Helios.",
  "This file is a snapshot of Agora: the parts list (\"parts\", each with a code like SDM-0142), every ledger line from the bank and card statements (\"ledger\", each with a number in \"charge\"), invoices and order emails already recorded (\"invoices\"), reimbursements, the cars and subteams, categories and vendors. \"loose_ends\" lists the ledger lines that aren't squared away yet and what each is missing.",
  "The CFO will give you new material with it: order confirmations, shipping and delivery emails, invoices and receipts, and notes about what changed. Work out what each document means for Agora and answer with ONE JSON file, agora-changes.json, in the format under \"changes_format\". Agora shows the CFO every change with your reason and applies only the ones they tick.",
  "Rules for the money. Money counts only on the statement line where it moved: a card charge counts once on the card; the monthly card payment from checking is a transfer, not spending. Invoices, emails and parts never add money; they explain a ledger line. So never invent ledger lines, and never change a ledger line's amount, date or account. If a statement line seems to be missing, say so in a note.",
  "Matching. Match a document to a part by vendor, order number, part number and title; to a ledger line by vendor, amount (the charge is usually the invoice total including tax and shipping) and a date within a few days of the order. Only link when you are confident, and say how you matched in \"why\". When an invoice explains a ledger line, add it with add_invoice and its \"charge\" (or link_invoice if it's already in \"invoices\"). When a part was paid by a ledger line, link it with link_part.",
  "Statuses. An order confirmation means ORDERED (set vendor_order_id, ordered_on, charged and payment_method if the document shows them). A shipping notice means SHIPPED (set carrier and tracking_number). A carrier's delivery notice means DELIVERED. Never set RECEIVED (the person who asked for the part confirms that), APPROVED (two execs approve in the app) or RECONCILED (Agora sets it when a received part is linked to its charge). Don't move a part that is still PLANNED or READY to ORDERED unless the document clearly shows that exact part was bought; then explain in \"why\".",
  "Splitting a charge between subteams: use split_charge with amounts in dollars that add up exactly to the charge (ignore the sign). Use the car codes and subteam names from \"cars\" exactly as written; \"Team\" means shared by both cars.",
  "Be careful and specific. Use only part codes, charge numbers and invoice numbers that are in this file (a part you add with add_part has no code yet, so give add_part its own \"charge\" instead of a separate link_part). Amounts are dollars as numbers (43.71), dates are YYYY-MM-DD. Put the document you used in every \"why\" (\"Mouser invoice 40409253, 9 Sep\"). Don't repeat what Agora already says. When something looks like a personal purchase, a duplicate, or anything you aren't sure about, don't guess: add a {\"op\": \"note\"} for the CFO instead.",
  "Never write full card or account numbers (last four digits only), passwords or anything personal beyond names already in this file.",
];

/** The changes file Claude sends back, described for Claude. */
export const CHANGES_FORMAT = {
  description: "Reply with exactly this shape. Each entry in changes has an op and a why; leave out any field you don't want to change.",
  example: {
    source: CHANGES_SOURCE,
    version: FORMAT_VERSION,
    based_on: "<exported_at of the snapshot you were given>",
    summary: "One or two sentences on what you found.",
    changes: [
      { op: "update_part", part: "SDM-0142", set: { status: "SHIPPED", carrier: "UPS", tracking_number: "1Z999AA10123456784" }, why: "Newark shipping email, 16 Sep" },
      { op: "update_part", part: "SDM-0150", set: { status: "ORDERED", vendor_order_id: "40409253", ordered_on: "2026-09-09", charged: 18.52, payment_method: "SAE card" }, why: "Mouser order confirmation 40409253" },
      { op: "add_part", car: "SDM27", subteam: "Data AQ", title: "TVS diode AQ1003-01LTG", vendor: "Mouser", part_number: "AQ1003-01LTG", quantity: 16, unit_price: 0.305, status: "ORDERED", vendor_order_id: "40409253", ordered_on: "2026-09-09", charge: 57, why: "On Mouser order 40409253 but not in the parts list" },
      { op: "link_part", part: "SDM-0142", charge: 61, why: "Newark charge of $44.67 on 15 Sep matches the part's total" },
      { op: "add_invoice", vendor: "TBM Brakes", order_ref: "T16393", date: "2026-09-02", total: 43.71, items: "RIFE M5 cable, 3 ft", charge: 58, why: "TBM order confirmation T16393" },
      { op: "link_invoice", invoice: 12, charge: 58, why: "Same order number and total" },
      { op: "update_charge", charge: 58, set: { category: "Parts & materials", notes: "WSPD cable for SDM27" }, why: "TBM Brakes invoice" },
      { op: "split_charge", charge: 70, split: [{ car: "SDM27", subteam: "Chassis", amount: 120.0 }, { car: "Team", subteam: "Operations", amount: 30.5 }], why: "Invoice lists chassis tube and shop rags" },
      { op: "note", text: "Partzilla order 11-11642662 is addressed to Jaxson and ships to ZIP 21054: probably personal. Check before counting it." },
    ],
  },
  ops: {
    update_part: "Change a part. set may hold: status, title, vendor, part_number, link, quantity, unit_price, tax_shipping, estimate, charged (what was actually paid), vendor_order_id, ordered_on, payment_method, paid_by (a member who paid with their own money), carrier, tracking_number, est_delivery, funding, notes, priority (HIGH, Medium, Low), needed_by.",
    add_part: "Add a part that was bought (or will be) but isn't in the parts list. Needs car, subteam and title; may have every update_part field, status (PLANNED, READY, ORDERED, RECEIVED or HAVE; default PLANNED) and charge (the ledger line that paid for it).",
    link_part: "Say which ledger line paid for a part (charge: null unlinks it).",
    add_invoice: "Record an invoice, receipt or order email. Needs vendor and total or order_ref; may have date, items, ship_to, payment_hint (e.g. \"SAE card ...1234\") and charge.",
    link_invoice: "Attach an invoice already in the snapshot to a ledger line (charge: null detaches it).",
    update_charge: "Change a ledger line's paperwork. set may hold: category (one of \"categories\"), vendor, description, notes, needs_review (true/false) and review_note. Never the amount, date or account.",
    split_charge: "Say which car and subteam a ledger line's money belongs to. split is a list of {car, subteam, amount}; the amounts add up to the charge.",
    note: "Something for the CFO to look at. text is shown to them; nothing is changed.",
  },
};

/** The whole snapshot, as written to agora-snapshot-<date>.json. */
export function buildSnapshot(s: SnapshotInput) {
  const car = (id: string | null) => (id ? s.projects.find((p) => p.id === id)?.car_code ?? "?" : "Team");
  const team = (id: string | null) => (id ? s.subteams.find((x) => x.id === id)?.name ?? "?" : "");
  const account = (id: number) => s.accounts.find((a) => a.id === id)?.name ?? "?";
  const code = (id: string | null) => (id ? s.items.find((i) => i.id === id)?.code ?? null : null);
  const partsOf = new Map<number, string[]>();
  for (const i of s.items) if (i.finance_txn_id) partsOf.set(i.finance_txn_id, [...(partsOf.get(i.finance_txn_id) ?? []), i.code]);
  const docsOf = new Map<number, number[]>();
  for (const e of s.evidence) if (e.txn_id !== null) docsOf.set(e.txn_id, [...(docsOf.get(e.txn_id) ?? []), e.id]);

  return {
    source: SNAPSHOT_SOURCE,
    version: FORMAT_VERSION,
    exported_at: s.exportedAt,
    exported_by: s.exportedBy,
    instructions_for_claude: INSTRUCTIONS,
    changes_format: CHANGES_FORMAT,
    cars: s.projects.map((p) => compact({
      car: p.car_code, name: p.name, program: p.program ? p.program.toUpperCase() : null,
      subteams: s.carSubteams.filter((x) => x.project_id === p.id).map((x) => team(x.subteam_id)).filter((n) => n && n !== "?"),
    })),
    subteams: s.subteams.map((x) => x.name),
    categories: s.categories.map((c) => ({ name: c.name, direction: c.direction })),
    vendors: s.vendors.map((v) => v.name),
    accounts: s.accounts.map((a) => compact({
      account: a.name, kind: a.kind, last4: a.last4, holder: a.holder, credit_limit: dollars(a.credit_limit_cents), active: a.active ? null : false,
    })),
    parts: s.items.map((i) => compact({
      part: i.code, title: i.title, status: i.status,
      car: i.item_allocations.length === 1 ? car(i.item_allocations[0]!.project_id) : null,
      subteam: i.item_allocations.length === 1 ? team(i.item_allocations[0]!.subteam_id) : null,
      shares: i.item_allocations.length > 1 ? i.item_allocations.map((a) => ({ car: car(a.project_id), subteam: team(a.subteam_id), percent: Number(a.percent) })) : null,
      priority: i.priority, asked_by: i.requester_name, vendor: i.vendor, part_number: i.part_number, link: i.product_url,
      quantity: i.quantity === null ? null : Number(i.quantity), unit_price: dollars(i.unit_price_cents), tax_shipping: dollars(i.tax_shipping_cents),
      estimate: dollars(i.total_estimate_cents), charged: dollars(i.actual_total_cents), cost: dollars(itemCost(i)),
      vendor_order_id: i.vendor_order_id, ordered_on: i.ordered_at, payment_method: i.payment_method, paid_by: i.paid_by,
      carrier: i.carrier, tracking_number: i.tracking_number, est_delivery: i.est_delivery, funding: i.funding_source,
      needed_by: i.needed_by, notes: i.notes, why: i.justification, charge: i.finance_txn_id ?? null, added: i.created_at?.slice(0, 10),
    })),
    ledger: s.txns.map((t) => compact({
      charge: t.id, account: account(t.account_id), date: t.date, amount: dollars(t.amount_cents), kind: t.kind,
      status: t.status === "posted" ? null : t.status, description: t.description, vendor: t.vendor, category: t.category,
      reference: t.reference, cleared: t.kind === "check" ? t.cleared_date ?? "not yet" : null,
      split: t.txn_allocations.map((a) => ({ car: car(a.project_id), subteam: team(a.subteam_id), amount: dollars(a.amount_cents) })),
      parts: partsOf.get(t.id) ?? [], invoices: docsOf.get(t.id) ?? [],
      flagged: t.needs_review ? t.review_note || "yes" : null, notes: t.notes, from: t.source === "manual" ? "entered by hand" : null,
    })),
    invoices: s.evidence.filter((e) => e.kind === "invoice" || e.kind === "email").map((e) => compact({
      invoice: e.id, kind: e.kind, vendor: e.vendor, order_ref: e.order_ref, date: e.date, total: dollars(e.total_cents), items: e.items,
      status: e.status, payment_hint: e.payment_hint, charge: e.txn_id, file: e.source_file,
    })),
    reimbursements: s.reimbursements.map((r) => compact({
      reimbursement: r.id, person: r.person_name, amount: dollars(r.amount_cents), reason: r.reason, status: r.status,
      requested: r.requested_date, paid: r.paid_date, check: r.check_number, part: code(r.item_id),
    })),
    loose_ends: s.looseEnds.map((e) => ({
      charge: e.txn.id, missing: e.gaps.map((g) => (g.detail ? `${GAP_LABEL[g.gap]} (${g.detail})` : GAP_LABEL[g.gap])),
    })),
  };
}

// ---------------------------------------------------------------- import

export interface ChangesFile { source?: unknown; version?: unknown; based_on?: unknown; summary?: unknown; changes?: unknown }
type Raw = Record<string, unknown>;

/** Read a changes file. Throws with a plain message if it isn't one. */
export function readChanges(text: string): { basedOn: string; summary: string; changes: Raw[] } {
  let data: ChangesFile;
  try { data = JSON.parse(text.replace(/^﻿/, "")) as ChangesFile; } catch { throw new Error("That file isn't JSON. Ask Claude for the agora-changes.json file itself."); }
  if (data?.source === SNAPSHOT_SOURCE) throw new Error("That's a snapshot Agora exported, not Claude's answer. Give it to Claude and load the agora-changes.json it sends back.");
  if (data?.source !== CHANGES_SOURCE || !Array.isArray(data.changes)) {
    throw new Error(`That isn't a changes file (it should start with "source": "${CHANGES_SOURCE}" and have a "changes" list).`);
  }
  const changes = (data.changes as unknown[]).filter((c): c is Raw => !!c && typeof c === "object" && !Array.isArray(c));
  return { basedOn: typeof data.based_on === "string" ? data.based_on : "", summary: typeof data.summary === "string" ? data.summary : "", changes };
}

/** What Agora knows when it checks a change. */
export interface PlanContext {
  items: Item[];
  projects: Project[];
  subteams: Subteam[];
  vendors: VendorRule[];
  txns: Txn[];
  evidence: EvidenceRow[];
  categories: Category[];
  /** the CFO (purchasing.override): may mark parts ordered before they're approved */
  override: boolean;
}

export type Action =
  | { kind: "update_part"; itemId: string; patch: Record<string, unknown>; status: Status | null }
  | { kind: "add_part"; projectId: string; subteamId: string; row: NewRow; status: Status; buyer: Record<string, unknown>; txnId: number | null }
  | { kind: "link_part"; itemId: string; txnId: number | null }
  | { kind: "add_invoice"; row: Partial<EvidenceRow> & { source_key: string } }
  | { kind: "link_invoice"; evidenceId: number; txnId: number | null }
  | { kind: "update_charge"; txnId: number; fields: TxnFields }
  | { kind: "split_charge"; txnId: number; allocations: TxnAllocation[] };

export interface Planned {
  n: number;                 // its place in the file, from 1
  op: string;
  title: string;             // what it's about: "SDM-0142 IMU IC", "Charge #57: Mouser -$18.52"
  lines: { field: string; from: string; to: string }[];
  why: string;
  /** set: can't be applied as written (shown, never ticked) */
  problem: string | null;
  /** fields that were ignored, and other things to know */
  warnings: string[];
  /** already true in Agora: nothing to do */
  nothing: boolean;
  /** a note for the CFO (op "note"): nothing to apply */
  note: string | null;
  action: Action | null;
}

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v).trim());
const shown = (v: unknown): string => (v === null || v === undefined || v === "" ? "(blank)" : String(v));
const money = (c: number | null | undefined) => (c === null || c === undefined ? "(blank)" : fmtCents(c));
const digits = (s: string) => s.replace(/\D/g, "").replace(/^0+/, "");

function findPart(items: Item[], ref: unknown): Item | undefined {
  const d = digits(str(ref));
  return d ? items.find((i) => digits(i.code) === d) : undefined;
}
function findCar(projects: Project[], ref: unknown): Project | undefined {
  const r = str(ref).toLowerCase();
  return projects.find((p) => p.car_code.toLowerCase() === r) ?? projects.find((p) => p.name.toLowerCase() === r);
}
function findSubteam(subteams: Subteam[], ref: unknown): Subteam | undefined {
  const r = str(ref).toLowerCase();
  return subteams.find((s) => s.name.toLowerCase() === r) ?? subteams.find((s) => s.code.toLowerCase() === r);
}
function findTxn(txns: Txn[], ref: unknown): Txn | undefined {
  const n = Number(str(ref).replace(/^#/, ""));
  return Number.isInteger(n) ? txns.find((t) => t.id === n) : undefined;
}
/** "SHIPPED", "Shipped", "Not ready to order" -> the status. */
export function readStatus(v: unknown): Status | null {
  const s = str(v);
  const up = s.toUpperCase().replace(/[\s-]+/g, "_");
  if ((STATUSES as string[]).includes(up)) return up as Status;
  return (Object.entries(STATUS_LABEL).find(([, label]) => label.toLowerCase() === s.toLowerCase())?.[0] as Status | undefined) ?? null;
}
function readPriority(v: unknown): Priority | null {
  return ({ high: "HIGH", medium: "Medium", low: "Low" } as Record<string, Priority>)[str(v).toLowerCase()] ?? null;
}
/** A dollar amount (43.71, "$43.71") -> cents; null if blank, undefined if it isn't money. */
function readMoney(v: unknown): number | null | undefined {
  if (v === null || v === "") return null;
  const c = parseCents(typeof v === "number" ? v : str(v));
  return c === null ? undefined : c;
}
/** A part's price may be a fraction of a cent per unit (0.305): the server stores whole cents. */
function readUnitPrice(v: unknown): number | null | undefined {
  if (v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(str(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : undefined;
}

// update_part's set: { name in the file -> the item field, how to read it }
type Reader = "text" | "money" | "unit" | "date" | "number" | "priority" | "tracking";
const PART_FIELDS: Record<string, [keyof Item | "paid_by", Reader]> = {
  title: ["title", "text"], vendor: ["vendor", "text"], part_number: ["part_number", "text"], link: ["product_url", "text"],
  product_url: ["product_url", "text"], quantity: ["quantity", "number"], unit_price: ["unit_price_cents", "unit"],
  tax_shipping: ["tax_shipping_cents", "money"], estimate: ["total_estimate_cents", "money"], total: ["total_estimate_cents", "money"],
  charged: ["actual_total_cents", "money"], actual_total: ["actual_total_cents", "money"], vendor_order_id: ["vendor_order_id", "text"],
  ordered_on: ["ordered_at", "date"], ordered_at: ["ordered_at", "date"], payment_method: ["payment_method", "text"],
  paid_by: ["paid_by", "text"], carrier: ["carrier", "text"], tracking_number: ["tracking_number", "tracking"],
  est_delivery: ["est_delivery", "date"], funding: ["funding_source", "text"], funding_source: ["funding_source", "text"],
  notes: ["notes", "text"], priority: ["priority", "priority"], needed_by: ["needed_by", "date"], why: ["justification", "text"],
  justification: ["justification", "text"],
};
const BUYER_FIELDS = new Set(["vendor_order_id", "actual_total_cents", "carrier", "tracking_number", "est_delivery", "payment_method", "paid_by", "ordered_at"]);
const MONEY_FIELDS = new Set(["unit_price_cents", "tax_shipping_cents", "total_estimate_cents", "actual_total_cents"]);

/** Read update_part's (or add_part's) fields into an update_item patch. */
function readPartFields(set: Raw, vendors: VendorRule[], skip: ReadonlySet<string> = new Set()): { patch: Record<string, unknown>; bad: string[]; ignored: string[] } {
  const patch: Record<string, unknown> = {}, bad: string[] = [], ignored: string[] = [];
  for (const [name, value] of Object.entries(set)) {
    if (skip.has(name)) continue;
    const spec = PART_FIELDS[name];
    if (!spec) { ignored.push(name); continue; }
    const [field, how] = spec;
    let v: unknown;
    if (how === "money") v = readMoney(value);
    else if (how === "unit") v = readUnitPrice(value);
    else if (how === "date") v = value === null || value === "" ? null : isoDate(str(value)) ?? undefined;
    else if (how === "number") { const n = value === null || value === "" ? null : Number(str(value).replace(/,/g, "")); v = n === null ? null : Number.isFinite(n) && n > 0 ? n : undefined; }
    else if (how === "priority") v = readPriority(value) ?? undefined;
    else if (how === "tracking") v = str(value).replace(/[\s-]/g, "").toUpperCase();
    else v = field === "vendor" && str(value) ? normalizeVendor(str(value), vendors) : str(value);
    if (v === undefined) bad.push(`${name} "${str(value)}"`);
    else patch[field] = v;
  }
  return { patch, bad, ignored };
}

function partValue(i: Item, field: string): string {
  const v = (i as unknown as Record<string, unknown>)[field];
  if (MONEY_FIELDS.has(field)) return money(v as number | null);
  return shown(field === "quantity" && v !== null && v !== undefined ? Number(v) : v);
}
function newValue(field: string, v: unknown): string {
  return MONEY_FIELDS.has(field) ? money(v as number | null) : shown(v);
}
const sameValue = (i: Item, field: string, v: unknown) => {
  const cur = (i as unknown as Record<string, unknown>)[field];
  if (field === "quantity") return cur !== null && cur !== undefined && v !== null && Number(cur) === Number(v);
  return (cur ?? "") === (v ?? "");
};

const txnTitle = (t: Txn) => `Charge #${t.id}: ${t.vendor || t.description || "?"} ${fmtCents(t.amount_cents)} on ${t.date}`;
const partTitle = (i: Item) => `${i.code} ${i.title}`;

/** Check every change against Agora as it is now. */
export function planChanges(changes: Raw[], ctx: PlanContext): Planned[] {
  return changes.map((c, k) => {
    const p: Planned = { n: k + 1, op: str(c.op), title: "", lines: [], why: str(c.why), problem: null, warnings: [], nothing: false, note: null, action: null };
    try { plan(c, ctx, p); } catch (e) { p.problem = e instanceof Error ? e.message : String(e); }
    if (p.problem) p.action = null;
    return p;
  });
}

function plan(c: Raw, ctx: PlanContext, p: Planned): void {
  const fail = (msg: string): never => { throw new Error(msg); };
  const txnOrFail = (ref: unknown): Txn => findTxn(ctx.txns, ref) ?? fail(`There's no ledger line #${str(ref) || "?"} in Agora.`);
  const linkTarget = (ref: unknown): number | null => (ref === null ? null : txnOrFail(ref).id);

  switch (p.op) {
    case "note": {
      p.title = "Note for you";
      p.note = str(c.text) || str(c.why) || "(empty note)";
      return;
    }

    case "update_part": {
      const item = findPart(ctx.items, c.part) ?? fail(`There's no part ${str(c.part) || "?"} in Agora.`);
      p.title = partTitle(item);
      const set = (c.set && typeof c.set === "object" ? c.set : {}) as Raw;
      const { patch, bad, ignored } = readPartFields(set, ctx.vendors, new Set(["status"]));
      if (bad.length) fail(`Not understood: ${bad.join(", ")}.`);
      if (ignored.length) p.warnings.push(`Ignored (Agora has no such part field): ${ignored.join(", ")}.`);
      for (const [field, v] of Object.entries(patch)) {
        if (sameValue(item, field, v)) { delete patch[field]; continue; }
        p.lines.push({ field: label(field), from: partValue(item, field), to: newValue(field, v) });
      }
      let status: Status | null = null;
      if ("status" in set) {
        status = readStatus(set.status) ?? fail(`"${str(set.status)}" isn't a status.`);
        if (status === item.status) status = null;
        else {
          checkMove(item, status, ctx.override);
          p.lines.push({ field: "Status", from: STATUS_LABEL[item.status], to: STATUS_LABEL[status] });
        }
      }
      p.nothing = !p.lines.length;
      p.action = { kind: "update_part", itemId: item.id, patch, status };
      return;
    }

    case "add_part": {
      const car = findCar(ctx.projects, c.car) ?? fail(`"${str(c.car)}" isn't a car in Agora (use a car code from the snapshot).`);
      const team = findSubteam(ctx.subteams, c.subteam) ?? fail(`"${str(c.subteam)}" isn't a subteam in Agora.`);
      const title = str(c.title) || fail("A new part needs a title.");
      p.title = `New part for ${car.car_code} ${team.name}: ${title}`;
      const status = c.status === undefined || c.status === null || c.status === "" ? "PLANNED" : readStatus(c.status) ?? fail(`"${str(c.status)}" isn't a status.`);
      if (!["PLANNED", "READY", "ORDERED", "RECEIVED", "HAVE"].includes(status)) {
        fail(`A new part can be Not ready, Ready to order, Ordered, Received or Already have, not ${STATUS_LABEL[status]}.`);
      }
      if (ORDERED_STATUSES.has(status) && !ctx.override) fail("Only the CFO can add a part that was bought without approvals in the app.");
      const there = ctx.items.find((i) => i.title.trim().toLowerCase() === title.toLowerCase()
        && i.item_allocations.some((a) => a.project_id === car.id && a.subteam_id === team.id));
      if (there) { p.nothing = true; p.warnings.push(`${there.code} already has that name on ${car.car_code} ${team.name}: use update_part for it.`); return; }
      const skip = new Set(["op", "why", "car", "subteam", "title", "status", "charge"]);
      const { patch, bad, ignored } = readPartFields(c, ctx.vendors, skip);
      if (bad.length) fail(`Not understood: ${bad.join(", ")}.`);
      if (ignored.length) p.warnings.push(`Ignored: ${ignored.join(", ")}.`);
      const row: NewRow = { title };
      const buyer: Record<string, unknown> = {};
      for (const [field, v] of Object.entries(patch)) {
        if (v === null || v === "") continue;
        if (BUYER_FIELDS.has(field)) buyer[field] = v;
        else Object.assign(row, { [field]: v });
        p.lines.push({ field: label(field), from: "", to: newValue(field, v) });
      }
      p.lines.unshift({ field: "Status", from: "", to: STATUS_LABEL[status] });
      const txnId = c.charge === undefined ? null : linkTarget(c.charge);
      if (txnId !== null) p.lines.push({ field: "Paid by", from: "", to: txnTitle(txnOrFail(txnId)) });
      p.action = { kind: "add_part", projectId: car.id, subteamId: team.id, row, status, buyer, txnId };
      return;
    }

    case "link_part": {
      const item = findPart(ctx.items, c.part) ?? fail(`There's no part ${str(c.part) || "?"} in Agora.`);
      p.title = partTitle(item);
      if (!("charge" in c)) fail("link_part needs a charge (or charge: null to unlink).");
      const txnId = linkTarget(c.charge);
      const cur = item.finance_txn_id ?? null;
      const name = (id: number | null) => (id === null ? "(none)" : txnTitle(findTxn(ctx.txns, id) ?? ({ id, date: "?", amount_cents: 0, vendor: "?", description: "" } as Txn)));
      p.nothing = cur === txnId;
      if (!p.nothing) p.lines.push({ field: "Paid by", from: name(cur), to: name(txnId) });
      p.action = { kind: "link_part", itemId: item.id, txnId };
      return;
    }

    case "add_invoice": {
      const vendor = str(c.vendor) ? normalizeVendor(str(c.vendor), ctx.vendors) : fail("An invoice needs a vendor.");
      const total = c.total === undefined ? null : readMoney(c.total);
      if (total === undefined) fail(`Total "${str(c.total)}" isn't an amount.`);
      const ref = str(c.order_ref);
      if (total === null && !ref) fail("An invoice needs a total or an order number.");
      const date = c.date ? isoDate(str(c.date)) ?? fail(`Date "${str(c.date)}" isn't a date.`) : null;
      p.title = `Invoice: ${vendor}${ref ? ` ${ref}` : ""}${total !== null ? ` ${fmtCents(total)}` : ""}`;
      const dup = ctx.evidence.find((e) => (e.kind === "invoice" || e.kind === "email") && (e.vendor ?? "").toLowerCase() === vendor.toLowerCase()
        && (ref ? (e.order_ref ?? "").toLowerCase() === ref.toLowerCase() : e.total_cents === total && e.date === date)
        && (total === null || e.total_cents === null || e.total_cents === total));
      if (dup) { p.nothing = true; p.warnings.push(`Already in Agora as invoice ${dup.id}${dup.txn_id ? `, on charge #${dup.txn_id}` : ""}: use link_invoice to move it.`); return; }
      const txnId = c.charge === undefined ? null : linkTarget(c.charge);
      const row = {
        kind: "invoice" as const, source_file: "From Claude (agora-changes.json)", vendor, vendor_raw: str(c.vendor), order_ref: ref || null, date,
        total_cents: total, items: str(c.items), ship_to: str(c.ship_to), payment_hint: str(c.payment_hint), record_type: "invoice",
        txn_id: txnId, match_method: txnId === null ? "" : "claude", match_score: txnId === null ? 0 : 1,
        source_key: `claude:${vendor}:${ref || date || ""}:${total ?? ""}`.toLowerCase(),
      };
      for (const [f, v] of [["Order #", ref], ["Date", date ?? ""], ["Total", total === null ? "" : fmtCents(total)], ["Items", row.items], ["Ships to", row.ship_to], ["Paid with", row.payment_hint]] as const) {
        if (v) p.lines.push({ field: f, from: "", to: v });
      }
      if (txnId !== null) p.lines.push({ field: "Explains", from: "", to: txnTitle(txnOrFail(txnId)) });
      p.action = { kind: "add_invoice", row };
      return;
    }

    case "link_invoice": {
      const id = Number(str(c.invoice));
      const ev = ctx.evidence.find((e) => e.id === id) ?? fail(`There's no invoice ${str(c.invoice) || "?"} in Agora.`);
      p.title = `Invoice ${ev.id}: ${ev.vendor ?? "?"}${ev.order_ref ? ` ${ev.order_ref}` : ""} ${fmtCents(ev.total_cents)}`;
      if (!("charge" in c)) fail("link_invoice needs a charge (or charge: null to detach).");
      const txnId = linkTarget(c.charge);
      p.nothing = ev.txn_id === txnId;
      const name = (tid: number | null) => (tid === null ? "(none)" : findTxn(ctx.txns, tid) ? txnTitle(findTxn(ctx.txns, tid)!) : `#${tid}`);
      if (!p.nothing) p.lines.push({ field: "Explains", from: name(ev.txn_id), to: name(txnId) });
      p.action = { kind: "link_invoice", evidenceId: ev.id, txnId };
      return;
    }

    case "update_charge": {
      const t = txnOrFail(c.charge);
      p.title = txnTitle(t);
      const set = (c.set && typeof c.set === "object" ? c.set : {}) as Raw;
      const fields: TxnFields = {};
      const locked: string[] = [], ignored: string[] = [];
      for (const [name, v] of Object.entries(set)) {
        if (name === "category") {
          const cat = ctx.categories.find((x) => x.name.toLowerCase() === str(v).toLowerCase()) ?? fail(`"${str(v)}" isn't one of Agora's categories.`);
          if (cat.name !== t.category) { fields.category = cat.name; p.lines.push({ field: "Category", from: t.category, to: cat.name }); }
        } else if (name === "vendor" || name === "description" || name === "notes" || name === "review_note") {
          const val = name === "vendor" && str(v) ? normalizeVendor(str(v), ctx.vendors) : str(v);
          const cur = name === "vendor" ? t.vendor ?? "" : t[name];
          if (val !== cur) { Object.assign(fields, { [name]: name === "vendor" ? val || null : val }); p.lines.push({ field: label(name), from: shown(cur), to: shown(val) }); }
        } else if (name === "needs_review") {
          const val = v === true || str(v).toLowerCase() === "true";
          if (val !== t.needs_review) { fields.needs_review = val; p.lines.push({ field: "Flagged for review", from: t.needs_review ? "yes" : "no", to: val ? "yes" : "no" }); }
        } else if (["amount", "amount_cents", "date", "account", "account_id", "kind", "post_date"].includes(name)) locked.push(name);
        else ignored.push(name);
      }
      if (locked.length) p.warnings.push(`Ignored ${locked.join(", ")}: a statement line's amount, date and account only come from the statement.`);
      if (ignored.length) p.warnings.push(`Ignored: ${ignored.join(", ")}.`);
      p.nothing = !p.lines.length;
      p.action = { kind: "update_charge", txnId: t.id, fields };
      return;
    }

    case "split_charge": {
      const t = txnOrFail(c.charge);
      p.title = txnTitle(t);
      if (!Array.isArray(c.split) || !c.split.length) fail("split_charge needs a split: a list of {car, subteam, amount}.");
      const abs = Math.abs(t.amount_cents);
      const shares = (c.split as Raw[]).map((s) => {
        const team = findSubteam(ctx.subteams, s?.subteam) ?? fail(`"${str(s?.subteam)}" isn't a subteam in Agora.`);
        const carRef = str(s?.car);
        const project_id = !carRef || carRef.toLowerCase() === "team" ? null : (findCar(ctx.projects, carRef) ?? fail(`"${carRef}" isn't a car in Agora.`)).id;
        const amt = s?.amount === undefined ? null : readMoney(s.amount);
        if (amt === undefined) return fail(`Amount "${str(s?.amount)}" isn't an amount.`);
        return { project_id, subteam_id: team.id, amount_cents: amt === null ? null : Math.abs(amt) };
      });
      if (shares.length === 1 && shares[0]!.amount_cents === null) shares[0]!.amount_cents = abs;
      if (shares.some((s) => s.amount_cents === null)) fail("Every share needs an amount (a single share may leave it out: it gets the whole charge).");
      const allocations = shares as TxnAllocation[];
      const sum = allocations.reduce((s, a) => s + a.amount_cents, 0);
      if (t.kind !== "transfer" && sum !== abs) fail(`The split adds up to ${fmtCents(sum)}, but the charge is ${fmtCents(abs)}.`);
      const where = (a: Pick<TxnAllocation, "project_id" | "subteam_id">) =>
        `${a.project_id ? ctx.projects.find((x) => x.id === a.project_id)?.car_code ?? "?" : "Team"} ${ctx.subteams.find((x) => x.id === a.subteam_id)?.name ?? "?"}`;
      const show = (xs: Pick<TxnAllocation, "project_id" | "subteam_id" | "amount_cents">[]) =>
        xs.length ? xs.map((a) => `${where(a)} ${fmtCents(a.amount_cents)}`).join(", ") : "(none)";
      const key = (xs: Pick<TxnAllocation, "project_id" | "subteam_id" | "amount_cents">[]) =>
        xs.map((a) => `${a.project_id}|${a.subteam_id}|${a.amount_cents}`).sort().join(";");
      p.nothing = key(t.txn_allocations) === key(allocations);
      if (!p.nothing) p.lines.push({ field: "Split", from: show(t.txn_allocations), to: show(allocations) });
      p.action = { kind: "split_charge", txnId: t.id, allocations };
      return;
    }

    default:
      fail(`Agora doesn't know the change "${p.op || "(no op)"}".`);
  }
}

/** Status moves a changes file may not make (the server would refuse them anyway). */
function checkMove(item: Item, to: Status, override: boolean): void {
  if (to === "APPROVED") throw new Error("Parts are approved in the app (two execs, or the CFO's Approve now), not from a file.");
  if (to === "RECONCILED") throw new Error("Agora marks a part reconciled when it's linked to its charge: use link_part instead.");
  if (ORDERED_STATUSES.has(to) && !APPROVED_OR_LATER.has(item.status) && !override) {
    throw new Error(`${item.code} hasn't been approved, so it can't be marked ${STATUS_LABEL[to].toLowerCase()} (only the CFO can, for approvals given in person).`);
  }
}

const LABELS: Record<string, string> = {
  title: "Title", vendor: "Vendor", part_number: "Part #", product_url: "Link", quantity: "Qty", unit_price_cents: "Unit price",
  tax_shipping_cents: "Tax/ship", total_estimate_cents: "Estimate", actual_total_cents: "Charged", vendor_order_id: "Order #",
  ordered_at: "Ordered on", payment_method: "Paid with", paid_by: "Paid by member", carrier: "Carrier", tracking_number: "Tracking",
  est_delivery: "Arrives", funding_source: "Funding", notes: "Notes", priority: "Priority", needed_by: "Needed by", justification: "Why",
  description: "Description", review_note: "Review note",
};
const label = (field: string) => LABELS[field] ?? field;
