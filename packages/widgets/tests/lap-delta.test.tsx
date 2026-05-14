import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { lapDeltaWidget } from "../src/lap-delta";
import { CursorEmitter, LapSelectionEmitter } from "@helios/lib";
import type { LapSet } from "@helios/lib";
import type { ChannelSlice } from "@helios/store";
import type { OverlaySession } from "../src/types";

// Build a synthetic single-lap session with constant speed, distance ~= time
// in meters since speed = 1 m/s.
function makeSyntheticSession(opts: {
  id: string;
  color: string;
  startUs: number;
  durationS: number;
  speedMps: number;
}): OverlaySession {
  const sampleHz = 50;
  const n = Math.round(opts.durationS * sampleHz) + 1;
  const time = new BigInt64Array(n);
  const speed = new Float64Array(n);
  const dtUs = Math.round(1_000_000 / sampleHz);
  for (let i = 0; i < n; i++) {
    time[i] = BigInt(opts.startUs + i * dtUs);
    speed[i] = opts.speedMps;
  }
  const slice: ChannelSlice = {
    time,
    data: new Map([["gps.speed", speed]]),
    range: { startUs: opts.startUs, endUs: opts.startUs + opts.durationS * 1_000_000 },
  };
  // Hand-build a single trusted LapSet covering the whole synthetic session.
  // Going through detectLaps would require feeding it a beacon channel with
  // a sensible pair of crossings; for a 2-test mount check the direct
  // construction is plenty.
  const laps2: LapSet = {
    laps: [{
      index: 1,
      startUs: opts.startUs,
      endUs: opts.startUs + opts.durationS * 1_000_000,
      durationS: opts.durationS,
      distanceM: opts.durationS * opts.speedMps,
      trusted: true,
    }],
    bestLapIndex: 0,
    cacheKey: `synthetic:${opts.id}`,
  };
  return {
    id: opts.id,
    label: opts.id,
    color: opts.color,
    slice,
    range: slice.range,
    isPrimary: opts.id === "main",
    laps: laps2,
  };
}

describe("lapDeltaWidget", () => {
  it("registers with the expected type and empty default config", () => {
    expect(lapDeltaWidget.type).toBe("lap_delta");
    expect(lapDeltaWidget.defaultConfig).toEqual({});
    expect(lapDeltaWidget.requiredChannels({})).toEqual([]);
  });

  it("renders the empty-state message when no Main is selected", () => {
    const session = makeSyntheticSession({ id: "main", color: "#FFC627", startUs: 0, durationS: 10, speedMps: 10 });
    const { container } = render(<lapDeltaWidget.Render
      config={{}}
      slice={session.slice}
      cursorEmitter={new CursorEmitter()}
      timeRange={session.range}
      overlays={[session]}
      lapSelectionEmitter={new LapSelectionEmitter()}
      lapSelection={{ main: null, ref: null, overlays: [] }}
    />);
    expect(container.textContent).toMatch(/Pick a Main lap/);
  });

  it("renders the final delta when Main and Ref are both selected", () => {
    const main = makeSyntheticSession({ id: "main", color: "#FFC627", startUs: 0, durationS: 20, speedMps: 10 });
    const ref = makeSyntheticSession({ id: "ref",  color: "#4FC3F7", startUs: 1_000_000_000, durationS: 10, speedMps: 20 });
    const emitter = new LapSelectionEmitter();
    emitter.setMain({ sessionId: "main", lapIndex: 0 });
    emitter.setRef({ sessionId: "ref", lapIndex: 0 });
    const { container } = render(<lapDeltaWidget.Render
      config={{}}
      slice={main.slice}
      cursorEmitter={new CursorEmitter()}
      timeRange={main.range}
      overlays={[main, ref]}
      lapSelectionEmitter={emitter}
      lapSelection={emitter.get()}
    />);
    const finalEl = container.querySelector('[data-testid="lap-delta-final"]');
    expect(finalEl).not.toBeNull();
    // Main 10 m/s over 200m vs Ref 20 m/s over 200m → Main is 10s slower at end.
    expect(finalEl!.textContent).toMatch(/\+(?:9|10|11)\./);  // ≈+10s, allow rounding slack
  });
});
