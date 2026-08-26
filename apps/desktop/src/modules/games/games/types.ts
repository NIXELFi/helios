import type {
  DropRequest, DropResult, PlacedBet, RaisedBet, SettledBet,
} from "../api";

/** What a rated game reports at the end of a run. Rated games don't submit a
 *  score at all — they submit how well the session was PLAYED, and the server
 *  folds it into the rating the player is carrying. See blackjack/rating.ts. */
export interface RatedSession {
  /** Hands settled this session. Short sessions are weighted down. */
  hands: number;
  /** Sum of per-hand advantages, in table-minimum units. */
  totalAdvantage: number;
}

/** A player's carried rating, loaded before a rated cabinet mounts. */
export interface RatingSnapshot {
  rating: number;
  /** Lifetime rated hands — drives the K tier. */
  handsRated: number;
}

/** The subteam's shared budget, handed to a money game along with the one way
 *  to spend it. The cabinet never talks to the network itself and never
 *  computes a balance: it calls `place` and renders whatever the server says
 *  happened, exactly as it renders a score it was given. */
export interface MoneyTable {
  subteam: string;
  /** Chips the subteam holds right now. Changes when a TEAMMATE plays too. */
  balance: number;
  /** Largest legal single bet: 5% of the balance. Advisory — the server
   *  recomputes it under the row lock and its answer is the one that counts. */
  maxBet: number;
  // --- one-shot games (plinko) ---------------------------------------------
  /** Drop one ball: the whole bet resolves server-side in one transaction.
   *  The nonce makes it exactly-once, so a retry after a dropped connection
   *  replays the original ball instead of rolling — and charging for — a
   *  second one. Rejects with the server's message when the stake is refused. */
  place: (req: DropRequest, nonce: string) => Promise<DropResult>;

  // --- two-phase games (blackjack) -----------------------------------------
  // A hand is played over time, so its chips leave the budget when the cards
  // come out and come back when it finishes. Every call is idempotent under
  // its own nonce.
  /** Take the stake for a hand about to be dealt. */
  placeBet: (stake: number, nonce: string) => Promise<PlacedBet>;
  /** Double down: a SECOND stake of the same size, capped on its own. */
  raiseBet: (betId: string, nonce: string) => Promise<RaisedBet>;
  /** Pay a finished hand. The server refuses any amount no legal hand could
   *  produce. */
  settleBet: (
    betId: string, payout: number, outcome: string, nonce: string,
  ) => Promise<SettledBet>;
  /** Close out a hand abandoned by a previous session, forfeiting its stake.
   *  Resolves to null when there was nothing open. */
  forfeitOpen: () => Promise<{ stake: number } | null>;
}

export interface GameProps {
  /** Called exactly once when the run ends. Unrated games pass a score;
   *  rated games pass their projected rating for display plus the session
   *  that produced it, which is what actually gets submitted. Money games
   *  never end, so they never call this. */
  onGameOver: (score: number, session?: RatedSession) => void;
  /** True while the Games tab is hidden — halt loops and ignore input. */
  paused: boolean;
  /** Rated games only: the rating this session continues from. The module
   *  guarantees it is resolved before the cabinet mounts. */
  rating?: RatingSnapshot;
  /** Money games only: the shared budget. The module guarantees it is
   *  resolved before the cabinet mounts. */
  money?: MoneyTable;
}
