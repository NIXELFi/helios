import { describe, expect, it } from "vitest";
import {
  createShoe,
  dealerShouldHit,
  handValue,
  isBlackjack,
  netUnits,
  settle,
  DECKS,
  type Card,
  type Rank,
} from "../games/blackjack/logic";

/** Shorthand hand builder — suits don't matter to any rule under test. */
function hand(...ranks: Rank[]): Card[] {
  return ranks.map((rank) => ({ rank, suit: "S" as const }));
}

/** Deterministic rng for shuffle tests. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

describe("handValue", () => {
  it("counts pips and faces", () => {
    expect(handValue(hand("2", "3"))).toEqual({ total: 5, soft: false });
    expect(handValue(hand("K", "Q"))).toEqual({ total: 20, soft: false });
    expect(handValue(hand("10", "J"))).toEqual({ total: 20, soft: false });
  });
  it("counts one ace as 11 while it fits (soft)", () => {
    expect(handValue(hand("A", "6"))).toEqual({ total: 17, soft: true });
    expect(handValue(hand("A", "K"))).toEqual({ total: 21, soft: true });
  });
  it("drops the ace to 1 when 11 would bust (hard)", () => {
    expect(handValue(hand("A", "6", "9"))).toEqual({ total: 16, soft: false });
    expect(handValue(hand("A", "K", "5"))).toEqual({ total: 16, soft: false });
  });
  it("never counts two aces as 11", () => {
    expect(handValue(hand("A", "A"))).toEqual({ total: 12, soft: true });
    expect(handValue(hand("A", "A", "9"))).toEqual({ total: 21, soft: true });
    expect(handValue(hand("A", "A", "K"))).toEqual({ total: 12, soft: false });
  });
});

describe("isBlackjack", () => {
  it("recognizes a two-card 21", () => {
    expect(isBlackjack(hand("A", "K"))).toBe(true);
    expect(isBlackjack(hand("10", "A"))).toBe(true);
  });
  it("rejects a 21 in three cards (e.g. after a double)", () => {
    expect(isBlackjack(hand("7", "7", "7"))).toBe(false);
    expect(isBlackjack(hand("A", "5", "5"))).toBe(false);
  });
  it("rejects two-card non-21", () => {
    expect(isBlackjack(hand("A", "A"))).toBe(false);
    expect(isBlackjack(hand("K", "Q"))).toBe(false);
  });
});

describe("dealerShouldHit", () => {
  it("hits 16 and below", () => {
    expect(dealerShouldHit(hand("10", "6"))).toBe(true);
    expect(dealerShouldHit(hand("2", "3"))).toBe(true);
  });
  it("stands on hard 17+", () => {
    expect(dealerShouldHit(hand("10", "7"))).toBe(false);
    expect(dealerShouldHit(hand("K", "Q"))).toBe(false);
  });
  it("stands on soft 17 (house rule)", () => {
    expect(dealerShouldHit(hand("A", "6"))).toBe(false);
  });
  it("hits a hand whose ace must be hard", () => {
    // A+3+3 = soft 17? A(11)+3+3 = 17 soft → stands; A(1)+5+10 = 16 → hits
    expect(dealerShouldHit(hand("A", "3", "3"))).toBe(false);
    expect(dealerShouldHit(hand("A", "5", "10"))).toBe(true);
  });
});

describe("createShoe", () => {
  it("holds DECKS complete decks", () => {
    const shoe = createShoe(seeded(42));
    expect(shoe.length).toBe(DECKS * 52);
    const aces = shoe.filter((c) => c.rank === "A");
    expect(aces.length).toBe(DECKS * 4);
    const spades = shoe.filter((c) => c.suit === "S");
    expect(spades.length).toBe(DECKS * 13);
  });
  it("shuffles deterministically for a given rng", () => {
    expect(createShoe(seeded(7))).toEqual(createShoe(seeded(7)));
    expect(createShoe(seeded(7))).not.toEqual(createShoe(seeded(8)));
  });
});

describe("settle", () => {
  it("pays 1:1 on a straight win (stake returned + winnings)", () => {
    expect(settle(hand("10", "9"), hand("10", "8"), 25)).toEqual({ outcome: "win", payout: 50 });
  });
  it("pays on a dealer bust", () => {
    expect(settle(hand("10", "6"), hand("10", "6", "10"), 10)).toEqual({ outcome: "win", payout: 20 });
  });
  it("loses on a player bust even if the dealer also busts later", () => {
    expect(settle(hand("10", "6", "10"), hand("10", "6", "10"), 10)).toEqual({ outcome: "lose", payout: 0 });
  });
  it("pushes equal totals, returning the stake", () => {
    expect(settle(hand("10", "8"), hand("9", "9"), 40)).toEqual({ outcome: "push", payout: 40 });
  });
  it("pays a natural 3:2, rounded down", () => {
    expect(settle(hand("A", "K"), hand("10", "8"), 10)).toEqual({ outcome: "blackjack", payout: 25 });
    expect(settle(hand("A", "K"), hand("10", "8"), 5)).toEqual({ outcome: "blackjack", payout: 12 });
  });
  it("pushes natural vs natural", () => {
    expect(settle(hand("A", "K"), hand("A", "Q"), 10)).toEqual({ outcome: "push", payout: 10 });
  });
  it("dealer natural beats a made 21 in three cards", () => {
    expect(settle(hand("7", "7", "7"), hand("A", "K"), 10)).toEqual({ outcome: "lose", payout: 0 });
  });
  it("a doubled three-card 21 wins but is not a blackjack", () => {
    expect(settle(hand("5", "6", "10"), hand("10", "8"), 20)).toEqual({ outcome: "win", payout: 40 });
  });
});

// netUnits converts a settled hand into the same currency the EV engine
// speaks — multiples of the INITIAL bet — which is what makes "how the hand
// went vs. what the line was worth" a subtractable quantity.
describe("netUnits", () => {
  it("reads a flat win as +1 and a loss as -1", () => {
    expect(netUnits(50, 25, 25)).toBe(1);
    expect(netUnits(0, 25, 25)).toBe(-1);
  });
  it("reads a push as zero, doubled or not", () => {
    expect(netUnits(25, 25, 25)).toBe(0);
    expect(netUnits(50, 50, 25)).toBe(0);
  });
  it("reads a natural as +1.5 off the initial bet", () => {
    const { payout } = settle(hand("A", "K"), hand("10", "8"), 10);
    expect(netUnits(payout, 10, 10)).toBe(1.5);
  });
  it("reads a doubled hand as ±2 — twice the stake, same denominator", () => {
    expect(netUnits(100, 50, 25)).toBe(2); // won a double of 25 → 50 staked
    expect(netUnits(0, 50, 25)).toBe(-2);
  });
  it("agrees with settle across every outcome", () => {
    const bet = 20;
    const cases: [Card[], Card[], number][] = [
      [hand("10", "9"), hand("10", "8"), 1],   // win
      [hand("10", "8"), hand("9", "9"), 0],    // push
      [hand("10", "6", "10"), hand("10", "6"), -1], // bust
      [hand("A", "K"), hand("10", "8"), 1.5],  // natural
    ];
    for (const [player, dealer, expected] of cases) {
      const { payout } = settle(player, dealer, bet);
      expect(netUnits(payout, bet, bet)).toBe(expected);
    }
  });
});
