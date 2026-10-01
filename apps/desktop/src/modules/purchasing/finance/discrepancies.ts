// The discrepancy checker. Every flag names the transactions and evidence
// behind it so an exec can check the reasoning instead of trusting it. Flags
// are recomputed from the data every time; an exec's "resolved" decision is
// stored separately (finance.discrepancy_resolutions), keyed by the flag's
// key, so it survives recomputation. Keys match the ledger this replaced.
//
// Written for execs who read this once a week: the same problem is reported
// once, and many small parts-list rows are summarised per subteam.

import { fmtCents as fmt, fmtSigned } from "../lib/money";
import type { ReconRow, Reimbursement, Txn } from "./ledger";
import { isOwed } from "./ledger";

export type EvidenceKind = "invoice" | "email" | "airtable" | "slack" | "request";
/** Parts-list rows and imported Airtable rows: what someone asked for. */
export const REQUEST_KINDS: ReadonlySet<EvidenceKind> = new Set(["airtable", "request"]);

/** Something that describes a purchase but never adds money by itself. A
 *  parts-list item appears here as kind "request" with id = -(its code number). */
export interface Evidence {
  id: number;
  kind: EvidenceKind;
  source_file: string;
  vendor: string | null;
  order_ref: string | null;
  date: string | null;
  total_cents: number | null;
  items: string;
  where: string;          // e.g. "SDM27 Data AQ", for grouping small rows
  status: string;
  payment_hint: string;
  record_type: string;
  flags: string[];
  txn_id: number | null;
  match_method: string;
  item_id?: string;       // the parts-list item, for kind "request"
  object_path?: string | null;  // an attached invoice/receipt file (finance-docs bucket)
}

export interface Discrepancy {
  key: string;
  kind: string;
  severity: "high" | "medium" | "low";
  message: string;
  amount_cents: number | null;
  txn_ids: number[];
  evidence_ids: number[];
}

export const INVOICE_REQUIRED_CENTS = 300_00;   // CFO handbook: invoices required for $300 and up
export const AIRTABLE_ITEM_ALONE_CENTS = 100_00; // parts-list rows at or above this are flagged one by one
const REQUEST_CATEGORIES = new Set(["Parts & materials", "Tools & shop supplies", "Needs category"]);

/** True if this record says money was (or should have been) spent. */
export function claimsACharge(e: Evidence): boolean {
  if (REQUEST_KINDS.has(e.kind)) {
    return (e.status === "ORDERED" || e.status === "RECEIVED") && ((e.total_cents ?? 0) > 0 || !!e.order_ref);
  }
  const rt = e.record_type.toLowerCase();
  if (!(rt === "" || rt.startsWith("charge") || rt === "invoice")) return false;  // funding notes, quotes, ASU purchases
  return (e.total_cents ?? 0) > 0 || !!e.order_ref;
}

const label = (t: Txn) => t.vendor || t.description;
const daysBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;
const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const titleCase = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/** zlib.crc32, so flag keys match the ones the old ledger stored. */
export function crc32(text: string): number {
  let c = ~0;
  for (const byte of new TextEncoder().encode(text)) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

export function findDiscrepancies(
  txns: Txn[], evidence: Evidence[], reimbs: Reimbursement[], recon: ReconRow[], firstStatementStart: string | null = null,
): Discrepancy[] {
  const out: Discrepancy[] = [];
  const push = (d: Omit<Discrepancy, "txn_ids" | "evidence_ids"> & Partial<Pick<Discrepancy, "txn_ids" | "evidence_ids">>) =>
    out.push({ txn_ids: [], evidence_ids: [], ...d });
  const byTxn = new Map<number, Evidence[]>();
  for (const e of evidence) if (e.txn_id !== null) byTxn.set(e.txn_id, [...(byTxn.get(e.txn_id) ?? []), e]);

  // ---- statement lines
  for (const t of txns) {
    if (!["charge", "check", "withdrawal"].includes(t.kind) || t.status !== "posted") continue;
    const evs = byTxn.get(t.id) ?? [];
    const amount = -t.amount_cents;
    const docs = evs.filter((e) => e.kind === "invoice" || e.kind === "email");
    const rows = evs.filter((e) => REQUEST_KINDS.has(e.kind));
    const requests = [...rows, ...evs.filter((e) => e.kind === "slack")];

    if (t.needs_review && t.review_note) {
      push({ key: `review:${t.id}`, kind: "Possibly not a team purchase", severity: "medium",
        message: `${label(t)} ${fmt(amount)} on ${t.date}: ${t.review_note}`, amount_cents: amount, txn_ids: [t.id] });
    }
    if (t.kind === "charge" && !docs.length) {
      const big = amount >= INVOICE_REQUIRED_CENTS;
      push({ key: `no-invoice:${t.id}`, kind: "Charge with no invoice", severity: big ? "high" : "low",
        message: `${label(t)} ${fmt(amount)} on ${t.date} has no invoice or order email`
          + (big ? " (the handbook requires invoices for $300 and up)" : ""),
        amount_cents: amount, txn_ids: [t.id] });
    }
    if (t.kind === "charge" && !requests.length && REQUEST_CATEGORIES.has(t.category)) {
      push({ key: `no-request:${t.id}`, kind: "Charge with no request", severity: "low",
        message: `${label(t)} ${fmt(amount)} on ${t.date} has no parts-list row or request`, amount_cents: amount, txn_ids: [t.id] });
    }
    for (const e of docs) {
      if (e.total_cents === null || e.total_cents === amount || e.status.toLowerCase().includes("estimate")) continue;
      const diff = amount - e.total_cents;
      push({ key: `amount:${t.id}:${e.id}`, kind: "Amount differs from charge", severity: Math.abs(diff) >= 500 ? "medium" : "low",
        message: `${title(e.kind)} says ${fmt(e.total_cents)} but ${label(t)} charged ${fmt(amount)} (${fmtSigned(diff)}). Usually tax or shipping.`,
        amount_cents: diff, txn_ids: [t.id], evidence_ids: [e.id] });
    }
    if (rows.length) {
      const total = rows.reduce((s, r) => s + (r.total_cents ?? 0), 0);
      if (total !== amount) {
        const noun = rows.every((r) => r.kind === "airtable") ? "Airtable" : "The request";
        const what = rows.length === 1 ? `${noun} says ${fmt(total)}` : `${rows.length} requests total ${fmt(total)}`;
        const partial = total < amount * 0.75;
        push({ key: `amount-airtable:${t.id}`, kind: "Amount differs from charge",
          severity: partial || Math.abs(amount - total) < 500 ? "low" : "medium",
          message: `${what} but ${label(t)} charged ${fmt(amount)} (${fmtSigned(amount - total)}).`
            + (partial ? " The requests cover only part of this order."
              : amount > total ? " Usually tax or shipping." : " The request is higher than the charge: check quantities or discounts."),
          amount_cents: amount - total, txn_ids: [t.id], evidence_ids: rows.map((r) => r.id) });
      }
    }
    for (const e of evs) for (const flag of e.flags) {
      push({ key: `evflag:${e.id}:${crc32(flag)}`, kind: "Check with CFO", severity: "medium",
        message: `${e.vendor || e.source_file}: ${flag}`, amount_cents: e.total_cents, txn_ids: [t.id], evidence_ids: [e.id] });
    }
  }

  // ---- same purchase logged twice
  const posted = txns.filter((t) => t.kind === "charge" && t.status === "posted")
    .sort((a, b) => (a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1));
  posted.forEach((a, i) => {
    for (const b of posted.slice(i + 1)) {
      if (daysBetween(a.date, b.date) > 3) break;
      if (a.account_id === b.account_id && a.amount_cents === b.amount_cents && label(a) === label(b)) {
        push({ key: `dup:${a.id}:${b.id}`, kind: "Possible duplicate", severity: "high",
          message: `Two identical ${fmt(-a.amount_cents)} charges from ${label(a)} on ${a.date} and ${b.date}. `
            + "Confirm both are real (e.g. two hotel rooms) or dispute one.",
          amount_cents: -a.amount_cents, txn_ids: [a.id, b.id] });
      }
    }
  });

  // ---- invoices with no statement line
  const unmatchedDocs = evidence.filter((e) => e.txn_id === null && !REQUEST_KINDS.has(e.kind) && claimsACharge(e)
    && !e.payment_hint.toLowerCase().includes("asu") && !e.payment_hint.toLowerCase().includes("p-card"));
  for (const e of unmatchedDocs) {
    const before = !!(firstStatementStart && e.date && e.date < firstStatementStart);
    const amount = e.total_cents !== null ? fmt(e.total_cents) : "amount unknown";
    let extra = before ? " It is dated before the first statement we have, so that statement may just be missing." : "";
    extra += e.flags.map((f) => ` Note: ${f}`).join("");
    push({ key: `invoice-no-charge:${e.id}`, kind: "Invoice with no statement charge", severity: before ? "medium" : "high",
      message: `${e.vendor} ${amount} (${e.date}, ${e.kind}${e.order_ref ? `, ref ${e.order_ref}` : ""}) has no matching statement charge.${extra}`,
      amount_cents: e.total_cents, evidence_ids: [e.id] });
  }

  // ---- parts marked ordered/received with no charge (one flag per purchase)
  const explained = new Set(unmatchedDocs.map((e) => `${e.vendor}|${e.total_cents}`));
  const small = new Map<string, Evidence[]>();
  for (const e of evidence) {
    if (!REQUEST_KINDS.has(e.kind) || e.txn_id !== null || !claimsACharge(e)) continue;
    for (const flag of e.flags) {
      push({ key: `evflag:${e.id}:${crc32(flag)}`, kind: "Check with CFO", severity: "medium",
        message: `${e.source_file}, '${e.items.slice(0, 50)}': ${flag}`, amount_cents: e.total_cents, evidence_ids: [e.id] });
    }
    if (explained.has(`${e.vendor}|${e.total_cents}`)) continue;
    if ((e.total_cents ?? 0) >= AIRTABLE_ITEM_ALONE_CENTS) {
      push({ key: `airtable-no-charge:${e.id}`, kind: "Marked ordered, no charge found", severity: "medium",
        message: `${e.source_file}: '${e.items.slice(0, 60)}' (${titleCase(e.status)}, ${fmt(e.total_cents)}${e.vendor ? `, ${e.vendor}` : ""}) has no matching statement charge`,
        amount_cents: e.total_cents, evidence_ids: [e.id] });
    } else {
      const group = e.kind === "airtable" ? e.source_file : `Requests, ${e.where || "no subteam"}`;
      small.set(group, [...(small.get(group) ?? []), e]);
    }
  }
  for (const [tab, rows] of [...small.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const total = rows.reduce((s, r) => s + (r.total_cents ?? 0), 0);
    push({ key: `airtable-no-charge-group:${tab}:${rows.map((r) => r.id).join(",")}`, kind: "Marked ordered, no charge found", severity: "low",
      message: `${tab}: ${rows.length} small item${rows.length > 1 ? "s" : ""} marked Ordered/Received (${fmt(total)} in total) `
        + "with no matching charge. They may be part of a larger order, bought another way, or not bought yet.",
      amount_cents: total, evidence_ids: rows.map((r) => r.id) });
  }

  // ---- reimbursements and checks
  for (const r of reimbs) {
    if (!isOwed(r)) continue;
    push({ key: `reimb:${r.id}`, kind: r.status === "requested" ? "Reimbursement waiting for review" : "Reimbursement not paid",
      severity: r.amount_cents === null ? "high" : "medium",
      message: `${r.person_name} is owed ${r.amount_cents !== null ? fmt(r.amount_cents) : "an unknown amount"} for ${r.reason || "an unstated reason"}`,
      amount_cents: r.amount_cents });
  }
  for (const t of txns) {
    if (t.kind === "check" && t.cleared_date && !(t.notes.trim() || t.description.trim())) {
      push({ key: `check-why:${t.id}`, kind: "Check with no reason", severity: "medium",
        message: `Check ${t.reference ?? ""} for ${fmt(-t.amount_cents)} cleared with no record of why`, amount_cents: -t.amount_cents, txn_ids: [t.id] });
    }
  }

  // ---- balances
  for (const row of recon) {
    if (row.difference_cents) {
      push({ key: `recon:${row.account_id}:${row.entry.id}`, kind: "Balance doesn't reconcile", severity: "high",
        message: `Entered balance on ${row.entry.as_of} is ${fmt(row.entry.balance_cents)} but the ledger computes `
          + `${fmt(row.computed_cents)}: ${fmtSigned(row.difference_cents)} unexplained`,
        amount_cents: row.difference_cents });
    }
  }
  return out;
}

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;
export const bySeverity = (a: Discrepancy, b: Discrepancy) =>
  SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0);
