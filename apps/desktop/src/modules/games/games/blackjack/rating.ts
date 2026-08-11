// The Blackjack rating — one persistent number per player, carried across
// sessions the way a chess rating is, not a per-session high score.
//
// WHY THE OLD ONE HAD TO GO
// -------------------------
// v1 rated each hand as a game against a house frozen at 1000: win 1, push ½,
// loss 0, K=32. Three things were wrong with that, and all three showed up as
// complaints:
//
//   1. It was unwinnable. Under these house rules a flawless basic-strategy
//      player wins ~43.5% of hands and pushes ~8.6%, i.e. scores ~0.478 — but
//      the formula expected 0.5 at par. Perfect play therefore drifted DOWN to
//      an equilibrium near 985 and could never hold 1000. "My Elo only ever
//      goes down" was a correct observation, not bad luck.
//   2. It rated the shoe, not the player. Being dealt 20 against a 6 and
//      winning paid exactly what grinding out a 16 against a 10 paid. Hitting
//      a hard 20 and getting away with it GAINED rating.
//   3. It was a lottery. Every session restarted at 1000 and the board took
//      max(score), so three hands and a cash-out beat two hundred honest ones.
//
// The deeper problem underneath all three: one hand of blackjack is almost all
// variance. Per-hand noise was ±16 rating points while the entire spread
// between flawless and dreadful play was about 40. No amount of tuning K fixes
// a signal-to-noise ratio like that.
//
// WHAT REPLACES IT
// ----------------
// The rating is built on EXPECTED value, not realised outcomes. Every hand is
// scored on what the player's decisions and bet were WORTH, computed exactly
// by ev.ts, and the cards that actually came out are ignored. Whether you won
// the hand genuinely does not affect your rating — only whether you played and
// sized it well. Chips remain the survival resource; luck is reported to the
// player as its own stat so they can see the shoe robbing them without it
// touching the ladder.
//
// Each hand yields an ADVANTAGE, measured in units of the table minimum, made
// of three named parts the UI shows verbatim:
//
//   PLAY  √units × (EV of the line you actually played − EV the reference
//         player would have got FROM THE SAME SPOT). Differencing against the
//         same deal is what removes deal luck: a peach of a hand is worth
//         nothing extra, because the reference gets it too. Blunders subtract
//         here, immediately and deterministically.
//   BET   (√units − 1) × the reference player's edge given the shoe. Raising
//         above the minimum pays only when the count says the cards left
//         actually favour you, and costs you when they don't. This is where
//         bet sizing enters, and it's the only part of the game with headroom
//         above a perfect chart player.
//   RISK  a penalty on staking a large slice of the bankroll. Ruin isn't in
//         the EV — going broke ends the session — so bankroll discipline is
//         priced separately. This is what finally gives ALL-IN a cost.
//
// The algebra is deliberately arranged so that d(advantage)/d(stake) has the
// sign of the true player edge: the rating-maximising bet ramp is the real
// advantage-play bet ramp — minimum when the shoe is flat, more when it's
// rich. Nothing about it can be gamed by betting big and getting lucky.
//
// THE LADDER
//   1000  play like the house rule itself: draw to 17, stand, never double.
//   1400  flat-bet the table minimum and never misplay a hand. Both landmarks
//         come straight out of ev.ts, not from taste — see CHART_EDGE below.
//   1400+ earned only by sizing bets to the count (and by not going broke).
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
/** Advantage worth one full tier: the gap flawless play opens over the
 *  reference. Flat-betting perfection therefore settles at exactly 1400. */
export const TIER_ADVANTAGE = CHART_EDGE - REFERENCE_EDGE; // ≈ 0.045879

/** Hi-Lo is worth roughly half a percent of edge per point of true count. */
export const EDGE_PER_TRUE_COUNT = 0.005;
/** True counts beyond this are treated as capped — the linear approximation
 *  above stops being honest out in the tail, and the tail is where a
 *  deep-shoe denominator gets noisy. */
export const TRUE_COUNT_CAP = 8;

// --- bet sizing -------------------------------------------------------------

/** Fraction of the bankroll you can stake before the risk term bites. */
export const SAFE_BANKROLL_FRACTION = 0.15;
/** Curvature of the ruin penalty. Quadratic past the safe fraction, so a
 *  slightly chunky bet is free and shoving the stack is not. */
export const RISK_WEIGHT = 0.25;

/** One hand can't be allowed to define a session, however catastrophic. */
export const MAX_HAND_ADVANTAGE = 0.6;

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
 *  plays the chart. Negative at a flat count — which is exactly why raising
 *  your bet for no reason costs rating. */
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
  /** Decisions, stake-weighted. */
  play: number;
  /** Bet sizing against the count. */
  bet: number;
  /** Ruin penalty; ≤ 0. */
  risk: number;
  /** Sum of the three, clamped. This is what the session accumulates. */
  total: number;
}

/** Score one settled hand. Nothing here depends on how the hand turned out. */
export function handAdvantage(input: HandInput): HandAdvantage {
  // √stake, not stake: a bigger bet is a bigger game and should count for
  // more, but a single hand must never be able to swamp a session.
  const w = Math.sqrt(Math.max(1, input.stakeUnits));
  const play = w * (input.evLine - input.evReference);
  // The reference player's own expectation given the shoe. Writing it as
  // (edge − TIER_ADVANTAGE) is what makes the whole expression collapse to
  // TIER_ADVANTAGE + (w − 1)·edge for a chart-perfect player, i.e. exactly
  // 1400 when flat-betting and above it only when the count justifies more.
  const bet = (w - 1) * (shoeEdge(input.trueCountAtBet) - TIER_ADVANTAGE);
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

/** Per-hand advantage a rating claims to be able to sustain. The restoring
 *  force: the higher you are, the better you have to play just to stay. */
export function expectedAdvantage(rating: number): number {
  return (TIER_ADVANTAGE * (rating - RATING_START)) / TIER;
}

/** Inverse — what a given advantage is worth on the ladder. Unbounded, so a
 *  disastrous hand can imply a deeply negative number; use `displayRating`
 *  for anything a player will read. */
export function impliedRating(advantage: number): number {
  return RATING_START + (TIER * advantage) / TIER_ADVANTAGE;
}

/** `impliedRating` clamped to the ladder a rating can actually occupy. Three
 *  straight blunders imply about -4200, which is arithmetically true and
 *  useless on screen — the floor is where the ladder stops, so say that. */
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

/** How far this session moves the rating. Weighted by length, so a three-hand
 *  cash-out is worth ~12% of a full update and quitting while ahead buys
 *  nothing. */
export function sessionDelta(input: SessionInput): number {
  if (input.hands <= 0) return 0;
  const average = input.totalAdvantage / input.hands;
  const weight = Math.min(1, input.hands / FULL_WEIGHT_HANDS);
  const raw =
    (kFactor(input.handsRated) * weight * (average - expectedAdvantage(input.rating))) /
    TIER_ADVANTAGE;
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
