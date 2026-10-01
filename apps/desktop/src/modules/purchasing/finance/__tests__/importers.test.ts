import { describe, expect, it } from "vitest";
import { parseCsv } from "../../lib/paste";
import {
  detectFormat, matchInvoice, normalizeVendor, parseChaseCard, parseChaseChecking, parseInvoices, parseSquare, planImport,
  type VendorRule,
} from "../importers";
import type { Account, Txn } from "../ledger";

// Made-up files in the shape the banks export.

const CHECKING: Account = { id: 1, name: "Chase Checking", kind: "checking", last4: "0001", holder: null, credit_limit_cents: null, paid_from_account_id: null, project_id: null, active: true, notes: "" };
const CARD: Account = { ...CHECKING, id: 2, name: "Team card", kind: "credit_card", last4: "0000", credit_limit_cents: 500000, paid_from_account_id: 1 };
const SQUARE: Account = { ...CHECKING, id: 3, name: "Square", kind: "holding", last4: null };
const RULES: VendorRule[] = [
  { name: "Mouser", aliases: ["Mouser Electronics"], merchant_pattern: "MOUSER", default_category: "Parts & materials", review_note: "" },
  { name: "TBM Brakes", aliases: ["TPM Breaks", "TBM Breaks"], merchant_pattern: "TBM BRAKES", default_category: "Parts & materials", review_note: "" },
];
let id = 500;
const txn = (p: Partial<Txn> & Pick<Txn, "account_id" | "date" | "amount_cents" | "kind">): Txn => ({
  id: id++, post_date: null, cleared_date: null, description: "", vendor: null, category: "Needs category", reference: null, status: "posted",
  transfer_group: null, needs_review: false, review_note: "", source: "test", statement_id: null, notes: "", allocation_basis: "", txn_allocations: [], ...p,
});
const opts = (existing: Txn[] = []) => ({ fileName: "export.csv", rules: RULES, accounts: [CHECKING, CARD, SQUARE], existing });

const checkingCsv = `Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #,
DEBIT,09/24/2026,"COMM CARD AUTOPAY 0000 PPD ID: 123",-412.50,ACH_DEBIT,11500.00,,
CREDIT,09/23/2026,"Square Inc 260923 L2 PPD ID: 999",120.00,ACH_CREDIT,11877.99,,
CHECK,09/22/2026,"CHECK 1043",-250.00,CHECK_PAID,11757.99,1043,
DSLIP,09/21/2026,"DEPOSIT  ID NUMBER 55",500.00,DEPOSIT,12007.99,,
DEBIT,09/21/2026,"ORIG CO NAME:VENMO PAYMENT",-20.00,ACH_DEBIT,11507.99,,
`;

describe("importers", () => {
  it("recognises each export by its header", () => {
    expect(detectFormat(parseCsv(checkingCsv)[0]!)).toBe("chase-checking");
    expect(detectFormat(["Transaction Date", "Post Date", "Description", "Category", "Type", "Amount", "Memo"])).toBe("chase-card");
    expect(detectFormat(["Date", "Time", "Gross Sales", "Fees", "Net Total", "Transaction ID"])).toBe("square");
    expect(detectFormat(["Vendor", "Date", "Order #", "Total"])).toBe("invoices");
    expect(detectFormat(["When", "What", "How much"])).toBe("generic");
  });

  it("checking: clears a written check, confirms the expected autopay, pairs the Square payout, keeps the bank's balance", () => {
    const written = txn({ account_id: 1, date: "2026-09-15", amount_cents: -25000, kind: "check", reference: "1043" });
    const expected = txn({ account_id: 1, date: "2026-10-01", amount_cents: -41250, kind: "transfer", status: "expected", transfer_group: "autopay:0000:2026-08-25" });
    const lines = parseChaseChecking(parseCsv(checkingCsv));
    expect(lines).toHaveLength(5);
    const plan = planImport("chase-checking", lines, CHECKING, opts([written, expected]));
    const by = (d: string) => plan.lines.find((p) => p.line.description.includes(d))!;
    expect(by("AUTOPAY")).toMatchObject({ action: "confirms-autopay", group: "autopay:0000:2026-08-25" });
    expect(by("CHECK 1043")).toMatchObject({ action: "clears-check", matchId: written.id });
    const sq = by("Square");
    expect(sq.action).toBe("add");
    expect(sq.txn).toMatchObject({ kind: "transfer", amount_cents: 12000 });
    expect(sq.pair).toMatchObject({ account_id: 3, amount_cents: -12000, transfer_group: sq.txn.transfer_group });
    expect(by("DEPOSIT").txn).toMatchObject({ kind: "deposit", needs_review: true });
    expect(by("VENMO").txn).toMatchObject({ kind: "withdrawal", vendor: "Venmo", needs_review: true });
    // newest row of each day is that day's closing balance
    expect(plan.balances.find((b) => b.as_of === "2026-09-21")!.balance_cents).toBe(1200799);
    expect(plan.balances.find((b) => b.as_of === "2026-09-24")!.balance_cents).toBe(1150000);
  });

  it("skips lines a statement PDF already brought in, and gives the same line the same key in every export", () => {
    const existing = txn({ account_id: 1, date: "2026-09-21", amount_cents: -2000, kind: "withdrawal" });
    const lines = parseChaseChecking(parseCsv(checkingCsv));
    const plan = planImport("chase-checking", lines, CHECKING, opts([existing]));
    expect(plan.lines.find((p) => p.line.description.includes("VENMO"))!.action).toBe("duplicate");
    const again = planImport("chase-checking", lines, CHECKING, opts());
    expect(again.lines.map((p) => p.txn.source_key)).toEqual(planImport("chase-checking", lines, CHECKING, opts()).lines.map((p) => p.txn.source_key));
  });

  it("a different charge that costs the same isn't taken for a duplicate", () => {
    const lines = parseChaseChecking(parseCsv(checkingCsv));
    // an earlier export of the same format: exact keys catch repeats, so a near match is a new purchase
    const sameFormat = txn({ account_id: 1, date: "2026-09-20", amount_cents: -2000, kind: "withdrawal", source: "chase-checking", source_key: "chase-checking:1:2026-09-20:-2000:abc:1", description: "VENMO PAYMENT" });
    expect(planImport("chase-checking", lines, CHECKING, opts([sameFormat])).lines.find((p) => p.line.description.includes("VENMO"))!.action).toBe("add");
    // from a PDF, two days apart, but a different merchant
    const otherMerchant = txn({ account_id: 1, date: "2026-09-19", amount_cents: -2000, kind: "withdrawal", source: "chase-checking-pdf", description: "ZELLE TO SAM" });
    expect(planImport("chase-checking", lines, CHECKING, opts([otherMerchant])).lines.find((p) => p.line.description.includes("VENMO"))!.action).toBe("add");
    const pdfVenmo = { ...otherMerchant, id: 9001, description: "Venmo payment 1234" };
    expect(planImport("chase-checking", lines, CHECKING, opts([pdfVenmo])).lines.find((p) => p.line.description.includes("VENMO"))!.action).toBe("duplicate");
  });

  it("a statement PDF and a CSV export of the same lines never both get added", () => {
    const lines = parseChaseChecking(parseCsv(checkingCsv));
    // the CSV went in first; now the PDF of the same month (same parser output, PDF source)
    const csv = planImport("chase-checking", lines, CHECKING, opts());
    const csvRows = csv.lines.map((p, i) => txn({ ...p.txn, id: 7000 + i } as Partial<Txn> & Pick<Txn, "account_id" | "date" | "amount_cents" | "kind">));
    const pdf = planImport("chase-checking", lines, CHECKING, { ...opts(csvRows), source: "chase-checking-pdf" });
    expect(pdf.lines.every((p) => p.action !== "add")).toBe(true);
    expect(pdf.lines[0]!.txn.source_key.startsWith("chase-checking-pdf:1:")).toBe(true);
    // and the other way round
    const pdfRows = planImport("chase-checking", lines, CHECKING, { ...opts(), source: "chase-checking-pdf" }).lines
      .map((p, i) => txn({ ...p.txn, id: 8000 + i } as Partial<Txn> & Pick<Txn, "account_id" | "date" | "amount_cents" | "kind">));
    expect(planImport("chase-checking", lines, CHECKING, opts(pdfRows)).lines.every((p) => p.action !== "add")).toBe(true);
  });

  it("an autopay that differs from what was expected confirms it with the amount actually paid", () => {
    const expected = txn({ account_id: 1, date: "2026-10-01", amount_cents: -40000, kind: "transfer", status: "expected", transfer_group: "autopay:0000:2026-08-25" });
    const plan = planImport("chase-checking", parseChaseChecking(parseCsv(checkingCsv)), CHECKING, opts([expected]));
    expect(plan.lines.find((p) => p.line.description.includes("AUTOPAY"))).toMatchObject({
      action: "confirms-autopay", group: "autopay:0000:2026-08-25", amount_cents: 41250,
    });
  });

  it("card: charges get their vendor and category; a statement closing sets up the expected autopay", () => {
    const csv = `Transaction Date,Post Date,Description,Category,Type,Amount,Memo
09/20/2026,09/21/2026,MOUSER ELECTRONICS,Shopping,Sale,-21.40,
09/18/2026,09/19/2026,TBM BRAKES,Automotive,Sale,-50.58,
09/10/2026,09/10/2026,AUTOMATIC PAYMENT - THANK YOU,,Payment,412.50,
09/05/2026,09/06/2026,MOUSER ELECTRONICS,Shopping,Return,3.10,`;
    const lines = parseChaseCard(parseCsv(csv));
    const plan = planImport("chase-card", lines, CARD, { ...opts(), cardStatement: { periodStart: "2026-08-26", closing: "2026-09-25" } });
    expect(plan.lines.map((p) => [p.txn.kind, p.txn.vendor, p.txn.category])).toEqual([
      ["charge", "Mouser", "Parts & materials"], ["charge", "TBM Brakes", "Parts & materials"],
      ["transfer", "Chase card autopay", "Transfer: card payment"], ["credit", "Mouser", "Parts & materials"],
    ]);
    expect(plan.statement).toMatchObject({ closing_date: "2026-09-25", net_charges_cents: 2140 + 5058 - 310 });
    expect(plan.extra.map((t) => [t.account_id, t.amount_cents, t.status, t.date])).toEqual([
      [1, -6888, "expected", "2026-10-23"], [2, 6888, "expected", "2026-10-23"],
    ]);
  });

  it("square: payments count as dues, fees as bank fees, and earlier Chase payouts get their Square half", () => {
    const csv = `Date,Time,Gross Sales,Total Collected,Fees,Net Total,Transaction ID,Customer Name,Description,Event Type
2026-09-02,10:00,$50.00,$50.00,-$1.75,$48.25,T1,Alex Doe,Fall dues,Payment
2026-09-03,11:00,$50.00,$50.00,-$1.75,$48.25,T2,Sam Roe,Fall dues,Payment`;
    const lines = parseSquare(parseCsv(csv));
    expect(lines.map((l) => l.amount_cents)).toEqual([5000, -175, 5000, -175]);
    const payout = txn({ account_id: 1, date: "2026-09-05", amount_cents: 9650, kind: "transfer", vendor: "Square", transfer_group: "g1" });
    const plan = planImport("square", lines, SQUARE, { ...opts([payout]), squareCategory: "Dues" });
    expect(plan.lines.map((p) => [p.txn.kind, p.txn.category])).toEqual([["deposit", "Dues"], ["fee", "Bank fees"], ["deposit", "Dues"], ["fee", "Bank fees"]]);
    expect(plan.lines[0]!.txn.source_key).toBe("square:3:T1");
    expect(plan.extra).toEqual([expect.objectContaining({ account_id: 3, amount_cents: -9650, transfer_group: "g1" })]);
  });

  it("invoices: vendor spellings are fixed and each invoice finds its one charge", () => {
    expect(normalizeVendor("TPM Breaks", RULES)).toBe("TBM Brakes");
    const inv = parseInvoices(parseCsv(`Vendor,Date,Order #,Total\nTPM Breaks,9/2/2026,T20001,50.58`), RULES);
    const charge = txn({ account_id: 2, date: "2026-09-03", amount_cents: -5058, kind: "charge", vendor: "TBM Brakes" });
    const other = txn({ account_id: 2, date: "2026-09-30", amount_cents: -5058, kind: "charge", vendor: "Amazon" });
    expect(matchInvoice(inv[0]!, [charge, other], new Set(), RULES)?.id).toBe(charge.id);
  });
});
