export interface GameProps {
  /** Called exactly once when the run ends, with the final score. */
  onGameOver: (score: number) => void;
  /** True while the Games tab is hidden — halt loops and ignore input. */
  paused: boolean;
}
