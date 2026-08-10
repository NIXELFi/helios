// Pure blackjack core: cards, shoe, hand valuation, the dealer rule,
// settlement, and the Elo session score. The component owns the state
// machine (bet → player → dealer reveal → settle) and the bankroll;
// everything here is deterministic given an injected rng.
//
// House rules (v1): 4-deck shoe, dealer stands on all 17s (soft included),
// blackjack pays 3:2 rounded down, double on any first two cards. No split,
// no insurance, no surrender.

export type Suit = "S" | "H" | "D" | "C";
export type Rank =
  | "A" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "J" | "Q" | "K";
export interface Card {
  rank: Rank;
  suit: Suit;
}
export type Rng = () => number;

export const DECKS = 4;
/** Reshuffle between hands once the shoe drops below this many cards —
 *  comfortably more than the worst-case single hand can consume. */
export const RESHUFFLE_BELOW = 26;

const SUITS: Suit[] = ["S", "H", "D", "C"];
const RANKS: Rank[] = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

/** Fresh shuffled shoe of DECKS decks. Draw by popping from the end. */
export function createShoe(rng: Rng): Card[] {
  const shoe: Card[] = [];
  for (let d = 0; d < DECKS; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) shoe.push({ rank, suit });
    }
  }
  // Fisher–Yates
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = shoe[i]!;
    shoe[i] = shoe[j]!;
    shoe[j] = tmp;
  }
  return shoe;
}

function rankValue(rank: Rank): number {
  if (rank === "A") return 1;
  if (rank === "K" || rank === "Q" || rank === "J") return 10;
  return Number(rank);
}

/** Best blackjack total for a hand. `soft` = an ace is currently counted as
 *  11 (the hand can absorb a 10 without busting). */
export function handValue(cards: Card[]): { total: number; soft: boolean } {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    total += rankValue(c.rank);
    if (c.rank === "A") aces++;
  }
  // At most one ace can ever count as 11 (two would be 22).
  if (aces > 0 && total + 10 <= 21) return { total: total + 10, soft: true };
  return { total, soft: false };
}

/** A natural: exactly two cards totalling 21. A doubled/hit 21 has three or
 *  more cards, so it can never read as a natural here. */
export function isBlackjack(cards: Card[]): boolean {
  return cards.length === 2 && handValue(cards).total === 21;
}

/** House rule: dealer stands on ALL 17s, soft included. */
export function dealerShouldHit(cards: Card[]): boolean {
  return handValue(cards).total < 17;
}

export type Outcome = "blackjack" | "win" | "push" | "lose";

/** Settle a finished hand. `bet` is the live stake (already doubled if the
 *  player doubled); `payout` is what returns to the bankroll — stake included
 *  unless the hand is lost. Blackjack pays 3:2, rounded down. */
export function settle(
  player: Card[],
  dealer: Card[],
  bet: number,
): { outcome: Outcome; payout: number } {
  const p = handValue(player).total;
  const d = handValue(dealer).total;
  const pNatural = isBlackjack(player);
  const dNatural = isBlackjack(dealer);
  if (pNatural && dNatural) return { outcome: "push", payout: bet };
  if (pNatural) return { outcome: "blackjack", payout: bet + Math.floor(bet * 1.5) };
  if (dNatural) return { outcome: "lose", payout: 0 };
  if (p > 21) return { outcome: "lose", payout: 0 };
  if (d > 21) return { outcome: "win", payout: bet * 2 };
  if (p > d) return { outcome: "win", payout: bet * 2 };
  if (p < d) return { outcome: "lose", payout: 0 };
  return { outcome: "push", payout: bet };
}

// ---------------------------------------------------------------- Elo score
// The leaderboard score for blackjack is an Elo rating, not chips: the
// session starts at ELO_START and every settled hand is a rated game against
// a house frozen at ELO_HOUSE (win 1, push ½, loss 0 — stake size doesn't
// enter). Chips are the survival resource that decides how long you get to
// keep playing; the rating is how well you played. Because the house never
// moves, climbing above 1000 means sustaining better-than-even results
// against the house edge, and the expected-score curve makes every further
// point harder to hold — which is what keeps one lucky streak from running
// away with the all-time board.

export const ELO_START = 1000;
export const ELO_HOUSE = 1000;
export const ELO_K = 32;

/** Match score of a settled hand for the rating update. A natural is just a
 *  win — the 3:2 bonus is chips' business, not the rating's. */
export function outcomeEloScore(outcome: Outcome): 0 | 0.5 | 1 {
  if (outcome === "lose") return 0;
  if (outcome === "push") return 0.5;
  return 1;
}

/** One Elo update against the fixed-rating house. Returns the new (float)
 *  rating; display/submission rounding is the caller's business. */
export function eloUpdate(rating: number, score: 0 | 0.5 | 1): number {
  const expected = 1 / (1 + Math.pow(10, (ELO_HOUSE - rating) / 400));
  return rating + ELO_K * (score - expected);
}
