// Pure breakout core. Single life, endless levels that respawn faster bricks.
// Brick collision is cell-of-ball-center — coarse but predictable and cheap.

export const W = 480;
export const H = 360;
export const PADDLE_W = 70;
export const PADDLE_H = 10;
export const PADDLE_Y = H - 24;
export const BALL_R = 5;
export const COLS = 10;
export const ROWS = 5;
export const BRICK_W = W / COLS;
export const BRICK_H = 16;
export const BRICK_TOP = 40;
const LEVEL_BONUS = 50;
const SPEEDUP = 1.1;
const MAX_VX = 600; // px/s — fast but can't skip a 48px brick column per step

export interface BreakoutState {
  x: number; y: number; vx: number; vy: number; // ball
  bricks: boolean[]; // ROWS*COLS, row-major
  score: number;
  level: number;
  gameOver: boolean;
}

export function createInitialState(): BreakoutState {
  return {
    x: W / 2, y: PADDLE_Y - 40, vx: 140, vy: -200,
    bricks: Array(ROWS * COLS).fill(true),
    score: 0, level: 1, gameOver: false,
  };
}

export function step(s: BreakoutState, dt: number, paddleX: number): BreakoutState {
  if (s.gameOver) return s;
  let { x, y, vx, vy, score, level } = s;
  let bricks = s.bricks;

  const prevY = y;
  x += vx * dt;
  y += vy * dt;

  if (x - BALL_R < 0) { x = BALL_R; vx = -vx; }
  if (x + BALL_R > W) { x = W - BALL_R; vx = -vx; }
  if (y - BALL_R < 0) { y = BALL_R; vy = -vy; }

  // Paddle: plane-crossing check (not a positional window) so fast balls at
  // the clamped max dt can't tunnel through the 10px paddle band. "english" —
  // offset from paddle center skews vx so the player can aim.
  if (
    vy > 0 &&
    prevY + BALL_R <= PADDLE_Y &&
    y + BALL_R >= PADDLE_Y &&
    x >= paddleX && x <= paddleX + PADDLE_W
  ) {
    y = PADDLE_Y - BALL_R; // snap to surface
    vy = -vy;
    vx += ((x - (paddleX + PADDLE_W / 2)) / (PADDLE_W / 2)) * 80;
    vx = Math.sign(vx) * Math.min(Math.abs(vx), MAX_VX);
  }

  // Brick under the ball center?
  const col = Math.floor(x / BRICK_W);
  const row = Math.floor((y - BRICK_TOP) / BRICK_H);
  if (row >= 0 && row < ROWS && col >= 0 && col < COLS && bricks[row * COLS + col]) {
    bricks = bricks.slice();
    bricks[row * COLS + col] = false; // index provably in-bounds: row<ROWS, col<COLS
    score += 10;
    vy = -vy;
  }

  if (!bricks.includes(true)) {
    level += 1;
    score += LEVEL_BONUS;
    bricks = Array(ROWS * COLS).fill(true);
    x = W / 2;
    y = PADDLE_Y - 40;
    vx *= SPEEDUP;
    vy = -Math.abs(vy) * SPEEDUP;
  }

  const gameOver = y - BALL_R > H;
  return { x, y, vx, vy, bricks, score, level, gameOver };
}
