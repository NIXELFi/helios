// Invoices, order emails and the parts list as evidence for the discrepancy
// checker. Pure: no database or desktop calls.

import { ORDERED_STATUSES, itemCost, type Item } from "../lib/api";
import type { Evidence } from "./discrepancies";
import type { EvidenceRow } from "./api";

export const itemEvidenceId = (i: Item) => -Number(i.code.replace(/\D/g, "") || 0);

/** Invoices and emails, plus every ordered parts-list item as a "request". */
export function evidenceFor(rows: EvidenceRow[], items: Item[], where: (projectId: string | null, subteamId: string | null) => string): Evidence[] {
  const docs: Evidence[] = rows.map((e) => ({
    id: e.id, kind: e.kind, source_file: e.source_file, vendor: e.vendor, order_ref: e.order_ref, date: e.date,
    total_cents: e.total_cents, items: e.items, where: where(e.project_id, e.subteam_id), status: e.status,
    payment_hint: e.payment_hint, record_type: e.record_type, flags: Array.isArray(e.flags) ? e.flags : [],
    txn_id: e.txn_id, match_method: e.match_method, object_path: e.object_path ?? null,
  }));
  const reqs: Evidence[] = items.filter((i) => ORDERED_STATUSES.has(i.status)).map((i) => {
    const a = i.item_allocations.length === 1 ? i.item_allocations[0] : undefined;
    return {
      id: itemEvidenceId(i), kind: "request", source_file: i.code, vendor: i.vendor, order_ref: i.vendor_order_id,
      date: i.ordered_at, total_cents: itemCost(i) || null, items: `${i.title} ${i.part_number} ${i.notes}`.trim(),
      where: a ? where(a.project_id, a.subteam_id) : "", status: "ORDERED", payment_hint: i.payment_method,
      record_type: "request", flags: [], txn_id: i.finance_txn_id ?? null, match_method: i.match_method ?? "", item_id: i.id,
    };
  });
  return [...docs, ...reqs];
}
