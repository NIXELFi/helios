import { describe, it, expect } from "vitest";
import { ChannelStore, RateGroup } from "../src";
import type { ChannelMeta } from "../src/types";

/** Build a minimal store with a single 3-sample rate group. */
function makeStore() {
  const store = new ChannelStore();
  const rg = RateGroup.fromColumns({
    id: "100hz",
    nominalRateHz: 100,
    time: BigInt64Array.from([0n, 10_000n, 20_000n]),
    columns: new Map([
      ["engine.rpm", Float64Array.from([1000, 2000, 3000])],
    ]),
  });
  const metas: ChannelMeta[] = [
    {
      id: "engine.rpm",
      display_name: "RPM",
      units: "rpm",
      group: "Engine",
      color: "#fff",
      decimals: 0,
      data_type: "f64",
      source: "csv",
      sample_rate_hz: 100,
      source_header: "Engine RPM",
    },
  ];
  store.addRateGroup(rg, metas);
  return store;
}

describe("ChannelStore.addChannel — replace path (regression: stale source_header)", () => {
  it("replacing a channel with a new source_header clears the old binding", () => {
    const store = makeStore();

    // Confirm original binding exists.
    const headers = store.listSourceHeaders().map((h) => h.sourceHeader);
    expect(headers).toContain("Engine RPM");

    // Replace engine.rpm with a new meta that has a different source_header.
    store.addChannel(
      "100hz",
      {
        id: "engine.rpm",
        display_name: "RPM (replaced)",
        units: "rpm",
        group: "Engine",
        color: "#ff0",
        decimals: 0,
        data_type: "f64",
        source: "csv",
        sample_rate_hz: 100,
        source_header: "Engine Speed",  // different header
      },
      Float64Array.from([4000, 5000, 6000]),
    );

    const headersAfter = store.listSourceHeaders().map((h) => h.sourceHeader);
    // Old header must be gone; new header must be present.
    expect(headersAfter).not.toContain("Engine RPM");
    expect(headersAfter).toContain("Engine Speed");
  });

  it("replacing with the same source_header leaves the binding intact", () => {
    const store = makeStore();
    store.addChannel(
      "100hz",
      {
        id: "engine.rpm",
        display_name: "RPM (same header)",
        units: "rpm",
        group: "Engine",
        color: "#ff0",
        decimals: 0,
        data_type: "f64",
        source: "csv",
        sample_rate_hz: 100,
        source_header: "Engine RPM",  // same header
      },
      Float64Array.from([7000, 8000, 9000]),
    );

    const headersAfter = store.listSourceHeaders().map((h) => h.sourceHeader);
    expect(headersAfter).toContain("Engine RPM");
    // Reads should return the updated values. slice() is half-open
    // [startUs, endUs), so widen past the last sample (20_000) to include it.
    const slice = store.slice(["engine.rpm"], { startUs: 0, endUs: 20_001 });
    expect(Array.from(slice.data.get("engine.rpm")!)).toEqual([7000, 8000, 9000]);
  });

  it("stale override is cleared when the old source_header is removed by replacement", () => {
    const store = makeStore();
    // Add a second channel that we'll use as an override target.
    store.addChannel(
      "100hz",
      {
        id: "engine.throttle",
        display_name: "TPS",
        units: "%",
        group: "Engine",
        color: "#0f0",
        decimals: 1,
        data_type: "f64",
        source: "csv",
        sample_rate_hz: 100,
        source_header: "Engine RPM",  // same as original engine.rpm header — can't coexist
        // (first-write-wins means this won't register, tested separately)
      },
      Float64Array.from([10, 20, 30]),
    );

    // Set an override for engine.throttle using its own source_header.
    // This exercises the override-clearing path when a source_header disappears.
    // (Simpler: set override for engine.rpm → "Engine RPM", then replace.)
    store.setChannelOverride("engine.rpm", "Engine RPM");
    expect(store.getChannelOverride("engine.rpm")).toBe("Engine RPM");

    // Now replace engine.rpm with a different source_header.
    store.addChannel(
      "100hz",
      {
        id: "engine.rpm",
        display_name: "RPM v2",
        units: "rpm",
        group: "Engine",
        color: "#fff",
        decimals: 0,
        data_type: "f64",
        source: "csv",
        sample_rate_hz: 100,
        source_header: "Engine Speed New",
      },
      Float64Array.from([100, 200, 300]),
    );

    // Override pointing at old "Engine RPM" source_header must be cleared.
    expect(store.getChannelOverride("engine.rpm")).toBeUndefined();
  });
});
