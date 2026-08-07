import { describe, it, expect } from "vitest";
import { findSpeed, SPEED_CHANNEL_CANDIDATES } from "../src/lib/speed";
import type { OverlaySession } from "../src/types";

function makeSession(
  channels: Record<string, Float64Array>,
  opts?: { speedChannelId?: string; speedChannelUnit?: string },
): OverlaySession {
  const range = { startUs: 0, endUs: 1_000_000 };
  return {
    id: "s1",
    label: "s1",
    color: "#FFC627",
    slice: { time: new BigInt64Array(0), data: new Map(Object.entries(channels)), range },
    range,
    isPrimary: true,
    ...opts,
  };
}

describe("SPEED_CHANNEL_CANDIDATES", () => {
  it("lists the well-known ids in fallback preference order", () => {
    expect(SPEED_CHANNEL_CANDIDATES.map((c) => c.id)).toEqual([
      "gps.speed", "vehicle.speed", "wheel.speed_avg", "engine.wheel_speed_avg",
    ]);
  });
});

describe("findSpeed", () => {
  it("returns null when the slice has no speed channel", () => {
    expect(findSpeed(makeSession({ "engine.rpm": Float64Array.from([3000]) }))).toBeNull();
  });

  it("falls back through the candidates in order", () => {
    const wheel = Float64Array.from([90]);
    const vehicle = Float64Array.from([100]);
    const r = findSpeed(makeSession({ "wheel.speed_avg": wheel, "vehicle.speed": vehicle }));
    expect(r?.values).toBe(vehicle);
    expect(r?.unit).toBe("km/h");
  });

  it("prefers gps.speed (m/s) over the km/h candidates", () => {
    const gps = Float64Array.from([28]);
    const r = findSpeed(makeSession({ "vehicle.speed": Float64Array.from([100]), "gps.speed": gps }));
    expect(r?.values).toBe(gps);
    expect(r?.unit).toBe("m/s");
  });

  it("prefers the host-provided speedChannelId over every candidate", () => {
    const custom = Float64Array.from([62]);
    const r = findSpeed(makeSession(
      { "gps.speed": Float64Array.from([28]), "chassis.speed_custom": custom },
      { speedChannelId: "chassis.speed_custom", speedChannelUnit: "mph" },
    ));
    expect(r?.values).toBe(custom);
    expect(r?.unit).toBe("mph");
  });

  it("defaults the host-provided channel's unit to m/s when none is given", () => {
    const custom = Float64Array.from([28]);
    const r = findSpeed(makeSession(
      { "chassis.speed_custom": custom },
      { speedChannelId: "chassis.speed_custom" },
    ));
    expect(r?.values).toBe(custom);
    expect(r?.unit).toBe("m/s");
  });

  it("falls back to the candidates when the host-provided channel is absent from the slice", () => {
    const vehicle = Float64Array.from([100]);
    const r = findSpeed(makeSession(
      { "vehicle.speed": vehicle },
      { speedChannelId: "chassis.speed_custom", speedChannelUnit: "mph" },
    ));
    expect(r?.values).toBe(vehicle);
    expect(r?.unit).toBe("km/h");
  });
});
