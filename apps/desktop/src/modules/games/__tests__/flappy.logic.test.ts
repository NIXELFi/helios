import { describe, expect, it } from "vitest";
import {
  BIRD_R, BIRD_X, FLAP_VY, GAP_H, PIPE_W, WORLD,
  collides, createInitialState, step,
} from "../games/flappy/logic";

const rng = () => 0.5;
const DT = 1 / 60;

describe("flappy", () => {
  it("waits for the first flap before physics starts", () => {
    const s0 = createInitialState();
    expect(step(s0, DT, false, rng)).toEqual(s0);
    const s1 = step(s0, DT, true, rng);
    expect(s1.started).toBe(true);
    expect(s1.vy).toBe(FLAP_VY);
    expect(s1.y).toBeLessThan(s0.y); // flap impulse moves the bird on the same frame
  });

  it("applies gravity each step", () => {
    let s = step(createInitialState(), DT, true, rng);
    const vy0 = s.vy;
    s = step(s, DT, false, rng);
    expect(s.vy).toBeGreaterThan(vy0);
  });

  it("dies when hitting the floor", () => {
    let s = step(createInitialState(), DT, true, rng);
    for (let i = 0; i < 600 && !s.dead; i++) s = step(s, DT, false, rng);
    expect(s.dead).toBe(true);
  });

  it("scores when a pipe scrolls past the bird", () => {
    let s = step(createInitialState(), DT, true, rng);
    // Drive with a pipe placed just ahead of the bird whose gap is centered
    // on the bird; pin altitude each step to isolate scoring from physics.
    s = { ...s, y: WORLD.h / 2, vy: 0, pipes: [{ x: BIRD_X + 1, gapY: WORLD.h / 2, passed: false }] };
    let scored = false;
    for (let i = 0; i < 120 && !scored && !s.dead; i++) {
      s = { ...s, y: WORLD.h / 2, vy: 0 }; // pin altitude to isolate scoring
      s = step(s, DT, false, rng);
      scored = s.score === 1;
    }
    expect(scored).toBe(true);
  });

  it("collides with pipe edges, not the gap", () => {
    const pipe = { x: BIRD_X - PIPE_W / 2, gapY: 300, passed: false };
    expect(collides(300, pipe)).toBe(false); // centered in gap
    expect(collides(300 - GAP_H / 2 - BIRD_R, pipe)).toBe(true); // top lip
    expect(collides(300 + GAP_H / 2 + BIRD_R, pipe)).toBe(true); // bottom lip
  });
});
