import { describe, it, expect } from "vitest";
import { sliceRateGroup } from "../src/slice";
import { RateGroup } from "../src/rate-group";

function makeRg() {
  const time = BigInt64Array.from([0n, 10_000n, 20_000n, 30_000n, 40_000n]);
  const rpm = Float64Array.from([1000, 2000, 3000, 4000, 5000]);
  const tps = Float64Array.from([10, 20, 30, 40, 50]);
  return RateGroup.fromColumns({
    id: "100hz", nominalRateHz: 100,
    time,
    columns: new Map([["engine.rpm", rpm], ["engine.tps", tps]]),
  });
}

describe("sliceRateGroup", () => {
  it("returns full range when range covers all samples", () => {
    const rg = makeRg();
    const s = sliceRateGroup(rg, ["engine.rpm"], { startUs: 0, endUs: 50_000 });
    expect(Array.from(s.data.get("engine.rpm")!)).toEqual([1000, 2000, 3000, 4000, 5000]);
    expect(s.time.length).toBe(5);
  });

  it("half-open: end exclusive", () => {
    const rg = makeRg();
    const s = sliceRateGroup(rg, ["engine.rpm"], { startUs: 10_000, endUs: 30_000 });
    expect(Array.from(s.time)).toEqual([10_000n, 20_000n]);
    expect(Array.from(s.data.get("engine.rpm")!)).toEqual([2000, 3000]);
  });

  it("returns empty slice when range is before all data", () => {
    const rg = makeRg();
    const s = sliceRateGroup(rg, ["engine.rpm"], { startUs: -100, endUs: -1 });
    expect(s.time.length).toBe(0);
  });

  it("requesting unknown channel throws", () => {
    const rg = makeRg();
    expect(() => sliceRateGroup(rg, ["bogus"], { startUs: 0, endUs: 50_000 }))
      .toThrow(/unknown channel/);
  });

  it("multiple channels return parallel arrays", () => {
    const rg = makeRg();
    const s = sliceRateGroup(rg, ["engine.rpm", "engine.tps"], { startUs: 0, endUs: 50_000 });
    expect(s.data.size).toBe(2);
    expect(Array.from(s.data.get("engine.tps")!)).toEqual([10, 20, 30, 40, 50]);
  });
});
