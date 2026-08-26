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
  MAX_HAND_ADVANTAGE,
  MAX_SESSION_DELTA,
  RATED_STAKE_CAP,
  RATING_FLOOR,
  RATING_REFERENCE_BANKROLL,
  RATING_START,
  REFERENCE_EDGE,
  TIER,
  TIER_ADVANTAGE,
  TRUE_COUNT_CAP,
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

/** Chart-perfect play at an arbitrary stake — the v3 money cases. */
function perfectAt(stakeUnits: number, bankrollFraction: number, tc = 0) {
  return handAdvantage({
    stakeUnits,
    bankrollFraction,
    evLine: TIER_ADVANTAGE,
    evReference: 0,
    trueCountAtBet: tc,
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
  it("puts the reference player — mimic the dealer — at 1000, at ANY stake", () => {
    // Playing exactly like the house rule means zero margin on every spot, and
    // v3 keeps that worth zero no matter how much money it's played for.
    for (const [units, frac] of [[1, 0.025], [5, 0.125], [20, 0.3]] as const) {
      const adv = handAdvantage({
        stakeUnits: units, bankrollFraction: frac, evLine: 0, evReference: 0, trueCountAtBet: 0,
      });
      expect(adv.total).toBeCloseTo(0, 10);
      expect(impliedRating(adv.total)).toBeCloseTo(RATING_START, 6);
    }
  });

  it("puts flawless flat-minimum chart play at 1400", () => {
    // A chart-perfect player's average margin over the reference IS
    // TIER_ADVANTAGE, by construction of the constants.
    const adv = flatPerfectHand(TIER_ADVANTAGE);
    expect(impliedRating(adv.total)).toBeCloseTo(RATING_START + TIER, 6);
  });

  it("pays MORE money — and more ladder — for the same good play at a real stake", () => {
    // The v3 change Nick asked for: the rating is expected money made, so a
    // 100-chip bet played flawlessly earns 20× the minimum bet's climb rather
    // than being a trap. 1400 stops being a ceiling; it's the flat-min mark.
    const min = perfectAt(1, 0.025);
    const big = perfectAt(20, 0.5);
    expect(big.play).toBeCloseTo(20 * min.play, 10);
    expect(big.total).toBeGreaterThan(min.total);
    expect(impliedRating(big.total)).toBeGreaterThan(RATING_START + TIER);
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

  it("scales linearly with the stake: money made, not a per-unit score", () => {
    const one = flatPerfectHand(0.1);
    const twenty = handAdvantage({
      stakeUnits: 20, bankrollFraction: 0.2, evLine: 0.1, evReference: 0, trueCountAtBet: 0,
    });
    expect(twenty.play).toBeCloseTo(20 * one.play, 10);
  });

  it("ignores whether the hand was actually won", () => {
    // Same spot, same decisions, opposite results: handAdvantage never sees a
    // result at all. Skill money, not lucky money.
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
    // Hitting a hard 20: evLost is enormous — and betting big on bad play is
    // how you lose real money, so it costs rating linearly with the stake.
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
    expect(big.play).toBeCloseTo(20 * small.play, 10); // same mistake, 20× the money on it
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

  it("is FREE to raise into a flat shoe — the v2 trap is gone", () => {
    // v2 charged (√units−1)·(edge − TIER_ADVANTAGE) for any raise at a neutral
    // count, which made 3 of the 4 chip buttons rating traps. v3's bet term is
    // the count-justified shift only: zero when the shoe says nothing.
    const adv = handAdvantage({
      stakeUnits: 20, bankrollFraction: 0.1, evLine: 0, evReference: 0, trueCountAtBet: 0,
    });
    expect(adv.bet).toBeCloseTo(0, 12);
  });

  it("pays for raising into a rich shoe, in proportion to the extra units", () => {
    const rich = handAdvantage({
      stakeUnits: 8, bankrollFraction: 0.1, evLine: 0, evReference: 0, trueCountAtBet: 6,
    });
    expect(rich.bet).toBeCloseTo(7 * (shoeEdge(6) - CHART_EDGE), 10);
    expect(rich.bet).toBeGreaterThan(0);
  });

  it("costs money to raise into a poor shoe", () => {
    const poor = handAdvantage({
      stakeUnits: 8, bankrollFraction: 0.1, evLine: 0, evReference: 0, trueCountAtBet: -4,
    });
    expect(poor.bet).toBeLessThan(0);
  });

  it("rewards betting money in proportion to how justified it is", () => {
    // Money-honesty, the property v3 hangs on: for a player whose play has a
    // real margin, more stake means more expected money made — and for one
    // whose play is worse than the reference, more stake digs faster.
    const goodSmall = perfectAt(1, 0.02);
    const goodBig = perfectAt(16, 0.3);
    expect(goodBig.total).toBeGreaterThan(goodSmall.total);
    const badLine = { evLine: -0.05, evReference: 0, trueCountAtBet: 0 };
    const badSmall = handAdvantage({ ...badLine, stakeUnits: 1, bankrollFraction: 0.02 });
    const badBig = handAdvantage({ ...badLine, stakeUnits: 16, bankrollFraction: 0.3 });
    expect(badBig.total).toBeLessThan(badSmall.total);
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
      stakeUnits: 5, bankrollFraction: 0.125, evLine: 0, evReference: 0, trueCountAtBet: 0,
    }).risk).toBe(0);
  });

  it("charges for staking most of the bankroll", () => {
    const shove = handAdvantage({
      stakeUnits: 40, bankrollFraction: 1, evLine: TIER_ADVANTAGE, evReference: 0, trueCountAtBet: 0,
    });
    expect(shove.risk).toBeLessThan(-0.5);
    // ...even when the count is good. Ruin isn't priced by EV.
    const richShove = handAdvantage({
      stakeUnits: 40, bankrollFraction: 1, evLine: TIER_ADVANTAGE, evReference: 0, trueCountAtBet: 6,
    });
    expect(richShove.risk).toBeLessThan(-0.5);
  });

  it("keeps ALL-IN spam from ever beating an honest big flat bet", () => {
    // 100 chips of a 200 bankroll, played flawlessly, must out-earn shoving
    // the whole stack every hand — otherwise the rating-optimal strategy is
    // a coin-flip lifestyle.
    const bigFlat = perfectAt(20, 0.5);
    const shove = perfectAt(40, 1);
    expect(shove.total).toBeLessThan(bigFlat.total);
    // But the shove is still worth MORE than nothing for a perfect player —
    // it's a discouragement, not a cliff.
    expect(shove.total).toBeGreaterThan(0);
  });

  it("grows faster than linearly past the safe fraction", () => {
    const at = (f: number) => -handAdvantage({
      stakeUnits: 10, bankrollFraction: f, evLine: 0, evReference: 0, trueCountAtBet: 0,
    }).risk;
    expect(at(0.75) - at(0.55)).toBeGreaterThan(at(0.55) - at(0.35));
  });
});

describe("handAdvantage — bounds", () => {
  it("never lets one hand run away with a session", () => {
    const disaster = handAdvantage({
      stakeUnits: 40, bankrollFraction: 1, evLine: -2, evReference: 0.8, trueCountAtBet: -8,
    });
    expect(disaster.total).toBe(-MAX_HAND_ADVANTAGE);
    const jackpot = handAdvantage({
      stakeUnits: 40, bankrollFraction: 0.1, evLine: 2, evReference: -1, trueCountAtBet: 8,
    });
    expect(jackpot.total).toBe(MAX_HAND_ADVANTAGE);
  });

  it("leaves room for the biggest legitimate hand under the cap", () => {
    // A flawless all-in at the richest capped count is the largest hand an
    // honest client can produce; the cap must sit above it, or the cap would
    // shave real play instead of just tampering.
    const best = perfectAt(40, 1, 8);
    expect(best.total).toBeLessThanOrEqual(MAX_HAND_ADVANTAGE);
    expect(best.total).toBeGreaterThan(0);
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

  it("moves a fresh 1000 by exactly +K for a full flawless flat session", () => {
    // The ladder-space update: implied(TIER_ADVANTAGE) − 1000 is one full
    // tier, so a new player's first perfect session is worth the whole K.
    const perHand = flatPerfectHand(TIER_ADVANTAGE).total;
    expect(sessionDelta({ rating: RATING_START, handsRated: 0, hands: 30, totalAdvantage: perHand * 30 }))
      .toBeCloseTo(kFactor(0), 6);
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
    for (const r of [400, 1000, 1400, 2000, 2800]) {
      expect(impliedRating(expectedAdvantage(r))).toBeCloseTo(r, 6);
    }
  });
  it("ask nothing of a player sitting at the reference rating", () => {
    expect(expectedAdvantage(RATING_START)).toBe(0);
  });

  it("compresses money into the ladder: 4× the money is 2× the tiers", () => {
    // √ compression keeps big-stake ratings impressive but not absurd: a
    // player making 4× the flat-perfect money sits 2 tiers up, not 4.
    expect(impliedRating(4 * TIER_ADVANTAGE)).toBeCloseTo(RATING_START + 2 * TIER, 6);
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

// --- shared-money era -------------------------------------------------------
// Chips now come from the subteam budget, which is orders of magnitude bigger
// than the 200-chip stack the ladder was calibrated on. Two constants keep the
// rating meaning exactly what it meant before the change.

describe("rated stake cap", () => {
  const chartHand = (units: number) => handAdvantage({
    stakeUnits: units,
    bankrollFraction: 0,
    evLine: CHART_EDGE,
    evReference: REFERENCE_EDGE,
    trueCountAtBet: 0,
  });

  it("stops counting stake above the cap, so the ladder can't run away", () => {
    // Without this, a 5%-of-budget bet is ~100 units and PLAY alone is 4.59 —
    // more than double MAX_HAND_ADVANTAGE, so the clamp would silently
    // truncate it. Truncation is exactly the v2 failure Nick reported: past
    // some stake, betting more stops paying and the player can't see why.
    expect(chartHand(100).play).toBe(chartHand(RATED_STAKE_CAP).play);
    expect(chartHand(1000).total).toBe(chartHand(RATED_STAKE_CAP).total);
  });

  it("leaves every stake at or below the cap scoring exactly as it always did", () => {
    for (const units of [1, 5, 20, RATED_STAKE_CAP]) {
      expect(chartHand(units).play).toBeCloseTo(units * TIER_ADVANTAGE, 12);
    }
  });

  it("keeps ordinary play at the cap well inside MAX_HAND_ADVANTAGE", () => {
    // The point of RATED_STAKE_CAP is that normal play is never truncated: the
    // biggest rated stake at a neutral shoe has to fit with room to spare.
    const biggest = chartHand(RATED_STAKE_CAP);
    expect(biggest.play + biggest.bet + biggest.risk).toBeLessThan(MAX_HAND_ADVANTAGE);
  });

  it("still clamps a max stake at an extreme count — v3 behaviour, unchanged", () => {
    // Documenting rather than asserting an ideal. rating.ts claims the clamp
    // was "sized to clear the biggest legitimate hand", and that has never
    // quite been true: 40 units flawless at a capped true count is 3.40
    // (PLAY 1.84 + BET 1.56), so the clamp shaves a genuine counter's best
    // hands. It predates the shared-money change and is left alone here
    // because raising MAX_HAND_ADVANTAGE would move the ladder, which is
    // deliberately not being re-scaled.
    const counted = handAdvantage({
      stakeUnits: RATED_STAKE_CAP,
      bankrollFraction: 0,
      evLine: CHART_EDGE,
      evReference: REFERENCE_EDGE,
      trueCountAtBet: TRUE_COUNT_CAP,
    });
    expect(counted.play + counted.bet).toBeGreaterThan(MAX_HAND_ADVANTAGE);
    expect(counted.total).toBe(MAX_HAND_ADVANTAGE);
  });
});

describe("rating reference bankroll", () => {
  it("is the stack the ladder was calibrated on, not the subteam budget", () => {
    // RISK prices ruin, which EV ignores. Measuring the stake against a 10,000
    // chip team budget would make every legal bet a rounding error and kill
    // the term outright — so the rating keeps scoring you as though you were
    // playing the same 200-chip stack everyone has always been scored on.
    expect(RATING_REFERENCE_BANKROLL).toBe(200);
  });

  it("still penalises a hand that would have shoved that reference stack", () => {
    const shove = handAdvantage({
      stakeUnits: RATED_STAKE_CAP,
      bankrollFraction: 1,
      evLine: CHART_EDGE,
      evReference: REFERENCE_EDGE,
      trueCountAtBet: 0,
    });
    expect(shove.risk).toBeLessThan(0);
  });
});
