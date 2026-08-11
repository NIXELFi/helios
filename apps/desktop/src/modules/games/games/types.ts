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

export interface GameProps {
  /** Called exactly once when the run ends. Unrated games pass a score;
   *  rated games pass their projected rating for display plus the session
   *  that produced it, which is what actually gets submitted. */
  onGameOver: (score: number, session?: RatedSession) => void;
  /** True while the Games tab is hidden — halt loops and ignore input. */
  paused: boolean;
  /** Rated games only: the rating this session continues from. The module
   *  guarantees it is resolved before the cabinet mounts. */
  rating?: RatingSnapshot;
}
