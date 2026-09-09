import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { gpsTrackWidget } from "../src/gps-track";
import { CursorEmitter } from "@helios/lib";

/** Count of FakeMap instances built by the maplibre-gl mock in tests/setup.ts. */
function mapConstructions(): number {
  return (globalThis as unknown as { __mapConstructions?: number }).__mapConstructions ?? 0;
}
function resetMapConstructions(): void {
  (globalThis as unknown as { __mapConstructions?: number }).__mapConstructions = 0;
}
/** Poll until the widget has built `expected` maps, or give up after `ms`. */
async function waitForMaps(expected: number, ms = 3000): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms && mapConstructions() !== expected) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return mapConstructions();
}
/** Settle the (already-resolved, module-memoised) maplibre import chain. */
async function flushImport(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 1));
}

describe("GpsTrack", () => {
  it("renders 'no GPS data' when channels missing", () => {
    const { container } = render(<gpsTrackWidget.Render
      config={{ latChannelId: "gps.lat", lonChannelId: "gps.lon" }}
      slice={{ time: new BigInt64Array(0), data: new Map(), range: { startUs: 0, endUs: 0 } }}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 0 }}
    />);
    expect(container.querySelector("canvas")).not.toBeNull();
  });

  it("renders track when GPS samples present", () => {
    const time = BigInt64Array.from([0n, 1000n, 2000n, 3000n]);
    const lat = Float64Array.from([33.42, 33.4205, 33.421, 33.42]);
    const lon = Float64Array.from([-111.92, -111.921, -111.922, -111.92]);
    const { container } = render(<gpsTrackWidget.Render
      config={{ latChannelId: "gps.lat", lonChannelId: "gps.lon" }}
      slice={{ time, data: new Map([["gps.lat", lat], ["gps.lon", lon]]), range: { startUs: 0, endUs: 3000 } }}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 3000 }}
    />);
    expect(container.querySelector("canvas")).not.toBeNull();
  });

  it("builds a map when a basemap is selected", async () => {
    resetMapConstructions();
    render(<gpsTrackWidget.Render
      config={{ latChannelId: "gps.lat", lonChannelId: "gps.lon", basemap: "dark" }}
      slice={{ time: new BigInt64Array(0), data: new Map(), range: { startUs: 0, endUs: 0 } }}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 0 }}
    />);
    expect(await waitForMaps(1)).toBe(1);
  });

  it("never builds a map for a widget unmounted before maplibre loads", async () => {
    resetMapConstructions();
    const { unmount } = render(<gpsTrackWidget.Render
      config={{ latChannelId: "gps.lat", lonChannelId: "gps.lon", basemap: "satellite" }}
      slice={{ time: new BigInt64Array(0), data: new Map(), range: { startUs: 0, endUs: 0 } }}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 0 }}
    />);
    unmount();
    await flushImport();
    expect(mapConstructions()).toBe(0);
  });

  it("requiredChannels includes colorBy when set", () => {
    expect(gpsTrackWidget.requiredChannels({
      latChannelId: "gps.lat", lonChannelId: "gps.lon", colorByChannelId: "engine.rpm",
    })).toContain("engine.rpm");
  });
});
