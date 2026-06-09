import { describe, it, expect } from "vitest";

import { rampColor, rampColors } from "../lib/colorScale";

describe("rampColor", () => {
  it("hits the ramp endpoints and clamps outside [0,1]", () => {
    expect(rampColor(0)).toBe("#3f51b5"); // indigo (low)
    expect(rampColor(1)).toBe("#ff5252"); // red (high)
    expect(rampColor(-5)).toBe(rampColor(0));
    expect(rampColor(7)).toBe(rampColor(1));
  });

  it("interpolates between stops (t=0.75 is the gold stop)", () => {
    expect(rampColor(0.75)).toBe("#ffc627"); // ASU gold
  });

  it("maps NaN to the mid color instead of throwing", () => {
    expect(rampColor(NaN)).toBe(rampColor(0.5));
  });
});

describe("rampColors", () => {
  it("normalizes over the finite min..max", () => {
    const { colors, min, max } = rampColors([10, 20, 30]);
    expect(min).toBe(10);
    expect(max).toBe(30);
    expect(colors[0]).toBe(rampColor(0));
    expect(colors[1]).toBe(rampColor(0.5));
    expect(colors[2]).toBe(rampColor(1));
  });

  it("a constant series maps everything to the mid color", () => {
    const { colors } = rampColors([5, 5, 5]);
    expect(new Set(colors).size).toBe(1);
    expect(colors[0]).toBe(rampColor(0.5));
  });

  it("ignores non-finite values when ranging", () => {
    const { min, max } = rampColors([NaN, 1, Infinity, 3]);
    expect(min).toBe(1);
    expect(max).toBe(3);
  });
});
