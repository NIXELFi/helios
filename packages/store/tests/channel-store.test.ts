import { describe, it, expect } from "vitest";
import { ChannelStore, RateGroup } from "../src";
import type { ChannelMeta } from "../src/types";

const meta = (id: string, group = "test"): ChannelMeta => ({
  id, display_name: id, units: "", group, color: "#fff",
  decimals: 2, data_type: "f64", source: "test", sample_rate_hz: 100,
});

function makeStore() {
  const store = new ChannelStore();
  const rg100 = RateGroup.fromColumns({
    id: "100hz", nominalRateHz: 100,
    time: BigInt64Array.from([0n, 10_000n, 20_000n]),
    columns: new Map([
      ["engine.rpm", Float64Array.from([1000, 2000, 3000])],
      ["engine.tps", Float64Array.from([10, 20, 30])],
    ]),
  });
  store.addRateGroup(rg100, [meta("engine.rpm"), meta("engine.tps")]);
  const rg10 = RateGroup.fromColumns({
    id: "10hz", nominalRateHz: 10,
    time: BigInt64Array.from([0n, 100_000n]),
    columns: new Map([["engine.water_temp", Float64Array.from([88, 89])]]),
  });
  store.addRateGroup(rg10, [meta("engine.water_temp")]);
  return store;
}

describe("ChannelStore", () => {
  it("lists all channels across rate groups", () => {
    const ids = makeStore().list().map(m => m.id).sort();
    expect(ids).toEqual(["engine.rpm", "engine.tps", "engine.water_temp"]);
  });

  it("slice routes channels to their owning rate group", () => {
    const s = makeStore().slice(["engine.rpm", "engine.water_temp"], { startUs: 0, endUs: 100_001 });
    expect(s.data.has("engine.rpm")).toBe(true);
    expect(s.data.has("engine.water_temp")).toBe(true);
  });

  it("slice aligns every channel to the shared time axis for a mixed-rate request", () => {
    // engine.rpm/tps live in the 100hz group (t = 0,10k,20k); engine.water_temp
    // lives in the 10hz group (t = 0,100k). A correct slice resamples both onto
    // one common axis so each column length equals slice.time.length — the bug
    // paired water_temp (len 2) with the 100hz time (len 3) and read garbage.
    const s = makeStore().slice(["engine.rpm", "engine.water_temp"], { startUs: 0, endUs: 100_001 });
    for (const [, col] of s.data) {
      expect(col.length).toBe(s.time.length);
    }
    // The shared axis is the union of both groups' timestamps in range.
    expect(Array.from(s.time, Number)).toEqual([0, 10_000, 20_000, 100_000]);
    // Zero-order hold: rpm holds its last reading past 20k; water_temp holds 88
    // until its next sample at 100k.
    expect(Array.from(s.data.get("engine.rpm")!)).toEqual([1000, 2000, 3000, 3000]);
    expect(Array.from(s.data.get("engine.water_temp")!)).toEqual([88, 88, 88, 89]);
  });

  it("extentUs reports overall range", () => {
    const e = makeStore().extentUs();
    expect(e.startUs).toBe(0);
    expect(e.endUs).toBe(100_000);
  });

  it("unknown channel throws", () => {
    expect(() => makeStore().slice(["nope"], { startUs: 0, endUs: 100 }))
      .toThrow(/unknown channel/);
  });
});
