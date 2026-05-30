import { describe, it, expect } from "vitest";
import { stepToLapBoundary } from "../src/lib/lap-step";

// Boundaries here are lap start times (µs). Session starts at the first lap's
// start. A warmup/out lap usually starts at the session origin.
const starts = [0, 30_000_000, 60_000_000, 90_000_000];

describe("stepToLapBoundary (H8)", () => {
  it("] steps forward to the next boundary", () => {
    expect(stepToLapBoundary(starts, 0, 1, "next")).toBe(30_000_000);
    expect(stepToLapBoundary(starts, 0, 45_000_000, "next")).toBe(60_000_000);
  });

  it("] does not stick when the cursor is exactly on a boundary", () => {
    // Sitting exactly on lap 2's start should advance to lap 3's start.
    expect(stepToLapBoundary(starts, 0, 30_000_000, "next")).toBe(60_000_000);
  });

  it("] returns null at/after the last boundary (nowhere further to go)", () => {
    expect(stepToLapBoundary(starts, 0, 90_000_000, "next")).toBeNull();
    expect(stepToLapBoundary(starts, 0, 120_000_000, "next")).toBeNull();
  });

  it("[ steps back to the previous boundary", () => {
    expect(stepToLapBoundary(starts, 0, 75_000_000, "prev")).toBe(60_000_000);
    expect(stepToLapBoundary(starts, 0, 95_000_000, "prev")).toBe(90_000_000);
  });

  it("[ does not stick when the cursor is exactly on a boundary", () => {
    // Sitting exactly on lap 3's start should retreat to lap 2's start.
    expect(stepToLapBoundary(starts, 0, 60_000_000, "prev")).toBe(30_000_000);
  });

  it("[ can reach the FIRST lap boundary from just after it", () => {
    expect(stepToLapBoundary(starts, 0, 15_000_000, "prev")).toBe(0);
  });

  it("[ clamps to session start when no earlier boundary exists", () => {
    // Cursor at/just-after the first boundary but the session origin is < first
    // boundary: clamp to the session start so the user can always rewind home.
    const sessionStartUs = -5_000_000;
    expect(stepToLapBoundary(starts, sessionStartUs, 0, "prev")).toBe(sessionStartUs);
    expect(stepToLapBoundary(starts, sessionStartUs, 10_000, "prev")).toBe(0);
  });

  it("[ at the session start returns null (already home)", () => {
    expect(stepToLapBoundary(starts, 0, 0, "prev")).toBeNull();
  });

  it("returns null for an empty boundary list", () => {
    expect(stepToLapBoundary([], 0, 5, "next")).toBeNull();
    expect(stepToLapBoundary([], 0, 5, "prev")).toBeNull();
  });
});
