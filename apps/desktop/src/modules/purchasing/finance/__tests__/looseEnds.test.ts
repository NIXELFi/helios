import { describe, expect, it } from "vitest";
import { canWaiveAll, gapCounts, looseEnds, waivableKeys } from "../looseEnds";
import type { Evidence } from "../discrepancies";
import type { Txn } from "../ledger";

let nextId = 1;
function txn(p: Partial<Txn> & Pick<Txn, "amount_cents" | "kind">): Txn {
  return {
    id: nextId++, account_id: 1, date: "2026-09-10", post_date: null, cleared_date: null, description: "", vendor: "Mouser",
    category: "Parts & materials", reference: null, status: "posted", transfer_group: null, needs_review: false, review_note: "",
    source: "test", statement_id: null, notes: "", allocation_basis: "", txn_allocations: [], ...p,
  };
}
const split = (cents: number) => [{ project_id: "car", subteam_id: "daq", amount_cents: cents }];
const ev = (p: Partial<Evidence> & Pick<Evidence, "kind" | "txn_id">): Evidence => ({
  id: nextId++, source_file: "", vendor: "Mouser", order_ref: null, date: "2026-09-09", total_cents: null, items: "", where: "",
  status: "", payment_hint: "", record_type: "", flags: [], match_method: "", ...p,
});

describe("loose ends", () => {
  it("lists what a bare charge is missing, and nothing for a squared-away one", () => {
    const bare = txn({ amount_cents: -1852, kind: "charge", category: "Needs category" });
    const done = txn({ amount_cents: -1852, kind: "charge", txn_allocations: split(1852) });
    const evidence = [ev({ kind: "invoice", txn_id: done.id, total_cents: 1852 }), ev({ kind: "request", txn_id: done.id, total_cents: 1852 })];
    const ends = looseEnds([bare, done], evidence, new Set());
    expect(ends.map((e) => e.txn.id)).toEqual([bare.id]);
    expect(ends[0]!.gaps.map((g) => g.gap)).toEqual(["category", "split", "receipt", "part"]);
    // category and split have to be fixed; the paperwork can be waived
    expect(canWaiveAll(ends[0]!)).toBe(false);
    expect(waivableKeys(ends[0]!)).toEqual([`no-invoice:${bare.id}`, `no-request:${bare.id}`]);
  });

  it("drops a gap once its discrepancy is resolved, so the two pages agree", () => {
    const t = txn({ amount_cents: -500, kind: "charge", category: "Travel: food", txn_allocations: split(500) });
    expect(looseEnds([t], [], new Set()).length).toBe(1);
    expect(looseEnds([t], [], new Set([`no-invoice:${t.id}`]))).toEqual([]);
  });

  it("flags an invoice or part total that differs from the charge (TBM: $43.71 vs $44.33)", () => {
    const t = txn({ amount_cents: -4433, kind: "charge", vendor: "TBM Brakes", txn_allocations: split(4433) });
    const evidence = [ev({ kind: "invoice", txn_id: t.id, total_cents: 4371 }), ev({ kind: "request", txn_id: t.id, total_cents: 4433 })];
    const [end] = looseEnds([t], evidence, new Set());
    expect(end!.gaps).toHaveLength(1);
    expect(end!.gaps[0]!.gap).toBe("amount");
    expect(end!.gaps[0]!.detail).toContain("$43.71");
    expect(end!.gaps[0]!.keys).toEqual([`amount:${t.id}:${evidence[0]!.id}`]);
  });

  it("checks that a split adds up to the charge", () => {
    const t = txn({ amount_cents: -1000, kind: "charge", txn_allocations: split(600) });
    const evidence = [ev({ kind: "invoice", txn_id: t.id, total_cents: 1000 }), ev({ kind: "request", txn_id: t.id, total_cents: 1000 })];
    const [end] = looseEnds([t], evidence, new Set());
    expect(end!.gaps.map((g) => [g.gap, g.detail])).toEqual([["split", "the split adds up to $6.00 of $10.00"]]);
  });

  it("leaves transfers and deposits alone once they have a category, and skips expected lines", () => {
    const pay = txn({ amount_cents: -210000, kind: "transfer", category: "Transfer: card payment" });
    const dues = txn({ amount_cents: 5000, kind: "deposit", category: "Dues" });
    const unsorted = txn({ amount_cents: 5000, kind: "deposit", category: "Needs category" });
    const autopay = txn({ amount_cents: -1000, kind: "charge", status: "expected" });
    const ends = looseEnds([pay, dues, unsorted, autopay], [], new Set());
    expect(ends.map((e) => [e.txn.id, e.gaps.map((g) => g.gap)])).toEqual([[unsorted.id, ["category"]]]);
  });

  it("asks why a check was written, and counts each gap", () => {
    const check = txn({ amount_cents: -6000, kind: "check", category: "Reimbursement", txn_allocations: split(6000), description: "" });
    const flagged = txn({ amount_cents: -999, kind: "charge", needs_review: true, review_note: "addressed to Jaxson", txn_allocations: split(999) });
    const ends = looseEnds([check, flagged], [ev({ kind: "invoice", txn_id: flagged.id, total_cents: 999 })], new Set());
    expect(ends.find((e) => e.txn.id === check.id)!.gaps.map((g) => g.gap)).toEqual(["reason"]);
    expect(gapCounts(ends)).toMatchObject({ reason: 1, review: 1, part: 1, receipt: 0 });
  });
});
