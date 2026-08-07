import { describe, it, expect } from "vitest";
import type { ChannelMeta } from "@helios/store";
import {
  channelStats, deltaTint, displayMeta, formatDelta, formatValue,
} from "../src/values-table/compute";

function meta(over: Partial<ChannelMeta>): ChannelMeta {
  return {
    id: "engine.rpm", display_name: "RPM", units: "rpm", group: "Engine",
    color: "#FFC627", decimals: 0, data_type: "f64", source: "csv",
    sample_rate_hz: 100,
    ...over,
  };
}

describe("displayMeta", () => {
  it("resolves display name, units and decimals from the channel list", () => {
    const m = displayMeta("engine.rpm", [meta({})]);
    expect(m).toEqual({ label: "RPM", units: "rpm", decimals: 0 });
  });

  it("falls back to raw id / no unit / 2 decimals for unknown channels", () => {
    expect(displayMeta("nope", [meta({})])).toEqual({ label: "nope", units: "", decimals: 2 });
    expect(displayMeta("nope", undefined)).toEqual({ label: "nope", units: "", decimals: 2 });
  });

  it("falls back to the id when display_name is empty", () => {
    const m = displayMeta("engine.rpm", [meta({ display_name: "" })]);
    expect(m.label).toBe("engine.rpm");
  });

  it("sanitizes malformed decimals so toFixed can never throw", () => {
    expect(displayMeta("engine.rpm", [meta({ decimals: -1 })]).decimals).toBe(2);
    expect(displayMeta("engine.rpm", [meta({ decimals: 2.5 })]).decimals).toBe(2);
    expect(displayMeta("engine.rpm", [meta({ decimals: NaN })]).decimals).toBe(2);
    expect(displayMeta("engine.rpm", [meta({ decimals: 99 })]).decimals).toBe(2);
  });
});

describe("formatValue", () => {
  it("renders — for missing or non-finite samples", () => {
    expect(formatValue(null, 2)).toBe("—");
    expect(formatValue(NaN, 2)).toBe("—");
    expect(formatValue(Infinity, 2)).toBe("—");
  });

  it("renders fixed-point at the channel's precision", () => {
    expect(formatValue(1.234, 2)).toBe("1.23");
    expect(formatValue(1.234, 0)).toBe("1");
    expect(formatValue(-0.5, 1)).toBe("-0.5");
  });
});

describe("deltaTint", () => {
  it("is neutral when the delta rounds to zero at display precision", () => {
    // Matches the footer's ±0.005 threshold at its 2-decimal display.
    expect(deltaTint(0.004, 2)).toBe("zero");
    expect(deltaTint(-0.004, 2)).toBe("zero");
    expect(deltaTint(0.4, 0)).toBe("zero");
  });

  it("classifies by sign past the display threshold", () => {
    expect(deltaTint(0.006, 2)).toBe("pos");
    expect(deltaTint(-0.006, 2)).toBe("neg");
    expect(deltaTint(3, 0)).toBe("pos");
  });

  it("treats missing deltas as neutral", () => {
    expect(deltaTint(null, 2)).toBe("zero");
    expect(deltaTint(NaN, 2)).toBe("zero");
  });
});

describe("formatDelta", () => {
  it("renders — for missing deltas", () => {
    expect(formatDelta(null, 2)).toBe("—");
    expect(formatDelta(NaN, 2)).toBe("—");
  });

  it("signs non-zero deltas with + / − (true minus)", () => {
    expect(formatDelta(3, 2)).toBe("+3.00");
    expect(formatDelta(-0.25, 2)).toBe("−0.25");
  });

  it("renders display-zero deltas unsigned", () => {
    expect(formatDelta(0, 2)).toBe("0.00");
    expect(formatDelta(0.004, 2)).toBe("0.00");
    expect(formatDelta(-0.004, 2)).toBe("0.00");
  });
});

function slice(vals: Record<string, number[]>) {
  const n = Object.values(vals)[0]?.length ?? 0;
  const time = new BigInt64Array(n);
  for (let i = 0; i < n; i++) time[i] = BigInt(i * 100_000); // 10 Hz
  const data = new Map<string, Float64Array>();
  for (const [id, arr] of Object.entries(vals)) data.set(id, Float64Array.from(arr));
  return { time, data };
}

describe("channelStats", () => {
  const s = slice({ "engine.rpm": [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20] });

  it("aggregates min / max / avg over the full window", () => {
    const st = channelStats(s, "engine.rpm", 0, 1_000_000);
    expect(st).toEqual({ min: 0, max: 20, avg: 10, n: 11 });
  });

  it("restricts to a zoom sub-window", () => {
    // [0, 500ms] → samples 0..5 → values 0,2,4,6,8,10.
    const st = channelStats(s, "engine.rpm", 0, 500_000);
    expect(st).toEqual({ min: 0, max: 10, avg: 5, n: 6 });
  });

  it("returns null for a channel absent from the slice", () => {
    expect(channelStats(s, "nope", 0, 1_000_000)).toBeNull();
  });

  it("returns null when the window holds no samples", () => {
    expect(channelStats(s, "engine.rpm", 2_000_000, 3_000_000)).toBeNull();
  });

  it("skips non-finite samples without ending the window", () => {
    const gappy = slice({ ch: [1, NaN, 3] });
    const st = channelStats(gappy, "ch", 0, 1_000_000);
    expect(st).toEqual({ min: 1, max: 3, avg: 2, n: 2 });
  });
});
