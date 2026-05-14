import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { sectorTableWidget } from "../src/sector-table";
import { CursorEmitter } from "@helios/lib";
import type { LapSet } from "@helios/lib";
import type { ChannelSlice } from "@helios/store";
import type { OverlaySession } from "../src/types";

function syntheticSession(opts: {
  durationS: number;
  speedMps: number;
  label: string;
  lapCount: number;
}): OverlaySession {
  const sampleHz = 50;
  const lapDurationS = opts.durationS / opts.lapCount;
  const n = Math.round(opts.durationS * sampleHz) + 1;
  const time = new BigInt64Array(n);
  const speed = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    time[i] = BigInt(Math.round((i / sampleHz) * 1_000_000));
    speed[i] = opts.speedMps;
  }
  const laps: LapSet["laps"] = [];
  for (let k = 0; k < opts.lapCount; k++) {
    laps.push({
      index: k + 1,
      startUs: Math.round(k * lapDurationS * 1_000_000),
      endUs: Math.round((k + 1) * lapDurationS * 1_000_000),
      durationS: lapDurationS,
      distanceM: lapDurationS * opts.speedMps,
      trusted: true,
    });
  }
  const slice: ChannelSlice = {
    time,
    data: new Map([["gps.speed", speed]]),
    range: { startUs: 0, endUs: opts.durationS * 1_000_000 },
  };
  return {
    id: opts.label,
    label: opts.label,
    color: "#FFC627",
    slice,
    range: slice.range,
    isPrimary: true,
    laps: { laps, bestLapIndex: 0, cacheKey: `synthetic:${opts.label}` },
  };
}

describe("sectorTableWidget", () => {
  it("registers with the expected type + default 3 sectors", () => {
    expect(sectorTableWidget.type).toBe("sector_table");
    expect(sectorTableWidget.defaultConfig.sectorCount).toBe(3);
    expect(sectorTableWidget.requiredChannels(sectorTableWidget.defaultConfig)).toEqual([]);
  });

  it("renders one row per visible lap plus the optimal row", () => {
    const session = syntheticSession({ durationS: 90, speedMps: 10, label: "S1", lapCount: 3 });
    const { container } = render(<sectorTableWidget.Render
      config={{ sectorCount: 3, maxRows: 8, hideUntrusted: false }}
      slice={session.slice}
      cursorEmitter={new CursorEmitter()}
      timeRange={session.range}
      overlays={[session]}
    />);
    // 3 lap rows + 1 opt row + 1 header row.
    const rows = container.querySelectorAll("tbody tr");
    expect(rows.length).toBe(4);
    // Last row is the optimal — labeled "opt".
    expect(rows[rows.length - 1]!.textContent).toMatch(/opt/);
  });

  it("shows the helpful empty-state message when no speed channel is present", () => {
    const slice: ChannelSlice = { time: new BigInt64Array(0), data: new Map(), range: { startUs: 0, endUs: 1000 } };
    const session: OverlaySession = {
      id: "x", label: "x", color: "#FFC627",
      slice, range: slice.range, isPrimary: true,
      laps: { laps: [], bestLapIndex: -1, cacheKey: "empty" },
    };
    const { container } = render(<sectorTableWidget.Render
      config={{ sectorCount: 3, maxRows: 8, hideUntrusted: false }}
      slice={slice}
      cursorEmitter={new CursorEmitter()}
      timeRange={slice.range}
      overlays={[session]}
    />);
    expect(container.textContent).toMatch(/lap detection/i);
  });
});
