import { describe, expect, it } from "vitest";
import { CHANGES_SOURCE, SNAPSHOT_SOURCE, buildSnapshot, planChanges, readChanges, readStatus, type PlanContext } from "../roundtrip";
import type { Item, Project, Subteam } from "../../lib/api";
import type { Category, EvidenceRow } from "../api";
import type { Account, Txn } from "../ledger";

const CAR: Project = { id: "car27", name: "SDM27", car_code: "SDM27", status: "active", program: "ic" };
const DAQ: Subteam = { id: "daq", name: "Data AQ", code: "DAQ", color: null, sort_order: 1 };
const OPS: Subteam = { id: "ops", name: "Operations", code: "OPS", color: null, sort_order: 2 };

function item(p: Partial<Item> & Pick<Item, "id" | "code" | "title" | "status">): Item {
  return {
    priority: "HIGH", requester_id: null, requester_name: "Lead", justification: "", needed_by: null, vendor: null, product_url: "",
    part_number: "", quantity: 1, unit_price_cents: null, tax_shipping_cents: null, total_estimate_cents: null, notes: "", ready_at: null,
    vendor_order_id: null, actual_total_cents: null, payment_method: "", ordered_at: null, carrier: "", tracking_number: "",
    est_delivery: null, created_at: "2026-09-01T00:00:00Z", finance_txn_id: null, item_allocations: [{ project_id: CAR.id, subteam_id: DAQ.id, percent: 100 }],
    ...p,
  };
}
function txn(p: Partial<Txn> & Pick<Txn, "id" | "amount_cents">): Txn {
  return {
    account_id: 2, date: "2026-09-10", post_date: null, cleared_date: null, description: "MOUSER ELECTRONICS", vendor: "Mouser", kind: "charge",
    category: "Needs category", reference: null, status: "posted", transfer_group: null, needs_review: false, review_note: "", source: "statement",
    statement_id: null, notes: "", allocation_basis: "", txn_allocations: [], ...p,
  };
}
const invoice = (p: Partial<EvidenceRow> & Pick<EvidenceRow, "id">): EvidenceRow => ({
  kind: "invoice", source_file: "", vendor: "TBM Brakes", vendor_raw: null, order_ref: null, date: null, total_cents: null, items: "",
  project_id: null, subteam_id: null, status: "", ship_to: "", payment_hint: "", link: "", record_type: "invoice", flags: [], txn_id: null,
  match_method: "", ...p,
});

const imu = item({ id: "i1", code: "SDM-0012", title: "IMU IC", status: "ORDERED", vendor: "Newark", total_estimate_cents: 4467 });
const adc = item({ id: "i2", code: "SDM-0003", title: "8 channel ADC", status: "READY", vendor: "Mouser" });
const mouser = txn({ id: 57, amount_cents: -1852 });
const big = txn({ id: 70, amount_cents: -15050, vendor: "McMaster-Carr" });
const categories: Category[] = [{ name: "Parts & materials", direction: "out", description: "" }, { name: "Needs category", direction: "out", description: "" }];

const ctx = (p: Partial<PlanContext> = {}): PlanContext => ({
  items: [imu, adc], projects: [CAR], subteams: [DAQ, OPS], txns: [mouser, big],
  vendors: [{ name: "TBM Brakes", aliases: ["TPM Breaks"], merchant_pattern: "", default_category: "", review_note: "" }],
  evidence: [invoice({ id: 12, order_ref: "T16273", total_cents: 7775 })], categories, override: false, ...p,
});
const one = (change: Record<string, unknown>, p: Partial<PlanContext> = {}) => planChanges([change], ctx(p))[0]!;

describe("reading a changes file", () => {
  it("accepts Claude's answer and turns away anything else with a plain reason", () => {
    const ok = readChanges(JSON.stringify({ source: CHANGES_SOURCE, based_on: "2026-10-15T10:00:00Z", summary: "Two shipments", changes: [{ op: "note", text: "hi" }, 5] }));
    expect(ok).toEqual({ basedOn: "2026-10-15T10:00:00Z", summary: "Two shipments", changes: [{ op: "note", text: "hi" }] });
    expect(() => readChanges(JSON.stringify({ source: SNAPSHOT_SOURCE }))).toThrow(/snapshot/);
    expect(() => readChanges("not json")).toThrow(/isn't JSON/);
    expect(() => readChanges(JSON.stringify({ changes: [] }))).toThrow(/isn't a changes file/);
  });

  it("reads statuses by name or by label", () => {
    expect(readStatus("shipped")).toBe("SHIPPED");
    expect(readStatus("Not ready to order")).toBe("PLANNED");
    expect(readStatus("teleported")).toBeNull();
  });
});

describe("planning changes", () => {
  it("marks a part shipped with its tracking, showing old and new", () => {
    const p = one({ op: "update_part", part: "SDM-0012", set: { status: "Shipped", carrier: "UPS", tracking_number: "1z 999 aa1 0123456784" }, why: "Newark email" });
    expect(p.problem).toBeNull();
    expect(p.title).toBe("SDM-0012 IMU IC");
    expect(p.lines).toEqual([
      { field: "Carrier", from: "(blank)", to: "UPS" },
      { field: "Tracking", from: "(blank)", to: "1Z999AA10123456784" },
      { field: "Status", from: "Ordered", to: "Shipped" },
    ]);
    expect(p.action).toEqual({ kind: "update_part", itemId: "i1", patch: { carrier: "UPS", tracking_number: "1Z999AA10123456784" }, status: "SHIPPED" });
  });

  it("finds parts by number however it's written, and says when nothing would change", () => {
    const p = one({ op: "update_part", part: "sdm12", set: { vendor: "Newark", status: "ORDERED" } });
    expect(p.nothing).toBe(true);
    expect(one({ op: "update_part", part: "SDM-9999", set: {} }).problem).toMatch(/no part SDM-9999/);
  });

  it("won't mark an unapproved part ordered, approve one, or reconcile one, except the CFO's in-person approval", () => {
    expect(one({ op: "update_part", part: "SDM-0003", set: { status: "ORDERED" } }).problem).toMatch(/hasn't been approved/);
    expect(one({ op: "update_part", part: "SDM-0003", set: { status: "ORDERED" } }, { override: true }).problem).toBeNull();
    expect(one({ op: "update_part", part: "SDM-0003", set: { status: "APPROVED" } }, { override: true }).problem).toMatch(/approved in the app/);
    expect(one({ op: "update_part", part: "SDM-0012", set: { status: "RECONCILED" } }).problem).toMatch(/link_part/);
  });

  it("reads money in dollars, keeps a fraction-of-a-cent unit price to the cent, and refuses junk", () => {
    const p = one({ op: "update_part", part: "SDM-0003", set: { unit_price: 0.305, charged: "$18.52", quantity: 16 } });
    expect(p.action).toMatchObject({ patch: { unit_price_cents: 31, actual_total_cents: 1852, quantity: 16 } });
    expect(one({ op: "update_part", part: "SDM-0003", set: { charged: "about ten" } }).problem).toMatch(/Not understood: charged/);
    expect(one({ op: "update_part", part: "SDM-0003", set: { colour: "red" } }).warnings[0]).toMatch(/colour/);
  });

  it("adds a bought part with its order details and charge, and skips one already there", () => {
    const p = one({
      op: "add_part", car: "sdm27", subteam: "data aq", title: "TVS diode", vendor: "Mouser", quantity: 16, unit_price: 0.305,
      status: "ORDERED", vendor_order_id: "40409253", ordered_on: "2026-09-09", charge: 57,
    }, { override: true });
    expect(p.problem).toBeNull();
    expect(p.action).toEqual({
      kind: "add_part", projectId: "car27", subteamId: "daq", status: "ORDERED", txnId: 57,
      row: { title: "TVS diode", vendor: "Mouser", quantity: 16, unit_price_cents: 31 },
      buyer: { vendor_order_id: "40409253", ordered_at: "2026-09-09" },
    });
    expect(one({ op: "add_part", car: "SDM27", subteam: "Data AQ", title: "imu ic" }).nothing).toBe(true);
    expect(one({ op: "add_part", car: "SDM27", subteam: "Data AQ", title: "x", status: "ORDERED" }).problem).toMatch(/Only the CFO/);
    expect(one({ op: "add_part", car: "SDM99", subteam: "Data AQ", title: "x" }).problem).toMatch(/isn't a car/);
  });

  it("records an invoice under the vendor list's spelling, once", () => {
    const p = one({ op: "add_invoice", vendor: "TPM Breaks", order_ref: "T16393", date: "9/2/2026", total: 43.71, items: "RIFE M5 cable", charge: 57 });
    expect(p.problem).toBeNull();
    expect(p.action).toMatchObject({ kind: "add_invoice", row: { vendor: "TBM Brakes", order_ref: "T16393", date: "2026-09-02", total_cents: 4371, txn_id: 57, match_method: "claude" } });
    const dup = one({ op: "add_invoice", vendor: "TBM Brakes", order_ref: "t16273", total: 77.75 });
    expect(dup.nothing).toBe(true);
    expect(one({ op: "add_invoice", vendor: "TBM Brakes", charge: 999, total: 1 }).problem).toMatch(/no ledger line #999/);
  });

  it("links and unlinks parts and invoices", () => {
    expect(one({ op: "link_part", part: "SDM-0012", charge: 57 }).action).toEqual({ kind: "link_part", itemId: "i1", txnId: 57 });
    expect(one({ op: "link_part", part: "SDM-0012", charge: null }).nothing).toBe(true);
    expect(one({ op: "link_invoice", invoice: 12, charge: 70 }).action).toEqual({ kind: "link_invoice", evidenceId: 12, txnId: 70 });
    expect(one({ op: "link_invoice", invoice: 12 }).problem).toMatch(/needs a charge/);
  });

  it("changes a charge's paperwork but never its amount or date", () => {
    const p = one({ op: "update_charge", charge: 57, set: { category: "parts & materials", amount: -1, date: "2026-01-01", notes: "ADC order" } });
    expect(p.action).toEqual({ kind: "update_charge", txnId: 57, fields: { category: "Parts & materials", notes: "ADC order" } });
    expect(p.warnings[0]).toMatch(/amount, date/);
    expect(one({ op: "update_charge", charge: 57, set: { category: "Snacks" } }).problem).toMatch(/categories/);
  });

  it("splits a charge only when the shares add up", () => {
    const ok = one({ op: "split_charge", charge: 70, split: [{ car: "SDM27", subteam: "Data AQ", amount: 120 }, { car: "Team", subteam: "Operations", amount: 30.5 }] });
    expect(ok.action).toEqual({ kind: "split_charge", txnId: 70, allocations: [
      { project_id: "car27", subteam_id: "daq", amount_cents: 12000 }, { project_id: null, subteam_id: "ops", amount_cents: 3050 }] });
    expect(one({ op: "split_charge", charge: 70, split: [{ car: "SDM27", subteam: "Data AQ", amount: 100 }] }).problem).toMatch(/adds up to \$100.00/);
    expect(one({ op: "split_charge", charge: 57, split: [{ car: "SDM27", subteam: "Data AQ" }] }).action)
      .toMatchObject({ allocations: [{ amount_cents: 1852 }] });
  });

  it("passes notes through and refuses ops it doesn't know", () => {
    expect(one({ op: "note", text: "Partzilla looks personal" })).toMatchObject({ note: "Partzilla looks personal", action: null, problem: null });
    expect(one({ op: "delete_everything" }).problem).toMatch(/doesn't know/);
  });
});

describe("the snapshot", () => {
  it("carries the instructions, dollars, and only the last four digits", () => {
    const account: Account = { id: 2, name: "SAE card", kind: "credit_card", last4: "1234", holder: "CFO", credit_limit_cents: 500000, paid_from_account_id: 1, project_id: null, active: true, notes: "" };
    const snap = buildSnapshot({
      items: [{ ...imu, finance_txn_id: 57 }], projects: [CAR], subteams: [DAQ, OPS], carSubteams: [{ project_id: CAR.id, subteam_id: DAQ.id }],
      vendors: [], accounts: [account], categories, txns: [mouser], evidence: [invoice({ id: 12, txn_id: 57, total_cents: 1852 })],
      reimbursements: [], looseEnds: [], exportedAt: "2026-10-15T10:00:00Z", exportedBy: "CFO",
    });
    expect(snap.source).toBe(SNAPSHOT_SOURCE);
    expect(snap.instructions_for_claude.join(" ")).toMatch(/agora-changes\.json/);
    expect(snap.cars).toEqual([{ car: "SDM27", name: "SDM27", program: "IC", subteams: ["Data AQ"] }]);
    expect(snap.parts[0]).toMatchObject({ part: "SDM-0012", car: "SDM27", subteam: "Data AQ", estimate: 44.67, charge: 57 });
    expect(snap.ledger[0]).toMatchObject({ charge: 57, amount: -18.52, account: "SAE card", parts: ["SDM-0012"], invoices: [12] });
    expect(snap.accounts[0]).toEqual({ account: "SAE card", kind: "credit_card", last4: "1234", holder: "CFO", credit_limit: 5000 });
  });
});
