import { describe, expect, it } from "vitest";
import {
  MULTIPLIER_CENTS, RISKS, ROW_OPTIONS,
  ballTrack, bucketChance, bucketOf, isValidPath, multiplierCents, payoutChips, pegRows, rtp,
  type Risk, type Rows,
} from "../games/plinko/logic";

describe("bucketOf", () => {
  it("is the number of rights taken", () => {
    expect(bucketOf("LLLLLLLL")).toBe(0);
    expect(bucketOf("RRRRRRRR")).toBe(8);
    expect(bucketOf("LRLRLRLR")).toBe(4);
  });
});

describe("isValidPath", () => {
  it("requires one decision per row", () => {
    expect(isValidPath("LRLRLRLR", 8)).toBe(true);
    expect(isValidPath("LRLRLRL", 8)).toBe(false);
    expect(isValidPath("LRLRLRLRL", 8)).toBe(false);
  });

  it("rejects anything that isn't L or R", () => {
    expect(isValidPath("LRLRLRLX", 8)).toBe(false);
    expect(isValidPath("", 8)).toBe(false);
  });
});

describe("payoutChips", () => {
  // Multipliers are integer HUNDREDTHS precisely so this arithmetic is exact
  // on both sides of the wire. A float multiplier would let JS and Postgres
  // numeric disagree by a chip on the half-way cases, and a payout that
  // doesn't match what the server wrote is a bug report every time.
  it("pays stake x multiplier, rounded to whole chips", () => {
    expect(payoutChips(100, 250)).toBe(250);
    expect(payoutChips(500, 21)).toBe(105);
    expect(payoutChips(5, 74)).toBe(4); // 3.7 -> 4
  });

  it("rounds a half chip up, the way Postgres round() does", () => {
    expect(payoutChips(350, 93)).toBe(326); // 325.5
    expect(payoutChips(50, 15)).toBe(8); // 7.5
  });

  it("never returns a fractional chip", () => {
    for (const stake of [1, 5, 7, 13, 99, 421, 500]) {
      for (const cents of [15, 21, 38, 74, 93, 99, 5000]) {
        expect(Number.isInteger(payoutChips(stake, cents))).toBe(true);
      }
    }
  });
});

describe("multiplier tables", () => {
  it("has one multiplier per bucket for every board", () => {
    for (const rows of ROW_OPTIONS) {
      for (const risk of RISKS) {
        expect(MULTIPLIER_CENTS[rows][risk]).toHaveLength(rows + 1);
      }
    }
  });

  it("is symmetric — the board doesn't favour a side", () => {
    for (const rows of ROW_OPTIONS) {
      for (const risk of RISKS) {
        const m = MULTIPLIER_CENTS[rows][risk];
        expect(m).toEqual([...m].reverse());
      }
    }
  });

  it("pays more the further from centre the ball lands", () => {
    // The centre is always the worst bucket. A table that ever dips outward
    // would make some middle bucket a jackpot, which isn't plinko.
    for (const rows of ROW_OPTIONS) {
      for (const risk of RISKS) {
        const m = MULTIPLIER_CENTS[rows][risk];
        for (let k = 0; k < rows / 2; k++) {
          expect(m[k]!).toBeGreaterThan(m[k + 1]!);
        }
      }
    }
  });

  it("gets swingier as risk rises", () => {
    for (const rows of ROW_OPTIONS) {
      expect(multiplierCents(rows, "high", 0)).toBeGreaterThan(multiplierCents(rows, "med", 0));
      expect(multiplierCents(rows, "med", 0)).toBeGreaterThan(multiplierCents(rows, "low", 0));
      const centre = rows / 2;
      expect(multiplierCents(rows, "high", centre)).toBeLessThan(multiplierCents(rows, "med", centre));
    }
  });
});

describe("bucketChance", () => {
  it("is the binomial distribution over the rows", () => {
    expect(bucketChance(8, 0)).toBeCloseTo(1 / 256, 12);
    expect(bucketChance(8, 4)).toBeCloseTo(70 / 256, 12);
    expect(bucketChance(16, 8)).toBeCloseTo(12870 / 65536, 12);
  });

  it("sums to one across every board", () => {
    for (const rows of ROW_OPTIONS) {
      let total = 0;
      for (let k = 0; k <= rows; k++) total += bucketChance(rows, k);
      expect(total).toBeCloseTo(1, 12);
    }
  });
});

describe("rtp", () => {
  // Pinned exactly: a typo in any multiplier moves these, which is the point.
  const EXPECTED: Record<Rows, Record<Risk, number>> = {
    8: { low: 0.9896875, med: 0.9890625, high: 0.98867188 },
    12: { low: 0.990332, med: 0.989033, high: 0.989863 },
    16: { low: 0.990512, med: 0.98982, high: 0.989057 },
  };

  it("matches the pinned return for every board", () => {
    for (const rows of ROW_OPTIONS) {
      for (const risk of RISKS) {
        expect(rtp(rows, risk)).toBeCloseTo(EXPECTED[rows][risk], 6);
      }
    }
  });

  it("keeps every board's house edge near 1%", () => {
    // Deliberately close to blackjack's ~1.1% chart edge, so choosing plinko
    // is a choice about variance rather than a trap that costs more.
    for (const rows of ROW_OPTIONS) {
      for (const risk of RISKS) {
        const edge = 1 - rtp(rows, risk);
        expect(edge).toBeGreaterThan(0.009);
        expect(edge).toBeLessThan(0.0115);
      }
    }
  });
});

describe("ballTrack", () => {
  it("starts at the centre and ends in the bucket it landed in", () => {
    const track = ballTrack("RRRRLLLL");
    expect(track).toHaveLength(9); // one position per row, plus the start
    expect(track[0]).toBe(4); // centre of an 8-row board
    expect(track[8]).toBe(bucketOf("RRRRLLLL"));
  });

  it("moves half a slot per row, so the ball never teleports", () => {
    const track = ballTrack("LRLRLRLRLRLRLRLR");
    for (let i = 1; i < track.length; i++) {
      expect(Math.abs(track[i]! - track[i - 1]!)).toBeCloseTo(0.5, 12);
    }
  });

  it("walks all the way left when every bounce is left", () => {
    expect(ballTrack("LLLLLLLL")).toEqual([4, 3.5, 3, 2.5, 2, 1.5, 1, 0.5, 0]);
  });
});

describe("pegRows", () => {
  it("is a triangle: one more peg each row down", () => {
    const rows = pegRows(8);
    expect(rows).toHaveLength(8);
    expect(rows.map((r) => r.length)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("centres each row over the board", () => {
    const rows = pegRows(8);
    for (const r of rows) {
      const mid = (r[0]! + r[r.length - 1]!) / 2;
      expect(mid).toBeCloseTo(4, 12);
    }
  });
});
