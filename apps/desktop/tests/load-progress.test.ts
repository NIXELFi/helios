import { describe, it, expect } from "vitest";
import { progressFraction } from "../src/lib/load-progress";
import type { LoadProgress } from "../src/lib/load-sample";

const p = (loaded: number, total: number): LoadProgress => ({ label: "x", loaded, total });

describe("progressFraction (L5)", () => {
  it("computes loaded/total", () => {
    expect(progressFraction(p(2, 4), 0)).toBeCloseTo(0.5);
  });

  it("clamps to [0,1] even with a bad denominator or overshoot", () => {
    expect(progressFraction(p(5, 4), 0)).toBe(1);
    expect(progressFraction(p(1, 0), 0)).toBe(1); // total 0 → loaded any → clamp
    expect(progressFraction(p(-3, 4), 0)).toBe(0);
  });

  it("never goes backward (monotonic), even when the denominator shifts between stages", () => {
    // Stage 1: 2/2 = 1.0 with the bundled-only denominator …
    const a = progressFraction(p(2, 2), 0);
    expect(a).toBe(1);
    // Stage 2: 2/4 = 0.5 with a larger denominator would normally jump BACK to
    // 0.5; the monotonic floor holds it at the previous fraction.
    const b = progressFraction(p(2, 4), a);
    expect(b).toBe(1);
  });

  it("advances when the new fraction exceeds the floor", () => {
    const floor = 0.5;
    expect(progressFraction(p(3, 4), floor)).toBeCloseTo(0.75);
  });

  it("treats a non-finite total as complete rather than NaN", () => {
    expect(progressFraction(p(1, NaN), 0)).toBe(1);
  });
});
