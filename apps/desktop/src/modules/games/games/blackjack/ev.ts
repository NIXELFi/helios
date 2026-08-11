// Blackjack expected-value engine — the thing the rating is actually built on.
//
// Everything here is deterministic: given a player hand and a dealer upcard it
// answers "what is this spot worth, in units of the initial bet, under policy
// X". That lets the rating grade DECISIONS instead of OUTCOMES, which matters
// enormously because one hand of blackjack is ~95% variance. See rating.ts.
//
// Model: infinite deck (each of A,2..9 drawn with p = 1/13, tens with 4/13).
// That's the same model the classic basic-strategy chart is generated from and
// it lands within ~0.05% of the exact 4-deck numbers — close enough to grade a
// decision, and cheap enough to run inside a keystroke handler. Shoe
// composition deliberately does NOT enter here; the count is priced at bet
// time instead (rating.ts), which keeps the two skills separable.
//
// House rules mirrored from logic.ts: dealer stands on ALL 17s, blackjack pays
// 3:2, double on any first two cards, no split / insurance / surrender.
//
// One subtlety worth stating plainly: every EV below is CONDITIONED ON THE
// DEALER NOT HOLDING A NATURAL. The table settles naturals the instant the
// cards are dealt, so no player decision ever happens in a world where the
// dealer has blackjack. Excluding that branch is both correct for the model
// and correct for the rating — losing to a dealer natural is not a mistake.

import { rankValue, type Card } from "./logic";

/** One card the dealer/player might draw, with its infinite-deck probability.
 *  Aces carry value 1 here; the +10 promotion is handled by `handTotal`. */
interface Draw {
  value: number;
  p: number;
}

const P_RANK = 1 / 13;
const DRAWS: Draw[] = [
  { value: 1, p: P_RANK }, // ace
  { value: 2, p: P_RANK },
  { value: 3, p: P_RANK },
  { value: 4, p: P_RANK },
  { value: 5, p: P_RANK },
  { value: 6, p: P_RANK },
  { value: 7, p: P_RANK },
  { value: 8, p: P_RANK },
  { value: 9, p: P_RANK },
  { value: 10, p: 4 * P_RANK }, // 10 / J / Q / K
];

/** A hand reduced to what the math needs: `hard` counts every ace as 1, `ace`
 *  records whether at least one ace is present (only one can ever count 11). */
export interface HandState {
  hard: number;
  ace: boolean;
}

export function handState(cards: Card[]): HandState {
  let hard = 0;
  let ace = false;
  for (const c of cards) {
    hard += rankValue(c.rank);
    if (c.rank === "A") ace = true;
  }
  return { hard, ace };
}

/** Playing total of a state — the ace is promoted to 11 while it fits. */
function handTotal(s: HandState): number {
  return s.ace && s.hard + 10 <= 21 ? s.hard + 10 : s.hard;
}

function draw(s: HandState, d: Draw): HandState {
  return { hard: s.hard + d.value, ace: s.ace || d.value === 1 };
}

// ------------------------------------------------------------ dealer outcomes

/** Dealer final-total distribution: indices 0..4 are totals 17..21, index 5 is
 *  bust. Dealer stands on all 17s, so nothing below 17 is terminal. */
type DealerDist = readonly [number, number, number, number, number, number];

const dealerPlayMemo = new Map<number, DealerDist>();

/** Distribution of where the dealer finishes from a partial hand. */
function dealerPlay(s: HandState): DealerDist {
  const total = handTotal(s);
  if (total >= 17) {
    const out = [0, 0, 0, 0, 0, 0];
    out[total > 21 ? 5 : total - 17] = 1;
    return out as unknown as DealerDist;
  }
  // hard ≤ 21 and ace is one bit, so this key is collision-free.
  const key = s.hard * 2 + (s.ace ? 1 : 0);
  const hit = dealerPlayMemo.get(key);
  if (hit) return hit;
  const out = [0, 0, 0, 0, 0, 0];
  for (const d of DRAWS) {
    const sub = dealerPlay(draw(s, d));
    for (let i = 0; i < 6; i++) out[i]! += d.p * sub[i]!;
  }
  const frozen = out as unknown as DealerDist;
  dealerPlayMemo.set(key, frozen);
  return frozen;
}

const dealerDistMemo = new Map<number, DealerDist>();

/** Probability the hole card gives the dealer a natural, given the upcard. */
function pDealerNatural(up: number): number {
  if (up === 1) return 4 * P_RANK; // ace up, needs a ten
  if (up === 10) return P_RANK; // ten up, needs the ace
  return 0;
}

/** Dealer distribution for an upcard, conditioned on "no dealer natural" —
 *  the only world in which the player ever gets to act. `up` is 1..10 with
 *  1 = ace. */
export function dealerDistribution(up: number): DealerDist {
  const hit = dealerDistMemo.get(up);
  if (hit) return hit;
  const out = [0, 0, 0, 0, 0, 0];
  let live = 0;
  for (const d of DRAWS) {
    const natural = (up === 1 && d.value === 10) || (up === 10 && d.value === 1);
    if (natural) continue;
    live += d.p;
    const sub = dealerPlay({ hard: up + d.value, ace: up === 1 || d.value === 1 });
    for (let i = 0; i < 6; i++) out[i]! += d.p * sub[i]!;
  }
  for (let i = 0; i < 6; i++) out[i]! /= live;
  const frozen = out as unknown as DealerDist;
  dealerDistMemo.set(up, frozen);
  return frozen;
}

// -------------------------------------------------------------- player values

/** EV of standing on `total` against `up`, in units of the initial bet. */
export function standEV(total: number, up: number): number {
  if (total > 21) return -1;
  const dist = dealerDistribution(up);
  let ev = dist[5]!; // dealer busts → +1
  for (let t = 17; t <= 21; t++) {
    const p = dist[t - 17]!;
    if (total > t) ev += p;
    else if (total < t) ev -= p;
  }
  return ev;
}

const playMemo = new Map<number, number>();

/** Optimal EV from a state where only hit/stand remain (doubling is a
 *  first-decision-only option under these house rules). */
function playEV(s: HandState, up: number): number {
  if (s.hard > 21) return -1;
  const key = (s.hard * 2 + (s.ace ? 1 : 0)) * 16 + up;
  const hit = playMemo.get(key);
  if (hit !== undefined) return hit;
  const ev = Math.max(standEV(handTotal(s), up), hitEV(s, up));
  playMemo.set(key, ev);
  return ev;
}

/** EV of taking one more card and then continuing optimally. */
function hitEV(s: HandState, up: number): number {
  let ev = 0;
  for (const d of DRAWS) {
    const next = draw(s, d);
    // A soft hand can't bust on one card, so hard > 21 is the whole test.
    ev += d.p * (next.hard > 21 ? -1 : playEV(next, up));
  }
  return ev;
}

/** EV of doubling: exactly one card, then forced stand, at twice the stake. */
function doubleEV(s: HandState, up: number): number {
  let ev = 0;
  for (const d of DRAWS) {
    const next = draw(s, d);
    ev += d.p * (next.hard > 21 ? -1 : standEV(handTotal(next), up));
  }
  return 2 * ev;
}

const mimicMemo = new Map<number, number>();

/** EV of the REFERENCE policy: mimic the dealer — draw until 17, then stand,
 *  never double. It is the yardstick the rating measures every player against
 *  (see rating.ts), chosen because it is the one strategy already written into
 *  the house rules, needs no explaining, and is beatable by anyone who learns
 *  the chart. */
function mimicEVState(s: HandState, up: number): number {
  if (s.hard > 21) return -1;
  const total = handTotal(s);
  if (total >= 17) return standEV(total, up);
  const key = (s.hard * 2 + (s.ace ? 1 : 0)) * 16 + up;
  const hit = mimicMemo.get(key);
  if (hit !== undefined) return hit;
  let ev = 0;
  for (const d of DRAWS) {
    const next = draw(s, d);
    ev += d.p * (next.hard > 21 ? -1 : mimicEVState(next, up));
  }
  mimicMemo.set(key, ev);
  return ev;
}

// ------------------------------------------------------------------ public API

export type Action = "hit" | "stand" | "double";

/** A two-card 21 pays 3:2 and ends the hand on the spot. Conditioned on the
 *  dealer having no natural (see the file header), that's a flat +1.5. */
export const NATURAL_EV = 1.5;

function isNatural(s: HandState, cardCount: number): boolean {
  return cardCount === 2 && handTotal(s) === 21;
}

/** Upcard as 1..10 (ace = 1). */
export function upcardValue(card: Card): number {
  return rankValue(card.rank);
}

/** EV of each legal action from this spot, in units of the INITIAL bet.
 *  `double` is null when the house rules don't allow it here. */
export function actionEVs(
  player: Card[],
  dealerUp: Card,
  canDouble: boolean,
): { hit: number; stand: number; double: number | null } {
  const s = handState(player);
  const up = upcardValue(dealerUp);
  return {
    hit: hitEV(s, up),
    stand: standEV(handTotal(s), up),
    double: canDouble ? doubleEV(s, up) : null,
  };
}

/** The best action available from this spot and what it's worth. */
export function bestAction(
  player: Card[],
  dealerUp: Card,
  canDouble: boolean,
): { action: Action; ev: number } {
  const evs = actionEVs(player, dealerUp, canDouble);
  let action: Action = "stand";
  let ev = evs.stand;
  if (evs.hit > ev) {
    action = "hit";
    ev = evs.hit;
  }
  if (evs.double !== null && evs.double > ev) {
    action = "double";
    ev = evs.double;
  }
  return { action, ev };
}

/** Value of a freshly dealt spot under optimal play — V*(s0). Naturals are
 *  settled, not played. `canDouble` defaults to "any first two cards", but the
 *  caller should pass false when the player can't cover the extra stake: an
 *  option you couldn't afford shouldn't count against you. */
export function optimalEV(player: Card[], dealerUp: Card, canDouble?: boolean): number {
  const s = handState(player);
  if (isNatural(s, player.length)) return NATURAL_EV;
  return bestAction(player, dealerUp, canDouble ?? player.length === 2).ev;
}

/** Value of the same spot to the reference (mimic-the-dealer) player. */
export function referenceEV(player: Card[], dealerUp: Card): number {
  const s = handState(player);
  if (isNatural(s, player.length)) return NATURAL_EV; // the reference is dealt naturals too
  return mimicEVState(s, upcardValue(dealerUp));
}

// ------------------------------------------------- whole-game edge calibration

/** Per-unit expectation of a whole hand, averaged over every deal, for the
 *  optimal (chart) player and for the reference player. Unlike everything
 *  above these are UNCONDITIONAL — the dealer-natural branch is included,
 *  because it's part of what a bet actually costs you.
 *
 *  These two numbers set the rating's scale (see rating.ts): the gap between
 *  them is one 400-point tier, and the optimal figure is the edge a flat
 *  bettor is fighting. The values are hardcoded there and pinned by a test
 *  against this function, so the ladder can't silently move under players. */
export function neutralEdges(): { optimal: number; reference: number } {
  let optimal = 0;
  let reference = 0;
  for (const a of DRAWS) {
    for (const b of DRAWS) {
      for (const u of DRAWS) {
        const p = a.p * b.p * u.p;
        const s: HandState = { hard: a.value + b.value, ace: a.value === 1 || b.value === 1 };
        const up = u.value;
        const pNat = pDealerNatural(up);
        if (handTotal(s) === 21) {
          // Player natural: pushes a dealer natural, else pays 3:2.
          const ev = (1 - pNat) * NATURAL_EV;
          optimal += p * ev;
          reference += p * ev;
          continue;
        }
        // Otherwise the dealer's natural is an unavoidable -1, and the rest of
        // the time the (conditional) policy value applies.
        const loss = pNat * -1;
        optimal += p * (loss + (1 - pNat) * Math.max(standEV(handTotal(s), up), hitEV(s, up), doubleEV(s, up)));
        reference += p * (loss + (1 - pNat) * mimicEVState(s, up));
      }
    }
  }
  return { optimal, reference };
}
