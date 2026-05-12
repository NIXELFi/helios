import { describe, it, expect } from "vitest";
import { ChannelStore, RateGroup } from "../src";
import type { ChannelMeta } from "../src/types";

/** Build a store representing a CSV where:
 *   - `engine.aps` was auto-resolved from CSV header `APS Sensor 1`
 *   - `engine.tps` was auto-resolved from CSV header `Throttle Position`
 *   - A third column `Throttle Pedal Pos` exists at its raw header (the
 *     resolver picked APS Sensor 1 instead, but the user might want this
 *     one).
 *  Mirrors the realistic case where a vehicle has multiple pedal/throttle
 *  channels and the auto-resolver picks the "wrong" one for that car. */
function makeOverrideStore() {
  const store = new ChannelStore();
  const rg = RateGroup.fromColumns({
    id: "100hz",
    nominalRateHz: 100,
    time: BigInt64Array.from([0n, 10_000n, 20_000n]),
    columns: new Map([
      ["engine.aps", Float64Array.from([10, 20, 30])],
      ["engine.tps", Float64Array.from([5, 15, 25])],
      ["Throttle Pedal Pos", Float64Array.from([42, 43, 44])],
    ]),
  });
  const metas: ChannelMeta[] = [
    {
      id: "engine.aps", display_name: "APS", units: "%", group: "Engine",
      color: "#fff", decimals: 1, data_type: "f64", source: "csv",
      sample_rate_hz: 100, source_header: "APS Sensor 1",
    },
    {
      id: "engine.tps", display_name: "TPS", units: "%", group: "Engine",
      color: "#fff", decimals: 1, data_type: "f64", source: "csv",
      sample_rate_hz: 100, source_header: "Throttle Position",
    },
    {
      id: "Throttle Pedal Pos", display_name: "Throttle Pedal Pos",
      units: "%", group: "Unknown", color: "#888", decimals: 1,
      data_type: "f64", source: "csv", sample_rate_hz: 100,
      source_header: "Throttle Pedal Pos",
    },
  ];
  store.addRateGroup(rg, metas);
  return store;
}

describe("ChannelStore — per-session overrides", () => {
  it("listSourceHeaders enumerates every source column once", () => {
    const store = makeOverrideStore();
    const headers = store.listSourceHeaders().map((h) => h.sourceHeader);
    expect(headers).toEqual([
      "APS Sensor 1",
      "Throttle Pedal Pos",
      "Throttle Position",
    ]);
  });

  it("setChannelOverride redirects slice reads to the picked source column", () => {
    const store = makeOverrideStore();
    // Bind engine.aps to the column that was loaded under raw header
    // `Throttle Pedal Pos`. Reads of engine.aps must now return that data.
    store.setChannelOverride("engine.aps", "Throttle Pedal Pos");
    const slice = store.slice(["engine.aps"], { startUs: 0, endUs: 30_000 });
    expect(Array.from(slice.data.get("engine.aps")!)).toEqual([42, 43, 44]);
    expect(store.getChannelOverride("engine.aps")).toBe("Throttle Pedal Pos");
  });

  it("groupOf follows the override", () => {
    const store = makeOverrideStore();
    // All three columns happen to share a rate group here, but groupOf
    // should still translate through the override on the way to lookup.
    store.setChannelOverride("engine.aps", "Throttle Pedal Pos");
    const g = store.groupOf("engine.aps");
    expect(g?.id).toBe("100hz");
  });

  it("clearChannelOverride returns to auto behavior", () => {
    const store = makeOverrideStore();
    store.setChannelOverride("engine.aps", "Throttle Pedal Pos");
    store.clearChannelOverride("engine.aps");
    expect(store.getChannelOverride("engine.aps")).toBeUndefined();
    const slice = store.slice(["engine.aps"], { startUs: 0, endUs: 30_000 });
    expect(Array.from(slice.data.get("engine.aps")!)).toEqual([10, 20, 30]);
  });

  it("setChannelOverride throws on an unknown source_header", () => {
    const store = makeOverrideStore();
    expect(() => store.setChannelOverride("engine.aps", "Does Not Exist"))
      .toThrow(/source_header/);
  });

  it("effectiveChannelId returns the canonical id when no override is set", () => {
    const store = makeOverrideStore();
    expect(store.effectiveChannelId("engine.aps")).toBe("engine.aps");
    store.setChannelOverride("engine.aps", "Throttle Pedal Pos");
    expect(store.effectiveChannelId("engine.aps")).toBe("Throttle Pedal Pos");
  });

  it("slice keys the result by the requested id, not the override target", () => {
    const store = makeOverrideStore();
    store.setChannelOverride("engine.aps", "Throttle Pedal Pos");
    const slice = store.slice(["engine.aps", "engine.tps"], { startUs: 0, endUs: 30_000 });
    // Caller asked for engine.aps + engine.tps; result must be keyed by
    // those ids regardless of where the data physically came from.
    expect([...slice.data.keys()].sort()).toEqual(["engine.aps", "engine.tps"]);
    expect(Array.from(slice.data.get("engine.aps")!)).toEqual([42, 43, 44]);
    expect(Array.from(slice.data.get("engine.tps")!)).toEqual([5, 15, 25]);
  });
});
