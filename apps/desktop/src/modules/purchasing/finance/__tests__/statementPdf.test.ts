import { describe, expect, it } from "vitest";
import { cardLines, checkingLines, parseCardWords, parseCheckingWords, pdfKind, StatementError, type Word } from "../statementPdf";

// Made-up statements, laid out the way Chase's PDFs are (words with positions).
const row = (top: number, cells: [number, string][]): Word[] =>
  cells.flatMap(([x, t]) => t.split(" ").map((w, i) => ({ text: w, x: x + i * 30, top })));

function cardPage(amountA = "21.40"): Word[] {
  return [
    ...row(20, [[40, "MEMO STATEMENT"]]),
    ...row(40, [[40, "STATEMENT DATE: 09-25-26"]]),
    ...row(60, [[40, "CARDHOLDER NAME: ALEX DOE CYCLE LIMIT: $4,000"]]),
    ...row(70, [[40, "XXXX-XX12-3456-0000"]]),
    ...row(100, [[40, "OTHER CHARGES"], [450, "$71.98"]]),
    ...row(115, [[40, "CREDITS"], [450, "$3.10"]]),
    ...row(130, [[40, "NET CHARGES"], [450, "$68.88"]]),
    ...row(200, [[40, "Purchasing Activity"]]),
    ...row(220, [[40, "09-21"], [80, "09-20"], [120, "123456789012345678"], [300, "MOUSER ELECTRONICS"], [520, amountA]]),
    ...row(230, [[200, "P.O.S.: 50112233"]]),
    ...row(250, [[40, "09-19"], [80, "09-18"], [120, "223456789012345678"], [300, "TBM BRAKES"], [520, "50.58"]]),
    ...row(270, [[40, "09-06"], [80, "09-05"], [120, "323456789012345678"], [300, "MOUSER ELECTRONICS"], [520, "3.10CR"]]),
    ...row(290, [[40, "Total Purchasing Activity"], [520, "68.88"]]),
  ];
}

function checkingPage(): Word[] {
  return [
    ...row(20, [[40, "Chase Business Complete Checking"]]),
    ...row(30, [[40, "August 01, 2026 through August 31, 2026"]]),
    ...row(50, [[397, "Account"], [427, "Number:"]]),
    ...row(46, [[460, "000000000001"]]),
    ...row(100, [[40, "Opening Ledger Balance"], [400, "$1,000.00"]]),
    ...row(115, [[40, "Deposits and Credits"], [295, "1"], [400, "500.00"]]),
    ...row(130, [[40, "Withdrawals and Debits"], [295, "1"], [400, "412.50"]]),
    ...row(145, [[40, "Checks Paid"], [295, "1"], [400, "250.00"]]),
    ...row(160, [[40, "Ending Ledger Balance"], [400, "$837.50"]]),
    ...row(200, [[40, "Deposits and Credits"]]),
    ...row(215, [[40, "08/26"], [100, "Orig CO Name:Square Inc"], [500, "500.00"]]),
    ...row(230, [[40, "Total"], [500, "$500.00"]]),
    ...row(260, [[40, "Withdrawals and Debits"]]),
    ...row(275, [[40, "08/24"], [100, "Comm Card Autopay"], [500, "412.50"]]),
    ...row(290, [[40, "Total"], [500, "$412.50"]]),
    ...row(320, [[40, "Checks Paid"]]),
    ...row(335, [[40, "08/28"], [100, "1043"], [500, "250.00"]]),
    ...row(350, [[40, "Total"], [500, "$250.00"]]),
    ...row(380, [[40, "Daily Balance"]]),
    ...row(395, [[40, "08/24"], [100, "587.50"], [200, "08/26"], [260, "1,087.50"], [360, "08/28"], [420, "837.50"]]),
  ];
}

describe("statement PDFs", () => {
  it("reads a card statement and checks it against its own totals", () => {
    const pages = [cardPage()];
    expect(pdfKind(pages)).toBe("chase-card");
    const st = parseCardWords(pages);
    expect(st).toMatchObject({ closing_date: "2026-09-25", last4: "0000", net_charges_cents: 6888 });
    expect(st.lines.map((l) => [l.txn_date, l.amount_cents, l.reference])).toEqual([
      ["2026-09-20", 2140, "50112233"], ["2026-09-18", 5058, "223456789012345678"], ["2026-09-05", -310, "323456789012345678"],
    ]);
    expect(cardLines(st).map((l) => l.amount_cents)).toEqual([-2140, -5058, 310]);
  });

  it("refuses a card statement whose rows don't add up", () => {
    expect(() => parseCardWords([cardPage("22.40")])).toThrow(StatementError);
  });

  it("reads a checking statement: sections, checks, daily balances, last four digits only", () => {
    const pages = [checkingPage()];
    expect(pdfKind(pages)).toBe("chase-checking");
    const st = parseCheckingWords(pages);
    expect(st).toMatchObject({ period_start: "2026-08-01", period_end: "2026-08-31", last4: "0001", opening_cents: 100000, ending_cents: 83750 });
    expect(st.daily_balances).toEqual([["2026-08-24", 58750], ["2026-08-26", 108750], ["2026-08-28", 83750]]);
    const lines = checkingLines(st);
    expect(lines.map((l) => [l.date, l.amount_cents, l.type, l.reference])).toEqual([
      ["2026-08-26", 50000, "DEPOSIT", null], ["2026-08-24", -41250, "WITHDRAWAL", null], ["2026-08-28", -25000, "CHECK_PAID", "1043"],
    ]);
  });
});
