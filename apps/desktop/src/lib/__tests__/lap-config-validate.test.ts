/** Persisted lap configs are shape-checked on load; bad entries are dropped
 *  so the session falls back to its default config. */

import { beforeEach, describe, expect, it } from "vitest";
import { isValidLapConfig, loadAllLapConfigs, loadLapConfig, MAX_MANUAL_CROSSINGS } from "../lap-config";

describe("lap-config load validation", () => {
  beforeEach(() => localStorage.clear());

  it("accepts the shapes the dialog saves", () => {
    expect(isValidLapConfig({ mode: "none" })).toBe(true);
    expect(isValidLapConfig({ mode: "gps_line" })).toBe(true); // mode switched, fields untouched
    expect(isValidLapConfig({
      mode: "gps_line",
      gpsLine: { latChannelId: "gps.lat", lonChannelId: "gps.lon", centerLat: 33.4, centerLon: -111.9, radiusM: 30, headingDeg: null },
      speedChannelId: "gps.speed",
    })).toBe(true);
    expect(isValidLapConfig({ mode: "beacon", beacon: { channelId: "system.beacon", threshold: 0.5 } })).toBe(true);
    expect(isValidLapConfig({ mode: "manual", manual: { crossingsUs: [1_000_000, 2_000_000] } })).toBe(true);
  });

  it("rejects malformed or oversized configs", () => {
    expect(isValidLapConfig(null)).toBe(false);
    expect(isValidLapConfig({ mode: "warp" })).toBe(false);
    expect(isValidLapConfig({ mode: "beacon", beacon: { channelId: 3, threshold: 0.5 } })).toBe(false);
    expect(isValidLapConfig({ mode: "gps_line", gpsLine: { latChannelId: "a", lonChannelId: "b", centerLat: 0, centerLon: 0, radiusM: "30" } })).toBe(false);
    expect(isValidLapConfig({ mode: "manual", manual: { crossingsUs: [1, null] } })).toBe(false);
    expect(isValidLapConfig({
      mode: "manual", manual: { crossingsUs: new Array(MAX_MANUAL_CROSSINGS + 1).fill(1) },
    })).toBe(false);
  });

  it("drops only the bad entries from the stored blob", () => {
    localStorage.setItem("helios.lap-config.v1", JSON.stringify({
      version: 1,
      bySession: { good: { mode: "none" }, bad: { mode: "manual", manual: { crossingsUs: "x" } } },
    }));
    expect(Object.keys(loadAllLapConfigs())).toEqual(["good"]);
    expect(loadLapConfig("bad")).toBeNull();
  });
});
