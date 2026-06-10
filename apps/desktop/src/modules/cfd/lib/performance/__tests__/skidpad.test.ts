// Skidpad anchor regression: SDM26 ran a REAL 5.02 s skidpad at comp
// (stickers), and the default muLat is pinned to reproduce it. If a grip-model
// change moves this, the calibration chain (muLat ← skidpad, LINE_FACTOR ←
// autocross, tir scaleLong ← accel, pace/eff ← Mines) must be re-solved —
// see the constants' comments.

import { describe, it, expect } from "vitest";
import { predictSkidpad, SKIDPAD_PATH_RADIUS_M } from "../lapSim";
import { SDM26_VEHICLE } from "../vehicle";

describe("skidpad prediction", () => {
  it("reproduces SDM26's real 5.02 s comp skidpad with the default vehicle", () => {
    const p = predictSkidpad(SDM26_VEHICLE);
    expect(p.timeS).toBeGreaterThan(4.97);
    expect(p.timeS).toBeLessThan(5.07);
    // physical sanity: ~1.4-1.5 g at the 9.125 m path, low-speed (little aero)
    expect(p.latG).toBeGreaterThan(1.3);
    expect(p.latG).toBeLessThan(1.6);
    expect(SKIDPAD_PATH_RADIUS_M).toBeCloseTo(9.125, 6);
  });
});
