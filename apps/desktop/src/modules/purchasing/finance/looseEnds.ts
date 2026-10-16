// Loose ends: every ledger line that isn't fully squared away, and what is
// missing on each. The same reasoning as the discrepancy checker, turned
// round: one entry per line with a checklist, so an exec can work down the
// list and close each one.
//
// Two kinds of gap. A line with no category or no subteam split has to be
// fixed: the books and the budgets can't tie without them. Paperwork gaps (no
// receipt, no part matched, an amount that differs, a flag, a check with no
// reason) can also be waived with a reason. Waiving one stores the same key
// the Discrepancies page uses, so the two pages always agree.
//
// Pure: no Supabase or React (tests in __tests__/looseEnds.test.ts).

import { fmtCents } from "../lib/money";
import { INVOICE_REQUIRED_CENTS, REQUEST_CATEGORIES, REQUEST_KINDS, type Evidence } from "./discrepancies";
import { isSpend, type Txn } from "./ledger";

export type Gap = "category" | "split" | "receipt" | "part" | "amount" | "review" | "reason";

export const GAP_LABEL: Record<Gap, string> = {
  category: "No category",
  split: "No subteam",
  receipt: "No receipt",
  part: "No part matched",
  amount: "Amount differs",
  review: "Flagged for review",
  reason: "No reason given",
};
/** In the order they're usually fixed. */
export const GAPS: Gap[] = ["category", "split", "receipt", "part", "amount", "review", "reason"];

export interface GapInfo {
  gap: Gap;
  /** a short explanation ("required for $300 and up", "invoice says $43.71") */
  detail: string;
  /** Discrepancy keys that waive this gap. Empty: it has to be fixed, not waived. */
  keys: string[];
}

export interface LooseEnd {
  txn: Txn;
  gaps: GapInfo[];
  /** invoices and order emails attached to the line */
  docs: Evidence[];
  /** parts-list items, Airtable rows and requests attached to the line */
  parts: Evidence[];
}

/** Every posted line with something still missing, in ledger order (newest first). */
export function looseEnds(txns: Txn[], evidence: Evidence[], resolved: ReadonlySet<string>): LooseEnd[] {
  const byTxn = new Map<number, Evidence[]>();
  for (const e of evidence) if (e.txn_id !== null) byTxn.set(e.txn_id, [...(byTxn.get(e.txn_id) ?? []), e]);
  const out: LooseEnd[] = [];
  for (const t of txns) {
    if (t.status !== "posted") continue;
    const evs = byTxn.get(t.id) ?? [];
    const docs = evs.filter((e) => e.kind === "invoice" || e.kind === "email");
    const parts = evs.filter((e) => REQUEST_KINDS.has(e.kind));
    const gaps = gapsOf(t, docs, parts, evs.some((e) => e.kind === "slack"))
      .filter((g) => !g.keys.length || g.keys.some((k) => !resolved.has(k)));
    if (gaps.length) out.push({ txn: t, gaps, docs, parts });
  }
  return out.sort((a, b) => (a.txn.date === b.txn.date ? b.txn.id - a.txn.id : a.txn.date < b.txn.date ? 1 : -1));
}

function gapsOf(t: Txn, docs: Evidence[], parts: Evidence[], slack: boolean): GapInfo[] {
  const gaps: GapInfo[] = [];
  const amount = Math.abs(t.amount_cents);
  if (t.category === "Needs category") gaps.push({ gap: "category", detail: "", keys: [] });
  if (!isSpend(t)) return gaps;

  const split = t.txn_allocations.reduce((s, a) => s + a.amount_cents, 0);
  if (!t.txn_allocations.length) gaps.push({ gap: "split", detail: "", keys: [] });
  else if (split !== amount) gaps.push({ gap: "split", detail: `the split adds up to ${fmtCents(split)} of ${fmtCents(amount)}`, keys: [] });

  if (t.kind === "charge" && !docs.length) {
    gaps.push({ gap: "receipt", detail: amount >= INVOICE_REQUIRED_CENTS ? "required for $300 and up" : "", keys: [`no-invoice:${t.id}`] });
  }
  if (t.kind === "charge" && !parts.length && !slack && REQUEST_CATEGORIES.has(t.category)) {
    gaps.push({ gap: "part", detail: "", keys: [`no-request:${t.id}`] });
  }

  // the same comparisons as the discrepancy checker, so waiving one waives both
  const diffs: string[] = [], keys: string[] = [];
  for (const e of docs) {
    if (e.total_cents === null || e.total_cents === amount || e.status.toLowerCase().includes("estimate")) continue;
    diffs.push(`${e.kind} says ${fmtCents(e.total_cents)}`);
    keys.push(`amount:${t.id}:${e.id}`);
  }
  if (parts.length) {
    const total = parts.reduce((s, r) => s + (r.total_cents ?? 0), 0);
    if (total !== amount) {
      diffs.push(`${parts.length === 1 ? "the part says" : `${parts.length} parts total`} ${fmtCents(total)}`);
      keys.push(`amount-airtable:${t.id}`);
    }
  }
  if (keys.length) gaps.push({ gap: "amount", detail: `${diffs.join(", ")}; charged ${fmtCents(amount)}`, keys });

  if (t.needs_review) gaps.push({ gap: "review", detail: t.review_note, keys: [`review:${t.id}`] });
  if (t.kind === "check" && !(t.notes.trim() || t.description.trim())) gaps.push({ gap: "reason", detail: "", keys: [`check-why:${t.id}`] });
  return gaps;
}

/** How many loose ends have each gap. */
export function gapCounts(ends: LooseEnd[]): Record<Gap, number> {
  const out = Object.fromEntries(GAPS.map((g) => [g, 0])) as Record<Gap, number>;
  for (const e of ends) for (const g of e.gaps) out[g.gap]++;
  return out;
}

/** The keys to store to waive every gap on a line that can be waived. */
export const waivableKeys = (e: LooseEnd): string[] => e.gaps.flatMap((g) => g.keys);
/** True if the only gaps left can be waived (no category or split still to fix). */
export const canWaiveAll = (e: LooseEnd): boolean => e.gaps.every((g) => g.keys.length > 0);
