import { describe, expect, it } from "vitest";
import { neutralEdges, optimalEV, referenceEV } from "../games/blackjack/ev";
import { hiLoValue, trueCount, type Card, type Rank } from "../games/blackjack/logic";
import {
  applySession,
  displayRating,
  expectedAdvantage,
  handAdvantage,
  impliedRating,
  kFactor,
  lineEV,
  sessionDelta,
  shoeEdge,
  CHART_EDGE,
  FULL_WEIGHT_HANDS,
  MAX_SESSION_DELTA,
  RATING_FLOOR,
  RATING_START,
  REFERENCE_EDGE,
  TIER,
  TIER_ADVANTAGE,
} from "../games/blackjack/rating";

function hand(...ranks: Rank[]): Card[] {
  return ranks.map((rank) => ({ rank, suit: "S" as const }));
}
const up = (rank: Rank): Card => ({ rank, suit: "H" });

/** A hand played flawlessly at the table minimum with a flat shoe — the
 *  reference case the whole ladder is calibrated against. */
function flatPerfectHand(playMargin: number) {
  return handAdvantage({
    stakeUnits: 1,
    bankrollFraction: 0.025,
    evLine: playMargin,
    evReference: 0,
    trueCountAtBet: 0,
  });
}

describe("calibration constants", () => {
  it("still match what the EV engine actually computes", () => {
    // If ev.ts ever changes, the ladder moves under everyone's feet. Pin it.
    const { optimal, reference } = neutralEdges();
    expect(optimal).toBeCloseTo(CHART_EDGE, 5);
    expect(reference).toBeCloseTo(REFERENCE_EDGE, 5);
    expect(optimal - reference).toBeCloseTo(TIER_ADVANTAGE, 5);
  });

  it("puts the house edge on the right side of zero for both policies", () => {
    expect(CHART_EDGE).toBeLessThan(0);
    expect(REFERENCE_EDGE).toBeLessThan(CHART_EDGE);
  });
});

describe("Hi-Lo count", () => {
  it("scores low cards +1, neutral cards 0, tens and aces -1", () => {
    for (const r of ["2", "3", "4", "5", "6"] as Rank[]) expect(hiLoValue({ rank: r, suit: "S" })).toBe(1);
    for (const r of ["7", "8", "9"] as Rank[]) expect(hiLoValue({ rank: r, suit: "S" })).toBe(0);
    for (const r of ["10", "J", "Q", "K", "A"] as Rank[]) expect(hiLoValue({ rank: r, suit: "S" })).toBe(-1);
  });

  it("balances to zero over a whole deck", () => {
    const ranks: Rank[] = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
    let sum = 0;
    for (const r of ranks) sum += 4 * hiLoValue({ rank: r, suit: "S" });
    expect(sum).toBe(0);
  });

  it("normalises the running count by decks remaining", () => {
    expect(trueCount(6, 3 * 52)).toBeCloseTo(2);
    expect(trueCount(6, 52)).toBeCloseTo(6);
  });

  it("refuses to divide by a sliver of a deck", () => {
    // Deep into the shoe a raw division would blow the count up; clamp at one
    // deck so the bet term can't be farmed on the last few cards.
    expect(trueCount(10, 4)).toBe(10);
  });
});

describe("shoeEdge", () => {
  it("is the chart player's edge at a flat count — negative", () => {
    expect(shoeEdge(0)).toBeCloseTo(CHART_EDGE);
    expect(shoeEdge(0)).toBeLessThan(0);
  });
  it("crosses into the player's favour as the shoe gets rich", () => {
    expect(shoeEdge(2)).toBeLessThan(0); // +2 isn't enough to beat the house
    expect(shoeEdge(4)).toBeGreaterThan(0);
    expect(shoeEdge(-4)).toBeLessThan(shoeEdge(0));
  });
  it("stops trusting the linear model out in the tail", () => {
    expect(shoeEdge(50)).toBe(shoeEdge(8));
  });
});

// The landmarks are the whole point: they're what makes the number mean
// something to a player rather than being an arbitrary score.
describe("ladder landmarks", () => {
  it("puts the reference player — mimic the dealer, flat minimum bet — at 1000", () => {
    // Playing exactly like the house rule means zero margin on every spot.
    const adv = flatPerfectHand(0);
    expect(adv.total).toBeCloseTo(0, 10);
    expect(impliedRating(adv.total)).toBeCloseTo(RATING_START, 6);
  });

  it("puts flawless flat-minimum chart play at 1400", () => {
    // A chart-perfect player's average margin over the reference IS
    // TIER_ADVANTAGE, by construction of the constants.
    const adv = flatPerfectHand(TIER_ADVANTAGE);
    expect(impliedRating(adv.total)).toBeCloseTo(RATING_START + TIER, 6);
  });

  it("settles a flawless flat bettor at 1400 and holds them there", () => {
    let rating = RATING_START;
    let handsRated = 0;
    for (let session = 0; session < 400; session++) {
      const hands = 30;
      const perHand = flatPerfectHand(TIER_ADVANTAGE).total;
      const applied = applySession({
        rating,
        handsRated,
        hands,
        totalAdvantage: perHand * hands,
      });
      rating = applied.rating;
      handsRated += hands;
    }
    expect(rating).toBeCloseTo(RATING_START + TIER, 0);
  });

  it("settles a reference-strength player back at 1000 from either direction", () => {
    for (const start of [400, 1900]) {
      let rating = start;
      for (let session = 0; session < 600; session++) {
        rating = applySession({
          rating,
          handsRated: 5000, // slowest K, so this is the hard case
          hands: 30,
          totalAdvantage: 0,
        }).rating;
      }
      expect(rating).toBeCloseTo(RATING_START, 0);
    }
  });
});

describe("handAdvantage — PLAY", () => {
  it("is exactly the margin over the reference at a minimum bet", () => {
    const adv = flatPerfectHand(0.2);
    expect(adv.play).toBeCloseTo(0.2);
  });

  it("ignores whether the hand was actually won", () => {
    // Same spot, same decisions, opposite results: handAdvantage never sees a
    // result at all, which is the entire fix for "my Elo only goes down".
    const a = flatPerfectHand(TIER_ADVANTAGE);
    const b = flatPerfectHand(TIER_ADVANTAGE);
    expect(a.total).toBe(b.total);
  });

  it("cancels deal luck: a gift hand pays nothing extra", () => {
    // Dealt 20 against a 6 — a huge EV spot, but the reference player stands
    // on it too, so the margin is zero and it earns no rating.
    const player = hand("K", "Q");
    const dealer = up("6");
    const margin = optimalEV(player, dealer) - referenceEV(player, dealer);
    expect(margin).toBeCloseTo(0, 10);
    expect(flatPerfectHand(margin).total).toBeCloseTo(0, 10);
  });

  it("pays for the hands where the chart and the house rule diverge", () => {
    // Standing on 15 vs a 6 is where a real player beats the mimic.
    const player = hand("10", "5");
    const dealer = up("6");
    const margin = optimalEV(player, dealer) - referenceEV(player, dealer);
    expect(flatPerfectHand(margin).total).toBeGreaterThan(TIER_ADVANTAGE);
  });

  it("punishes a blunder immediately and in proportion to the stake", () => {
    // Hitting a hard 20: evLost is enormous.
    const evOptimal = optimalEV(hand("K", "Q"), up("6"));
    const evLost = 1.4;
    const evLine = lineEV(evOptimal, evLost);
    const small = handAdvantage({
      stakeUnits: 1, bankrollFraction: 0.025, evLine,
      evReference: referenceEV(hand("K", "Q"), up("6")), trueCountAtBet: 0,
    });
    const big = handAdvantage({
      stakeUnits: 20, bankrollFraction: 0.5, evLine,
      evReference: referenceEV(hand("K", "Q"), up("6")), trueCountAtBet: 0,
    });
    expect(small.play).toBeLessThan(0);
    expect(big.play).toBeLessThan(small.play); // same mistake, more money on it
  });
});

describe("handAdvantage — BET", () => {
  it("is neutral at the table minimum, whatever the count", () => {
    for (const tc of [-6, 0, 3, 9]) {
      const adv = handAdvantage({
        stakeUnits: 1, bankrollFraction: 0.025, evLine: 0, evReference: 0, trueCountAtBet: tc,
      });
      expect(adv.bet).toBeCloseTo(0, 12);
    }
  });

  it("costs rating when you raise into a flat shoe", () => {
    const adv = handAdvantage({
      stakeUnits: 20, bankrollFraction: 0.1, evLine: 0, evReference: 0, trueCountAtBet: 0,
    });
    expect(adv.bet).toBeLessThan(0);
  });

  it("pays when you raise into a rich shoe", () => {
    const flat = handAdvantage({
      stakeUnits: 8, bankrollFraction: 0.1, evLine: 0, evReference: 0, trueCountAtBet: 0,
    });
    const rich = handAdvantage({
      stakeUnits: 8, bankrollFraction: 0.1, evLine: 0, evReference: 0, trueCountAtBet: 6,
    });
    expect(rich.bet).toBeGreaterThan(flat.bet);
  });

  it("makes the rating-optimal bet ramp the real one: raise iff the edge is positive", () => {
    // The property the whole design hangs on. For each count, find whether
    // advantage increases or decreases with stake, and check it agrees with
    // the sign of the player's actual edge at that count.
    const perfect = { bankrollFraction: 0.0, evLine: TIER_ADVANTAGE, evReference: 0 };
    for (const tc of [-6, -2, 0, 1, 2, 3, 4, 6]) {
      const min = handAdvantage({ ...perfect, stakeUnits: 1, trueCountAtBet: tc }).total;
      const max = handAdvantage({ ...perfect, stakeUnits: 16, trueCountAtBet: tc }).total;
      const edge = shoeEdge(tc);
      if (edge > 0) expect(max).toBeGreaterThan(min);
      else expect(max).toBeLessThan(min);
    }
  });

  it("lets a competent counter climb past a flawless flat bettor", () => {
    // Ramp to 8 units on the ~20% of hands where the count is good, minimum
    // otherwise, never misplaying.
    const counter =
      0.8 * handAdvantage({
        stakeUnits: 1, bankrollFraction: 0.025, evLine: TIER_ADVANTAGE, evReference: 0, trueCountAtBet: -1,
      }).total +
      0.2 * handAdvantage({
        stakeUnits: 8, bankrollFraction: 0.1, evLine: TIER_ADVANTAGE, evReference: 0, trueCountAtBet: 5,
      }).total;
    expect(impliedRating(counter)).toBeGreaterThan(RATING_START + TIER);
  });
});

describe("handAdvantage — RISK", () => {
  it("is free for a sane bet", () => {
    expect(handAdvantage({
      stakeUnits: 5, bankrollFraction: 0.1, evLine: 0, evReference: 0, trueCountAtBet: 0,
    }).risk).toBe(0);
  });

  it("finally gives ALL-IN a cost", () => {
    const sane = handAdvantage({
      stakeUnits: 5, bankrollFraction: 0.125, evLine: TIER_ADVANTAGE, evReference: 0, trueCountAtBet: 0,
    });
    const shove = handAdvantage({
      stakeUnits: 40, bankrollFraction: 1, evLine: TIER_ADVANTAGE, evReference: 0, trueCountAtBet: 0,
    });
    expect(sane.risk).toBe(0);
    expect(shove.risk).toBeLessThan(-0.1);
    expect(shove.total).toBeLessThan(sane.total);
    // ...even when the count is good. Ruin isn't priced by EV.
    const richShove = handAdvantage({
      stakeUnits: 40, bankrollFraction: 1, evLine: TIER_ADVANTAGE, evReference: 0, trueCountAtBet: 6,
    });
    expect(richShove.risk).toBeLessThan(-0.1);
  });

  it("grows faster than linearly past the safe fraction", () => {
    const at = (f: number) => -handAdvantage({
      stakeUnits: 10, bankrollFraction: f, evLine: 0, evReference: 0, trueCountAtBet: 0,
    }).risk;
    expect(at(0.35) - at(0.25)).toBeGreaterThan(at(0.25) - at(0.15));
  });
});

describe("handAdvantage — bounds", () => {
  it("never lets one hand run away with a session", () => {
    const disaster = handAdvantage({
      stakeUnits: 40, bankrollFraction: 1, evLine: -2, evReference: 0.8, trueCountAtBet: -8,
    });
    expect(disaster.total).toBeGreaterThanOrEqual(-0.6);
    const jackpot = handAdvantage({
      stakeUnits: 40, bankrollFraction: 0.1, evLine: 2, evReference: -1, trueCountAtBet: 8,
    });
    expect(jackpot.total).toBeLessThanOrEqual(0.6);
  });
});

describe("session update", () => {
  it("kills hit-and-run: a short hot session barely moves the needle", () => {
    const perHand = flatPerfectHand(TIER_ADVANTAGE).total;
    const short = sessionDelta({ rating: RATING_START, handsRated: 0, hands: 3, totalAdvantage: perHand * 3 });
    const full = sessionDelta({ rating: RATING_START, handsRated: 0, hands: 30, totalAdvantage: perHand * 30 });
    expect(short).toBeCloseTo(full * (3 / FULL_WEIGHT_HANDS), 6);
    expect(short).toBeLessThan(full / 5);
  });

  it("stops rewarding length past the full-weight mark", () => {
    const perHand = flatPerfectHand(TIER_ADVANTAGE).total;
    const at25 = sessionDelta({ rating: RATING_START, handsRated: 0, hands: 25, totalAdvantage: perHand * 25 });
    const at250 = sessionDelta({ rating: RATING_START, handsRated: 0, hands: 250, totalAdvantage: perHand * 250 });
    expect(at250).toBeCloseTo(at25, 6);
  });

  it("does nothing at all for a session with no settled hands", () => {
    expect(sessionDelta({ rating: 1234, handsRated: 10, hands: 0, totalAdvantage: 0 })).toBe(0);
  });

  it("gets harder to gain the higher you already are", () => {
    const perHand = flatPerfectHand(TIER_ADVANTAGE).total;
    const args = { handsRated: 0, hands: 30, totalAdvantage: perHand * 30 };
    expect(sessionDelta({ ...args, rating: 1300 })).toBeLessThan(sessionDelta({ ...args, rating: 1000 }));
    // At the equilibrium the same performance holds you still...
    expect(sessionDelta({ ...args, rating: 1400 })).toBeCloseTo(0, 6);
    // ...and above it, that same performance costs you.
    expect(sessionDelta({ ...args, rating: 1500 })).toBeLessThan(0);
  });

  it("slows down as a rating becomes established", () => {
    expect(kFactor(0)).toBeGreaterThan(kFactor(500));
    expect(kFactor(500)).toBeGreaterThan(kFactor(5000));
    const args = { rating: RATING_START, hands: 30, totalAdvantage: 0.05 * 30 };
    expect(Math.abs(sessionDelta({ ...args, handsRated: 0 })))
      .toBeGreaterThan(Math.abs(sessionDelta({ ...args, handsRated: 5000 })));
  });

  it("caps how far one session can swing a rating", () => {
    const wild = sessionDelta({ rating: RATING_START, handsRated: 0, hands: 100, totalAdvantage: -60 });
    expect(wild).toBe(-MAX_SESSION_DELTA);
  });

  it("never drops a rating through the floor, and reports the delta it really applied", () => {
    const applied = applySession({
      rating: RATING_FLOOR + 10, handsRated: 0, hands: 100, totalAdvantage: -60,
    });
    expect(applied.rating).toBe(RATING_FLOOR);
    expect(applied.delta).toBe(-10);
  });
});

describe("expectedAdvantage / impliedRating", () => {
  it("are inverses", () => {
    for (const r of [400, 1000, 1400, 2000]) {
      expect(impliedRating(expectedAdvantage(r))).toBeCloseTo(r, 6);
    }
  });
  it("ask nothing of a player sitting at the reference rating", () => {
    expect(expectedAdvantage(RATING_START)).toBe(0);
  });

  it("keep the displayed figure on the ladder", () => {
    // A hand thrown away on a big bet implies a deeply negative rating —
    // arithmetically true, useless on screen.
    const awful = handAdvantage({
      stakeUnits: 20, bankrollFraction: 0.9, evLine: -1.5, evReference: 0.4, trueCountAtBet: 0,
    }).total;
    expect(impliedRating(awful)).toBeLessThan(0);
    expect(displayRating(awful)).toBe(RATING_FLOOR);
    // Anything already on the ladder passes through untouched.
    expect(displayRating(TIER_ADVANTAGE)).toBeCloseTo(RATING_START + TIER, 6);
  });
});
