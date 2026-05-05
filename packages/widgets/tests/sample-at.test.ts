import { describe, it, expect } from "vitest";
import { sampleAt } from "../src/lib/sample-at";

const slice = {
  time: BigInt64Array.from([0n, 10_000n, 20_000n, 30_000n]),
  data: new Map([["x", Float64Array.from([10, 20, 30, 40])]]),
};

describe("sampleAt", () => {
  it("returns first sample when t < first sample time", () => {
    expect(sampleAt(slice, "x", -1)).toBe(10);
  });
  it("returns exact sample when t equals a sample time", () => {
    expect(sampleAt(slice, "x", 20_000)).toBe(30);
  });
  it("returns last preceding sample for t between samples", () => {
    expect(sampleAt(slice, "x", 15_000)).toBe(20);
  });
  it("returns last sample for t past the end", () => {
    expect(sampleAt(slice, "x", 1_000_000)).toBe(40);
  });
  it("returns null for unknown channel", () => {
    expect(sampleAt(slice, "missing", 0)).toBe(null);
  });
  it("returns null for empty slice", () => {
    const empty = { time: new BigInt64Array(0), data: new Map() };
    expect(sampleAt(empty, "x", 0)).toBe(null);
  });
});
