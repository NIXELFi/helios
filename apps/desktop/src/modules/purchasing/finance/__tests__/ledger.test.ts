import { describe, expect, it } from "vitest";
import {
  available, cardHeadroom, reconcile, splitEvenly, teamFunds,
  type Account, type BalanceEntry, type Reimbursement, type Txn,
} from "../ledger";
import { crc32, findDiscrepancies, type Evidence } from "../discrepancies";

// Ported from the standalone ledger's tests (tests/test_ledger.py).

const CHECKING: Account = { id: 1, name: "Chase Checking", kind: "checking", last4: null, holder: null, credit_limit_cents: null, paid_from_account_id: null, project_id: null, active: true, notes: "" };
const CARD: Account = { ...CHECKING, id: 2, name: "Card", kind: "credit_card", last4: "0000", credit_limit_cents: 5_000_00, paid_from_account_id: 1 };
const D = "2026-09-01";
let nextId = 1000;

function txn(p: Partial<Txn> & Pick<Txn, "amount_cents" | "kind">): Txn {
  return {
    id: nextId++, account_id: CARD.id, date: D, post_date: null, cleared_date: null, description: "", vendor: null,
    category: "Needs category", reference: null, status: "posted", transfer_group: null, needs_review: false, review_note: "",
    source: "test", statement_id: null, notes: "", allocation_basis: "", txn_allocations: [], ...p,
  };
}
const charge = (dollars: number, date = D, vendor: string | null = null, p: Partial<Txn> = {}) =>
  txn({ amount_cents: -Math.round(dollars * 100), kind: "charge", date, vendor, description: vendor ?? "", ...p });
const bal = (id: number, account_id: number, as_of: string, cents: number, p: Partial<BalanceEntry> = {}): BalanceEntry =>
  ({ id, account_id, as_of, balance_cents: cents, measure: "balance", confirmed: true, note: "", entered_by_name: "CFO", entered_at: "", ...p });
const owed = (cents: number | null, p: Partial<Reimbursement> = {}): Reimbursement => ({
  id: nextId++, person_name: "Member", user_id: null, amount_cents: cents, reason: "California trip", project_id: null, subteam_id: null,
  item_id: null, requested_date: null, status: "owed", denied_reason: "", check_number: null, check_txn_id: null, paid_date: null,
  notes: "", created_at: "", ...p,
});
const autopay = (cents: number, date: string) => [
  txn({ account_id: CHECKING.id, date, amount_cents: -cents, kind: "transfer", transfer_group: "g" }),
  txn({ account_id: CARD.id, date, amount_cents: cents, kind: "transfer", transfer_group: "g" }),
];

describe("ledger", () => {
  it("Available to spend counts the ASU accounts, cash box and GoFundMe on top of Chase's Available", () => {
    const deans: Account = { ...CHECKING, id: 3, name: "IC Dean's funding", kind: "university" };
    const gift: Account = { ...CHECKING, id: 4, name: "Foundation gift", kind: "university" };
    const box: Account = { ...CHECKING, id: 5, name: "Cash Box", kind: "holding" };
    const held: Account = { ...CHECKING, id: 6, name: "Old account", kind: "university", active: false };
    const gofund: Account = { ...CHECKING, id: 7, name: "GoFundMe", kind: "crowdfunding" };
    const entries = [bal(1, deans.id, D, 20_000_00), bal(2, gift.id, D, 5_000_00), bal(3, box.id, D, 300_00),
      bal(4, held.id, D, 9_999_00), bal(5, gift.id, "2026-09-05", 9_000_00, { confirmed: false })];
    // cash paid out of the cash box after it was counted
    const txns = [txn({ account_id: box.id, date: "2026-09-03", amount_cents: -50_00, kind: "withdrawal" })];
    const f = teamFunds(txns, entries, [CHECKING, CARD, deans, gift, box, held, gofund], CHECKING, 5_750_00, "2026-09-10");
    expect(f.others.map((o) => [o.account.name, o.balance_cents])).toEqual([
      ["IC Dean's funding", 20_000_00], ["Foundation gift", 5_000_00], ["Cash Box", 250_00], ["GoFundMe", null],
    ]);
    expect(f.others_cents).toBe(25_250_00);
    expect(f.total_cents).toBe(31_000_00);
    expect(teamFunds(txns, entries, [CHECKING, deans], CHECKING, null, D).total_cents).toBeNull();
  });

  it("the brief's worked example: $8,450 bank - $2,100 card - $600 owed = $5,750", () => {
    const s = available([charge(2100)], [bal(1, CHECKING.id, D, 8_450_00)], [owed(600_00)], CHECKING, [CARD], D);
    expect(s.bank_balance_cents).toBe(8_450_00);
    expect(s.card_owed_cents).toBe(2_100_00);
    expect(s.available_cents).toBe(5_750_00);
  });

  it("a reimbursement still being reviewed already counts as owed; paid and declined ones don't", () => {
    const s = available([], [bal(1, CHECKING.id, D, 1_000_00)],
      [owed(100_00, { status: "requested" }), owed(50_00, { status: "paid" }), owed(25_00, { status: "denied" })], CHECKING, [CARD], D);
    expect(s.reimbursements_owed_cents).toBe(100_00);
  });

  it("the card payment is a transfer, not spending, and is never counted twice", () => {
    const entries = [bal(1, CHECKING.id, D, 1_000_00)];
    const t2 = [charge(300), ...autopay(300_00, "2026-09-30")];
    expect(available(t2, entries, [], CHECKING, [CARD], "2026-09-29").available_cents).toBe(700_00);
    expect(available(t2, entries, [], CHECKING, [CARD], "2026-10-01").available_cents).toBe(700_00);
  });

  it("the card limit is per cycle and includes pending authorizations", () => {
    const closings = ["2026-08-25", "2026-09-25"];
    const txns = [charge(4788.60, "2026-09-10"), charge(40, "2026-09-27")];
    let h = cardHeadroom(txns, CARD, "2026-09-24", closings);
    expect(h.used_cents).toBe(4788_60);
    expect(h.level).toBe("danger");
    h = cardHeadroom(txns, CARD, "2026-09-28", closings);
    expect([h.posted_cents, h.pending_cents, h.used_cents]).toEqual([40_00, 0, 40_00]);
    const pn = bal(9, CARD.id, "2026-09-28", 4928_40, { measure: "available_credit" });
    h = cardHeadroom(txns, CARD, "2026-09-28", closings, [pn]);
    expect([h.pending_cents, h.remaining_cents]).toEqual([31_60, 4928_40]);
    const s = available(txns, [bal(1, CHECKING.id, D, 10_000_00), pn], [], CHECKING, [CARD], "2026-09-28", { [CARD.id]: closings });
    expect([s.card_owed_cents, s.card_pending_cents]).toEqual([4828_60, 31_60]);
    expect(s.available_cents).toBe(10_000_00 - 4828_60 - 31_60);
  });

  it("checks count when written and clear later", () => {
    const entries = [bal(1, CHECKING.id, D, 2_000_00)];
    const check = txn({ account_id: CHECKING.id, date: "2026-09-03", amount_cents: -250_00, kind: "check", reference: "1043" });
    let s = available([check], entries, [], CHECKING, [CARD], "2026-09-05");
    expect([s.bank_balance_cents, s.outstanding_checks_cents, s.available_cents]).toEqual([2_000_00, 250_00, 1_750_00]);
    check.cleared_date = "2026-09-10";
    s = available([check], entries, [], CHECKING, [CARD], "2026-09-12");
    expect([s.bank_balance_cents, s.outstanding_checks_cents, s.available_cents]).toEqual([1_750_00, 0, 1_750_00]);
  });

  it("weekly reconciliation shows the unexplained difference", () => {
    const entries = [bal(1, CHECKING.id, D, 5_000_00), bal(2, CHECKING.id, "2026-09-08", 4_880_00)];
    const rows = reconcile([txn({ account_id: CHECKING.id, date: "2026-09-04", amount_cents: 100_00, kind: "deposit" })], entries, CHECKING);
    expect(rows[0]!.difference_cents).toBeNull();
    expect(rows[1]!.computed_cents).toBe(5_100_00);
    expect(rows[1]!.difference_cents).toBe(-220_00);
  });

  it("split evenly sums exactly", () => {
    expect(splitEvenly(52_10, [7_25, 11_50, 14_00, 9_75]).reduce((a, b) => a + b, 0)).toBe(52_10);
  });
});

describe("discrepancies", () => {
  const ev = (p: Partial<Evidence>): Evidence => ({
    id: nextId++, kind: "invoice", source_file: "test", vendor: null, order_ref: null, date: null, total_cents: null, items: "",
    where: "", status: "", payment_hint: "", record_type: "", flags: [], txn_id: null, match_method: "", ...p,
  });

  it("flags an invoice that differs from the charge by $0.62", () => {
    const t = charge(51.20, "2026-09-02", "TBM Brakes");
    const found = findDiscrepancies([t], [ev({ kind: "email", vendor: "TBM Brakes", total_cents: 50_58, txn_id: t.id })], [], []);
    const d = found.find((x) => x.kind === "Amount differs from charge")!;
    expect(d.message).toContain("+$0.62");
    expect(d.severity).toBe("low");
  });

  it("flags two identical charges a day apart as a possible duplicate", () => {
    const a = charge(199, "2026-06-01", "Hotel");
    const b = charge(199, "2026-06-02", "Hotel");
    const found = findDiscrepancies([a, b], [], [], []);
    expect(found.find((x) => x.kind === "Possible duplicate")!.key).toBe(`dup:${a.id}:${b.id}`);
  });

  it("an invoice with no statement line is high unless it predates the statements", () => {
    const e = ev({ vendor: "Workshop Co", total_cents: 450_00, date: "2026-06-17" });
    expect(findDiscrepancies([], [e], [], [])[0]!.severity).toBe("high");
    expect(findDiscrepancies([], [e], [], [], "2026-07-01")[0]!.severity).toBe("medium");
  });

  it("small ordered parts with no charge are summarised per subteam", () => {
    const rows = [1, 2, 3].map((n) => ev({ id: -n, kind: "request", status: "ORDERED", total_cents: 5_00, where: "SDM27 Data AQ" }));
    const found = findDiscrepancies([], rows, [], []);
    expect(found).toHaveLength(1);
    expect(found[0]!.key).toBe("airtable-no-charge-group:Requests, SDM27 Data AQ:-1,-2,-3");
  });

  it("crc32 matches zlib", () => {
    expect(crc32("hello")).toBe(907060870);
  });
});

describe("running balance", () => {
  it("starts from the first statement balance, not zero", async () => {
    const { anchoredRunning } = await import("../ledger");
    const a = txn({ account_id: CHECKING.id, date: "2026-05-01", amount_cents: -100_00, kind: "withdrawal" });
    const b = txn({ account_id: CHECKING.id, date: "2026-05-03", amount_cents: 50_00, kind: "deposit" });
    const run = anchoredRunning([a, b], [CHECKING, CARD], [bal(1, CHECKING.id, "2026-04-30", 1_000_00)]);
    expect([run.get(a.id), run.get(b.id)]).toEqual([900_00, 950_00]);
  });
});
