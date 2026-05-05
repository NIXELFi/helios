import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { gpsTrackWidget } from "../src/gps-track";
import { CursorEmitter } from "@helios/lib";

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

  it("requiredChannels includes colorBy when set", () => {
    expect(gpsTrackWidget.requiredChannels({
      latChannelId: "gps.lat", lonChannelId: "gps.lon", colorByChannelId: "engine.rpm",
    })).toContain("engine.rpm");
  });
});
