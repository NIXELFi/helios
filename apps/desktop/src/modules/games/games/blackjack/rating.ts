// The Blackjack rating — one persistent number per player, carried across
// sessions the way a chess rating is, not a per-session high score.
//
// WHY v1 HAD TO GO
// ----------------
// v1 rated each hand as a game against a house frozen at 1000: win 1, push ½,
// loss 0, K=32. It was unwinnable (perfect play equilibrated near 985), it
// rated the shoe rather than the player, and per-hand noise of ±16 points
// dwarfed the ~40-point spread between flawless and dreadful play. "My Elo
// only ever goes down" was a correct observation, not bad luck.
//
// WHY v2 HAD TO GO
// ----------------
// v2 fixed the noise by rating EXPECTED value instead of outcomes — but its
// algebra made every raise above the table minimum at a neutral count bleed
// rating, and multiplied play by √stake, so three of the four chip buttons
// were traps. A chart-PERFECT player pressing the 100-chip button lost ~31
// points per 30-hand session while winning chips. The measured verdict:
// min-bet grinding was the only way up. Correct advantage-play theory,
// terrible casino game.
//
// WHAT REPLACES IT: SKILL MONEY
// -----------------------------
// The rating is built on the money a session's play was WORTH — expected
// winnings, not realised ones. Every hand is scored on what the player's
// decisions and stake would earn against the reference player given the same
// cards, computed exactly by ev.ts; the cards that actually came out are
// still ignored, so luck cannot touch the ladder (it's shown separately).
// But the score is now denominated in money: playing well for 100 chips
// earns twenty times the climb of playing well for 5, and playing badly for
// 100 chips digs twenty times the hole. Betting is the throttle on your own
// skill, exactly as it is on the table.
//
// Each hand yields an ADVANTAGE in units of the table minimum — expected
// chips, made of three named parts the UI shows verbatim:
//
//   PLAY  stake × (EV of the line you actually played − EV the reference
//         player would have got FROM THE SAME SPOT). Differencing against the
//         same deal removes deal luck: a peach of a hand is worth nothing
//         extra, because the reference gets it too. Linear in the stake —
//         money made, not a per-unit style grade.
//   BET   (stake − 1) × the edge the COUNT has shifted. Zero at a neutral
//         shoe — raising for the thrill of it is free — positive when the
//         cards left genuinely favour you, negative when you raise into a
//         poor shoe. Counting is extra credit, not the entry fee.
//   RISK  a penalty on staking a large slice of the bankroll. Ruin isn't in
//         the EV — going broke ends the session — so bankroll discipline is
//         priced separately, tuned so ALL-IN every hand never out-earns an
//         honest big flat bet. Winning chips relaxes this term by itself:
//         a fat bankroll makes the same bet a smaller fraction.
//
// THE LADDER
// Money is compressed onto the ladder with a square root, so stakes make the
// number climb impressively without making it absurd:
//
//     rating implied by money m  =  1000 + 400·sign(m)·√(|m| / TIER_ADVANTAGE)
//
//   1000  mimic the dealer — zero margin, worth zero money at any stake.
//   1400  flawless chart play flat-betting the MINIMUM. Not a ceiling any
//         more: it's the "perfect but timid" landmark.
//   above earned by putting real money on good play — flawless play at a
//         flat 100-chip bet settles ~2700 — and by raising into rich counts.
//         Bad play at big stakes falls as fast as good play climbs.
//
// Ratings are applied ONCE per session, weighted by how many hands it lasted,
// so a hot three-hand streak moves almost nothing and hit-and-run stops
// paying. Persistence lives in games.ratings; see api.ts.

/** Everyone starts here, and it's also where the reference player sits. */
export const RATING_START = 1000;
/** No matter how badly it goes, a rating can't fall through this. */
export const RATING_FLOOR = 100;
/** One rating tier, in the Elo tradition. */
export const TIER = 400;

// --- measured constants -----------------------------------------------------
// Both are produced by ev.ts's neutralEdges() over the full deal distribution
// for these exact house rules. They're hardcoded rather than computed at
// startup so the ladder can never silently shift under players; a test pins
// them against the live engine.

/** Per-unit expectation of flawless chart play. Negative — the house still
 *  wins; that's the point. (~-1.09%: worse than a textbook -0.4% because these
 *  rules have no split, no surrender and no insurance.) */
export const CHART_EDGE = -0.010867;
/** Per-unit expectation of the reference player (mimic the dealer). */
export const REFERENCE_EDGE = -0.056746;
/** Money worth one full tier: the per-unit gap flawless play opens over the
 *  reference. Flat-minimum perfection therefore settles at exactly 1400. */
export const TIER_ADVANTAGE = CHART_EDGE - REFERENCE_EDGE; // ≈ 0.045879

/** Hi-Lo is worth roughly half a percent of edge per point of true count. */
export const EDGE_PER_TRUE_COUNT = 0.005;
/** True counts beyond this are treated as capped — the linear approximation
 *  above stops being honest out in the tail, and the tail is where a
 *  deep-shoe denominator gets noisy. */
export const TRUE_COUNT_CAP = 8;

// --- bet sizing -------------------------------------------------------------

/** Fraction of the bankroll you can stake before the risk term bites. Half
 *  the starting stack on one hand is chunky but honest; most of it is not. */
export const SAFE_BANKROLL_FRACTION = 0.35;
/** Curvature of the ruin penalty. Quadratic past the safe fraction, and steep
 *  enough that a flawless ALL-IN spammer earns measurably less than the same
 *  player flat-betting half the stack — the shove must never be the
 *  rating-optimal lifestyle. */
export const RISK_WEIGHT = 3.0;

/** One hand can't be allowed to define a session, however catastrophic. Sized
 *  to clear the biggest legitimate hand (a flawless all-in at the capped
 *  count) so it only ever shaves tampering, not play. */
export const MAX_HAND_ADVANTAGE = 2.0;

// --- session update ---------------------------------------------------------

/** Hands before a session carries its full weight. Below this the update is
 *  scaled down pro rata, which is what kills hit-and-run. */
export const FULL_WEIGHT_HANDS = 25;
/** Ceiling on how far one session can move a rating, in either direction. */
export const MAX_SESSION_DELTA = 120;

/** FIDE-style: fast while the rating is still finding you, slow once it has. */
export function kFactor(handsRated: number): number {
  if (handsRated < 200) return 64;
  if (handsRated < 1000) return 32;
  return 16;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Edge per unit staked that the shoe is offering right now, to a player who
 *  plays the chart. Negative at a flat count — the house wins the long run;
 *  only the count moves it. */
export function shoeEdge(trueCount: number): number {
  return CHART_EDGE + EDGE_PER_TRUE_COUNT * clamp(trueCount, -TRUE_COUNT_CAP, TRUE_COUNT_CAP);
}

/** The EV the player's own line was worth, in units of the initial bet.
 *  Derived by telescoping: start from what the spot was worth under perfect
 *  play, then subtract the EV surrendered at each decision. */
export function lineEV(evOptimal: number, evLost: number): number {
  return evOptimal - evLost;
}

export interface HandInput {
  /** Initial stake as a multiple of the table minimum (not of the bankroll). */
  stakeUnits: number;
  /** Stake as a fraction of the bankroll it was placed from, 0..1. */
  bankrollFraction: number;
  /** EV of the line the player actually played, in initial-bet units. */
  evLine: number;
  /** EV the reference player would have had from the same spot. */
  evReference: number;
  /** True count at the moment the bet went down — before the deal, because
   *  that is all the information the bet could legitimately be based on. */
  trueCountAtBet: number;
}

export interface HandAdvantage {
  /** Decisions, in money: stake × margin over the reference. */
  play: number;
  /** Bet sizing against the count; zero at a neutral shoe. */
  bet: number;
  /** Ruin penalty; ≤ 0. */
  risk: number;
  /** Sum of the three, clamped. This is what the session accumulates. */
  total: number;
}

/** Score one settled hand. Nothing here depends on how the hand turned out. */
export function handAdvantage(input: HandInput): HandAdvantage {
  const units = Math.max(1, input.stakeUnits);
  // Linear in the stake: this is expected MONEY over the reference player,
  // and twenty units of good play really do earn twenty units' worth.
  const play = units * (input.evLine - input.evReference);
  // Only the COUNT-driven shift, not the house edge itself: raising at a
  // neutral shoe is rating-free, raising into a rich shoe pays, raising into
  // a poor one costs. (shoeEdge − CHART_EDGE is exactly the shift.)
  const bet = (units - 1) * (shoeEdge(input.trueCountAtBet) - CHART_EDGE);
  const over = Math.max(0, input.bankrollFraction - SAFE_BANKROLL_FRACTION);
  // Guarded so a safe bet yields +0 rather than -0, which would render as
  // "-0.00" in the breakdown.
  const risk = over === 0 ? 0 : -RISK_WEIGHT * over * over;
  return {
    play,
    bet,
    risk,
    total: clamp(play + bet + risk, -MAX_HAND_ADVANTAGE, MAX_HAND_ADVANTAGE),
  };
}

/** Per-hand money a rating claims to be able to sustain — the inverse of the
 *  √ ladder map, so it grows quadratically with height. The restoring force:
 *  the higher you are, the more your play has to be worth just to stay. */
export function expectedAdvantage(rating: number): number {
  const tiers = (rating - RATING_START) / TIER;
  return Math.sign(tiers) * TIER_ADVANTAGE * tiers * tiers;
}

/** What a given per-hand money figure is worth on the ladder. The square root
 *  compresses stakes: 4× the money is 2 tiers, not 4. Unbounded downward, so
 *  a disastrous hand can imply a deeply negative number; use `displayRating`
 *  for anything a player will read. */
export function impliedRating(advantage: number): number {
  return RATING_START + TIER * Math.sign(advantage) * Math.sqrt(Math.abs(advantage) / TIER_ADVANTAGE);
}

/** `impliedRating` clamped to the ladder a rating can actually occupy. */
export function displayRating(advantage: number): number {
  return Math.max(RATING_FLOOR, impliedRating(advantage));
}

export interface SessionInput {
  /** Rating carried in from the server. */
  rating: number;
  /** Lifetime rated hands, for the K tier. */
  handsRated: number;
  /** Hands settled this session. */
  hands: number;
  /** Sum of per-hand `total` advantages. */
  totalAdvantage: number;
}

/** How far this session moves the rating: K/TIER of the way from where you
 *  are to where this session's money says you belong, weighted by length so
 *  a three-hand cash-out is worth ~12% of a full update and quitting while
 *  ahead buys nothing. */
export function sessionDelta(input: SessionInput): number {
  if (input.hands <= 0) return 0;
  const average = input.totalAdvantage / input.hands;
  const weight = Math.min(1, input.hands / FULL_WEIGHT_HANDS);
  const raw = (kFactor(input.handsRated) * weight * (impliedRating(average) - input.rating)) / TIER;
  return clamp(raw, -MAX_SESSION_DELTA, MAX_SESSION_DELTA);
}

/** Session delta applied, floored. Returns floats; rounding is the caller's. */
export function applySession(input: SessionInput): { rating: number; delta: number } {
  const delta = sessionDelta(input);
  const rating = Math.max(RATING_FLOOR, input.rating + delta);
  // Report the delta that was actually applied, so a floored session doesn't
  // claim to have taken away points it couldn't.
  return { rating, delta: rating - input.rating };
}
