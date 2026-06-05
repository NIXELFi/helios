// Pure flappy core. Fixed-dt physics driven by the component's rAF loop.
// World units are pixels of a 400×600 logical canvas.

export const WORLD = { w: 400, h: 600 };
export const BIRD_X = 80;
export const BIRD_R = 12;
export const GRAVITY = 1400; // px/s²
export const FLAP_VY = -420; // px/s
export const PIPE_SPEED = 140; // px/s
export const PIPE_W = 60;
export const GAP_H = 170;
export const PIPE_SPACING = 220;
const GAP_MARGIN = 40; // min distance of gap edge from world edge

export type Rng = () => number;

export interface Pipe { x: number; gapY: number; passed: boolean } // gapY = gap center
export interface FlappyState {
  y: number;
  vy: number;
  pipes: Pipe[];
  score: number;
  dead: boolean;
  started: boolean;
}

export function createInitialState(): FlappyState {
  return { y: WORLD.h / 2, vy: 0, pipes: [], score: 0, dead: false, started: false };
}

export function collides(y: number, p: Pipe): boolean {
  const inX = BIRD_X + BIRD_R > p.x && BIRD_X - BIRD_R < p.x + PIPE_W;
  if (!inX) return false;
  return y - BIRD_R < p.gapY - GAP_H / 2 || y + BIRD_R > p.gapY + GAP_H / 2;
}

export function step(s: FlappyState, dt: number, flap: boolean, rng: Rng): FlappyState {
  if (s.dead) return s;
  if (!s.started) {
    return flap ? { ...s, started: true, vy: FLAP_VY } : s;
  }
  const vy = flap ? FLAP_VY : s.vy + GRAVITY * dt;
  const y = s.y + vy * dt;

  let pipes = s.pipes
    .map((p) => ({ ...p, x: p.x - PIPE_SPEED * dt }))
    .filter((p) => p.x + PIPE_W > 0);
  const last = pipes[pipes.length - 1];
  if (!last || last.x < WORLD.w - PIPE_SPACING) {
    const lo = GAP_H / 2 + GAP_MARGIN;
    const hi = WORLD.h - GAP_H / 2 - GAP_MARGIN;
    pipes = [...pipes, { x: WORLD.w, gapY: lo + rng() * (hi - lo), passed: false }];
  }

  let score = s.score;
  pipes = pipes.map((p) => {
    if (!p.passed && p.x + PIPE_W < BIRD_X - BIRD_R) {
      score += 1;
      return { ...p, passed: true };
    }
    return p;
  });

  const dead = y - BIRD_R < 0 || y + BIRD_R > WORLD.h || pipes.some((p) => collides(y, p));
  return { y, vy, pipes, score, dead, started: true };
}
