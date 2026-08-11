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

/** Pip value with aces as 1 — the +10 promotion is `handValue`'s job (and
 *  `ev.ts`'s, which shares this mapping). */
export function rankValue(rank: Rank): number {
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

/** Net chips a settled hand returns, relative to the stake — i.e. what the
 *  bankroll actually moved by. In units of the initial bet this is the number
 *  the EV engine predicts, which is what makes "fortune" measurable:
 *  −2 (lost double) … 0 (push) … +1.5 (natural) … +2 (won double). */
export function netUnits(payout: number, bet: number, initialBet: number): number {
  return (payout - bet) / initialBet;
}

// ----------------------------------------------------------------- Hi-Lo count
// The shoe has a memory, and the rating prices it (see rating.ts): raising your
// bet is only rewarded when the cards left actually favour you. Standard Hi-Lo
// — low cards gone is good for the player, tens and aces gone is bad.

export function hiLoValue(card: Card): -1 | 0 | 1 {
  const v = rankValue(card.rank);
  if (card.rank === "A" || v === 10) return -1;
  return v <= 6 ? 1 : 0;
}

/** Running count normalised to decks remaining. Guarded against the tail of
 *  the shoe, where a half-deck denominator would explode the count. */
export function trueCount(running: number, cardsRemaining: number): number {
  const decks = Math.max(1, cardsRemaining / 52);
  return running / decks;
}
