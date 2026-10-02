import { describe, expect, it } from "vitest";
import { runWhatIf, whatIfText, type WhatIfLine, type WhatIfStart } from "../whatif";

// Made-up figures.
const START: WhatIfStart = {
  available: 10_000_00,
  cards: { 8: { name: "Team card", remaining: 3_000_00 } },
  accounts: { 4: { name: "IC Dean's Funding", balance: 2_000_00 }, 6: { name: "Gift account", balance: null } },
  budgets: { eng: { name: "SDM27 Engine", remaining: 1_500_00 } },
};
let n = 0;
const line = (p: Partial<WhatIfLine>): WhatIfLine =>
  ({ id: String(n++), label: "x", cents: 0, direction: "out", paidFrom: "checking", budgetLine: null, on: true, ...p });

describe("what if", () => {
  it("applies each line in order, from checking, the card and other accounts", () => {
    const steps = runWhatIf(START, [
      line({ label: "Engine", cents: 1_200_00, paidFrom: "card:8", budgetLine: "eng" }),
      line({ label: "Trailer", cents: 800_00 }),
      line({ label: "Dyno time", cents: 1_500_00, paidFrom: "account:4" }),
      line({ label: "Sponsor check", cents: 2_500_00, direction: "in" }),
    ]);
    expect(steps.map((s) => s.available)).toEqual([8_800_00, 8_000_00, 8_000_00, 10_500_00]);
    expect(steps[0]!.card).toEqual({ name: "Team card", remaining: 1_800_00 });
    expect(steps[0]!.budget).toEqual({ name: "SDM27 Engine", remaining: 300_00 });
    expect(steps[2]!.account).toEqual({ name: "IC Dean's Funding", balance: 500_00 });
    expect(steps.flatMap((s) => s.warnings)).toEqual([]);
  });

  it("warns when a line goes over the card, a budget, an account, or the cushion", () => {
    const steps = runWhatIf(START, [
      line({ cents: 3_500_00, paidFrom: "card:8", budgetLine: "eng" }),
      line({ cents: 2_500_00, paidFrom: "account:4" }),
      line({ cents: 100_00, paidFrom: "account:6" }),
      line({ cents: 5_000_00 }),
      line({ cents: 2_000_00 }),
    ], 2_000_00);
    expect(steps[0]!.warnings).toEqual([
      "$500.00 over Team card's limit this cycle: split it across cycles or pay another way",
      "SDM27 Engine would be $2,000.00 over budget",
    ]);
    expect(steps[1]!.warnings).toEqual(["IC Dean's Funding would be $500.00 short"]);
    expect(steps[2]!.warnings[0]).toMatch(/no balance entered/);
    expect(steps[3]!.warnings).toEqual(["Available would drop below your $2,000.00 cushion"]);
    expect(steps[4]!.warnings).toEqual(["Available would be -$500.00: the team can't afford this yet"]);
  });

  it("skips unticked and empty lines, and doesn't change the starting figures", () => {
    const steps = runWhatIf(START, [line({ cents: 100_00, on: false }), line({ cents: 0 }), line({ cents: 50_00 })]);
    expect(steps).toHaveLength(1);
    expect(START.cards[8]!.remaining).toBe(3_000_00);
    expect(whatIfText(START, steps)).toBe("What if? Starting from Available $10,000.00\n- Spend $50.00: x -> Available $9,950.00");
  });
});
