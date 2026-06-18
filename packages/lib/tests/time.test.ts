import { describe, it, expect } from "vitest";
import { formatLapTime, formatClock, usToS } from "../src/time";

describe("time utils", () => {
  it("formats lap time as M:SS.mmm", () => {
    expect(formatLapTime(75_432_000)).toBe("1:15.432");
    expect(formatLapTime(0)).toBe("0:00.000");
  });

  it("formats clock as MM:SS.mmm", () => {
    expect(formatClock(75_432_000)).toBe("01:15.432");
  });

  it("formats negative durations with a leading minus (deltas)", () => {
    // Lap/sector deltas can be negative; previously floor/% on a negative
    // value produced garbage components instead of "-M:SS.mmm".
    expect(formatLapTime(-75_432_000)).toBe("-1:15.432");
    expect(formatClock(-75_432_000)).toBe("-01:15.432");
    expect(formatLapTime(-500_000)).toBe("-0:00.500");
  });

  it("usToS converts microseconds to seconds", () => {
    expect(usToS(1_500_000)).toBeCloseTo(1.5);
  });
});
