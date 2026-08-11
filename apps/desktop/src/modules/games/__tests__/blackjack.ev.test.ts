import { describe, expect, it } from "vitest";
import {
  actionEVs,
  bestAction,
  dealerDistribution,
  neutralEdges,
  optimalEV,
  referenceEV,
  standEV,
} from "../games/blackjack/ev";
import type { Card, Rank } from "../games/blackjack/logic";

function hand(...ranks: Rank[]): Card[] {
  return ranks.map((rank) => ({ rank, suit: "S" as const }));
}
const up = (rank: Rank): Card => ({ rank, suit: "H" });

describe("dealer distribution", () => {
  it("is a probability distribution for every upcard", () => {
    for (let u = 1; u <= 10; u++) {
      const dist = dealerDistribution(u);
      const sum = dist.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 10);
      expect(dist.every((p) => p >= 0)).toBe(true);
    }
  });

  // The canonical infinite-deck / stand-on-all-17s row, quoted to four
  // significant figures. An upcard of 2 can't make a natural, so there is no
  // conditioning to argue about and every bucket is directly comparable.
  it("reproduces the canonical dealer row for an upcard of 2", () => {
    const dist = dealerDistribution(2);
    const published = [0.1398, 0.1349, 0.1297, 0.1240, 0.1180, 0.3536];
    for (let i = 0; i < 6; i++) expect(dist[i]).toBeCloseTo(published[i]!, 3);
  });

  // Independent cross-check: the closed-form recursion above vs. a plain
  // simulation of the same rules. Two different methods agreeing to within
  // Monte Carlo error is far stronger evidence than any number recalled from
  // a strategy table.
  it("agrees with a Monte Carlo simulation of the same dealer rule", () => {
    // mulberry32 — deterministic so the test can't flake, and it stays in
    // 32-bit integer space (a textbook LCG's multiply blows past 2^53 in
    // float64 and quietly degenerates).
    let seed = 20260811;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    /** Infinite-deck draw: A=1 with p=1/13 … ten with p=4/13. */
    const drawCard = () => {
      const r = Math.floor(rnd() * 13) + 1; // 1..13
      return r >= 10 ? 10 : r;
    };
    const TRIALS = 120_000;
    for (let up = 1; up <= 10; up++) {
      let busts = 0;
      let played = 0;
      while (played < TRIALS) {
        const hole = drawCard();
        // The table settles naturals before anyone acts, so those deals are
        // not part of the conditioned distribution the engine reports.
        if ((up === 1 && hole === 10) || (up === 10 && hole === 1)) continue;
        played++;
        let hard = up + hole;
        let ace = up === 1 || hole === 1;
        for (;;) {
          const total = ace && hard + 10 <= 21 ? hard + 10 : hard;
          if (total >= 17) {
            if (total > 21) busts++;
            break;
          }
          const c = drawCard();
          hard += c;
          if (c === 1) ace = true;
        }
      }
      expect(busts / TRIALS).toBeCloseTo(dealerDistribution(up)[5]!, 2);
    }
  });

  it("a dealer showing an ace can no longer make 21 with two cards", () => {
    // Every remaining 21 needs three or more cards, so the mass at 21 drops
    // well below the ~31% an unconditioned ace upcard would carry.
    expect(dealerDistribution(1)[4]).toBeLessThan(0.2);
  });
});

describe("standEV", () => {
  it("is -1 on a bust regardless of the dealer", () => {
    expect(standEV(22, 6)).toBe(-1);
    expect(standEV(30, 1)).toBe(-1);
  });
  it("never falls as the player's total rises", () => {
    for (let u = 1; u <= 10; u++) {
      for (let t = 4; t < 21; t++) {
        expect(standEV(t + 1, u)).toBeGreaterThanOrEqual(standEV(t, u));
      }
    }
  });

  it("prices every stiff identically — standing only wins when the dealer busts", () => {
    for (let u = 1; u <= 10; u++) {
      const bust = dealerDistribution(u)[5]!;
      for (let t = 4; t <= 16; t++) {
        expect(standEV(t, u)).toBeCloseTo(bust - (1 - bust), 10);
      }
      // From 17 up you can actually beat or tie the dealer, so it strictly rises.
      for (let t = 17; t < 21; t++) {
        expect(standEV(t + 1, u)).toBeGreaterThan(standEV(t, u));
      }
    }
  });
  it("prices 20 as a strong hand and a stiff against a ten as a bad one", () => {
    expect(standEV(20, 6)).toBeGreaterThan(0.6);
    expect(standEV(16, 10)).toBeLessThan(-0.5);
  });
});

// The strongest check available: the engine's chosen action must reproduce
// the classic basic-strategy chart for these rules (S17, double any two, no
// split). Only unambiguous, non-marginal cells are asserted.
describe("bestAction reproduces basic strategy", () => {
  const cases: [string, Card[], Rank, "hit" | "stand" | "double"][] = [
    ["hard 8 vs 6 hits", hand("5", "3"), "6", "hit"],
    ["hard 9 vs 3 doubles", hand("5", "4"), "3", "double"],
    ["hard 10 vs 9 doubles", hand("6", "4"), "9", "double"],
    ["hard 11 vs 6 doubles", hand("7", "4"), "6", "double"],
    ["hard 12 vs 2 hits", hand("10", "2"), "2", "hit"],
    ["hard 12 vs 4 stands", hand("10", "2"), "4", "stand"],
    ["hard 13 vs 6 stands", hand("10", "3"), "6", "stand"],
    ["hard 15 vs 10 hits", hand("10", "5"), "10", "hit"],
    ["hard 16 vs 6 stands", hand("10", "6"), "6", "stand"],
    ["hard 16 vs 7 hits", hand("10", "6"), "7", "hit"],
    ["hard 17 vs ace stands", hand("10", "7"), "A", "stand"],
    ["hard 20 vs 6 stands", hand("K", "Q"), "6", "stand"],
    ["soft 17 vs 5 doubles", hand("A", "6"), "5", "double"],
    ["soft 18 vs 3 doubles", hand("A", "7"), "3", "double"],
    ["soft 18 vs 9 hits", hand("A", "7"), "9", "hit"],
    ["soft 19 vs 6 stands", hand("A", "8"), "6", "stand"],
    ["hard 11 vs ace hits under stand-on-soft-17", hand("7", "4"), "A", "hit"],
  ];
  for (const [name, player, dealer, expected] of cases) {
    it(name, () => {
      expect(bestAction(player, up(dealer), true).action).toBe(expected);
    });
  }

  it("never doubles once the hand has three cards", () => {
    expect(actionEVs(hand("5", "3", "3"), up("6"), false).double).toBeNull();
  });
});

describe("spot values", () => {
  it("prices a natural at 3:2", () => {
    expect(optimalEV(hand("A", "K"), up("6"))).toBeCloseTo(1.5, 10);
    expect(referenceEV(hand("A", "K"), up("6"))).toBeCloseTo(1.5, 10);
  });

  it("gives the reference player no ground to lose on a hand it plays the same way", () => {
    // Mimicking the dealer and playing the chart both stand on 20.
    expect(optimalEV(hand("K", "Q"), up("7"))).toBeCloseTo(referenceEV(hand("K", "Q"), up("7")), 10);
  });

  it("beats the reference exactly where the chart and the house rule disagree", () => {
    // Mimic hits every stiff; the chart stands on 15 against a dealer 6.
    const spot = [hand("10", "5"), up("6")] as const;
    expect(optimalEV(...spot) - referenceEV(...spot)).toBeGreaterThan(0.1);
    // Mimic never doubles; the chart doubles 11 against a 6.
    const dbl = [hand("7", "4"), up("6")] as const;
    expect(optimalEV(...dbl) - referenceEV(...dbl)).toBeGreaterThan(0.1);
  });

  it("never rates the reference above optimal play, on any spot", () => {
    const ranks: Rank[] = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10"];
    for (const a of ranks) {
      for (const b of ranks) {
        for (const u of ranks) {
          expect(optimalEV(hand(a, b), up(u))).toBeGreaterThanOrEqual(
            referenceEV(hand(a, b), up(u)) - 1e-12,
          );
        }
      }
    }
  });
});

describe("neutral edges", () => {
  // The exact values are pinned against rating.ts's hardcoded ladder
  // constants in blackjack.rating.test.ts; here we only assert their shape.
  it("prices the whole game for both policies", () => {
    const { optimal, reference } = neutralEdges();
    expect(optimal).toBeLessThan(0); // the house still wins; that's the point
    expect(reference).toBeLessThan(optimal);
  });

  it("lands the chart player near the published edge for these rules", () => {
    // ~-1.1%: worse than a textbook multi-deck -0.4% because this table has
    // no split, no surrender and no insurance.
    expect(neutralEdges().optimal).toBeGreaterThan(-0.02);
    expect(neutralEdges().optimal).toBeLessThan(-0.005);
  });

  it("leaves the mimic-the-dealer player several percent worse off", () => {
    const { optimal, reference } = neutralEdges();
    expect(optimal - reference).toBeGreaterThan(0.03);
    expect(optimal - reference).toBeLessThan(0.07);
  });
});
