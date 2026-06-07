import { describe, expect, it } from "vitest";
import {
  BALL_R, BRICK_TOP, BRICK_H, BRICK_W, COLS, H, PADDLE_W, PADDLE_Y, ROWS, W,
  createInitialState, step,
} from "../games/breakout/logic";

const DT = 1 / 60;

describe("breakout", () => {
  it("bounces off side walls", () => {
    const s = { ...createInitialState(), x: BALL_R + 1, y: H / 2, vx: -200, vy: 0 };
    const n = step(s, DT, 0);
    expect(n.vx).toBeGreaterThan(0);
  });

  it("bounces off the ceiling", () => {
    const s = { ...createInitialState(), x: W / 2, y: BALL_R + 1, vx: 0, vy: -200, bricks: Array(ROWS * COLS).fill(false) };
    // bricks cleared would trigger level-up; keep one brick alive far away
    s.bricks[ROWS * COLS - 1] = true;
    const n = step(s, DT, 0);
    expect(n.vy).toBeGreaterThan(0);
  });

  it("breaks a brick, scores 10, and reflects", () => {
    const s = createInitialState();
    // aim the ball into the center of brick (row 2, col 3)
    const bx = 3 * BRICK_W + BRICK_W / 2;
    const by = BRICK_TOP + 2 * BRICK_H + BRICK_H / 2;
    const placed = { ...s, x: bx, y: by - 6, vx: 0, vy: 200 };
    const n = step(placed, DT, 0);
    expect(n.bricks[2 * COLS + 3]).toBe(false);
    expect(n.score).toBe(10);
    expect(n.vy).toBeLessThan(0);
  });

  it("bounces off the paddle with english", () => {
    const paddleX = W / 2 - PADDLE_W / 2;
    const s = { ...createInitialState(), x: W / 2 + 20, y: PADDLE_Y - BALL_R, vx: 0, vy: 200 };
    const n = step(s, DT, paddleX);
    expect(n.vy).toBeLessThan(0);
    expect(n.vx).toBeGreaterThan(0); // hit right of paddle center
  });

  it("levels up when all bricks are cleared", () => {
    const s = { ...createInitialState(), bricks: Array(ROWS * COLS).fill(false) };
    s.bricks[0] = true;
    const placed = { ...s, x: BRICK_W / 2, y: BRICK_TOP + BRICK_H / 2 - 6, vx: 0, vy: 200 };
    const n = step(placed, DT, 0);
    expect(n.level).toBe(2);
    expect(n.bricks.every(Boolean)).toBe(true);
    expect(n.score).toBe(10 + 50); // brick + level bonus
  });

  it("ends when the ball falls below the paddle", () => {
    const s = { ...createInitialState(), x: W / 2, y: H + BALL_R + 1, vx: 0, vy: 200 };
    expect(step(s, DT, 0).gameOver).toBe(true);
  });

  it("does not tunnel through the paddle at the clamped max dt", () => {
    // Level-2 speed (220 px/s) at dt=1/20 travels 11px — more than the 10px
    // paddle band. The crossing check must still catch it.
    const paddleX = W / 2 - PADDLE_W / 2;
    const s = { ...createInitialState(), x: W / 2, y: PADDLE_Y - BALL_R - 2, vx: 0, vy: 220 };
    const n = step(s, 1 / 20, paddleX);
    expect(n.vy).toBeLessThan(0);
  });

  it("caps english so vx cannot grow without bound", () => {
    // x starts 10px inside the right edge so after dt=1/60 with vx=590 it
    // lands at ~paddleX+PADDLE_W-0.2 — still inside the paddle span, so the
    // bounce fires and english (+~80) would push vx to ~670; clamp must cap at 600.
    const paddleX = W / 2 - PADDLE_W / 2;
    const s = { ...createInitialState(), x: paddleX + PADDLE_W - 10, y: PADDLE_Y - BALL_R, vx: 590, vy: 200 };
    const n = step(s, DT, paddleX);
    expect(Math.abs(n.vx)).toBeLessThanOrEqual(600);
  });
});
