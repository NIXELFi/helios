import { describe, expect, it } from "vitest";
import { BET_FRACTION, MIN_BET, betRejection, maxBet } from "../money";

// The shared-money rules. These are duplicated in SQL (games.max_bet) and
// pinned against it by money.sql-parity.test.ts — the client copy exists so
// the cabinet can grey out chips without a round trip; the SQL copy is the one
// that counts.

describe("maxBet", () => {
  it("is 5% of the budget", () => {
    expect(BET_FRACTION).toBe(0.05);
    expect(maxBet(10_000)).toBe(500);
    expect(maxBet(8_420)).toBe(421);
  });

  it("rounds down, so a bet can never exceed the fraction", () => {
    expect(maxBet(199)).toBe(9); // 9.95 -> 9
  });

  it("floors at the table minimum so a poor subteam can still play", () => {
    // 5% of 99 is 4.95, which rounds down below the 5-chip table minimum.
    // Without the floor the subteam is hard-locked out rather than just poor.
    expect(maxBet(99)).toBe(MIN_BET);
    expect(maxBet(100)).toBe(MIN_BET);
  });

  it("never offers more than the budget actually holds", () => {
    expect(maxBet(3)).toBe(3);
    expect(maxBet(0)).toBe(0);
    expect(maxBet(-50)).toBe(0);
  });
});

describe("betRejection", () => {
  it("accepts a bet at exactly the cap", () => {
    expect(betRejection(500, 10_000)).toBeNull();
  });

  it("rejects a bet one chip over the cap", () => {
    expect(betRejection(501, 10_000)).toMatch(/5%|cap/i);
  });

  it("rejects non-integer and non-positive stakes", () => {
    expect(betRejection(2.5, 10_000)).toMatch(/whole/i);
    expect(betRejection(0, 10_000)).toMatch(/whole/i);
    expect(betRejection(-5, 10_000)).toMatch(/whole/i);
  });
});
