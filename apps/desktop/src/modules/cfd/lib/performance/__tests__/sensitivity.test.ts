import { describe, it, expect } from "vitest";
import { designSensitivities } from "../sensitivity";
import { SDM26_VEHICLE, REFERENCE_2026, EMPTY_BASELINE } from "../vehicle";
import type { TorqueCurve } from "../torqueCurve";

// Synthetic but plausible restricted-600 torque curve.
const CURVE: TorqueCurve = Array.from({ length: 19 }, (_, i) => {
  const rpm = 4500 + i * 500;
  return { rpm, torqueNm: 45 - Math.pow((rpm - 9000) / 4500, 2) * 12 };
});

describe("designSensitivities", () => {
  it("each lever produces finite events and the expected directions", () => {
    const { base, rows } = designSensitivities(CURVE, SDM26_VEHICLE, REFERENCE_2026);
    expect(rows).toHaveLength(9); // 7 core levers + 2 ARB-balance (roll model present)
    for (const r of rows) {
      expect(Number.isFinite(r.events.autocross.lapTimeS)).toBe(true);
      expect(r.dPoints).not.toBeNull();
    }
    // Less mass and more grip must not make the car slower in autocross.
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by["mass"]!.dAxS).toBeLessThanOrEqual(0);
    expect(by["grip"]!.dAxS).toBeLessThan(0);
    expect(base.totalPoints).not.toBeNull();
  });

  it("rows are ranked by |Δpoints| when a baseline is scorable", () => {
    const { rows } = designSensitivities(CURVE, SDM26_VEHICLE, REFERENCE_2026);
    for (let i = 1; i < rows.length; i++) {
      expect(Math.abs(rows[i - 1]!.dPoints!)).toBeGreaterThanOrEqual(Math.abs(rows[i]!.dPoints!));
    }
  });

  it("works without a baseline (deltas in seconds, null points)", () => {
    const { rows } = designSensitivities(CURVE, SDM26_VEHICLE, EMPTY_BASELINE);
    expect(rows.every((r) => r.dPoints === null)).toBe(true);
    expect(rows.every((r) => Number.isFinite(r.dAxS))).toBe(true);
  });

  it("grip lever scales the tire model when one is present", () => {
    const tire = {
      label: "synth", fz0: 2000, dpi: 0, radiusM: null,
      pdx1: 2.0, pdx2: -0.1, ppx3: 0, ppx4: 0, lmux: 1,
      pdy1: -2.5, pdy2: 0.2, ppy3: 0, ppy4: 0, lmuy: 1,
      scale: 0.7, scaleLong: 0.7,
    };
    const { rows } = designSensitivities(CURVE, { ...SDM26_VEHICLE, tire }, REFERENCE_2026);
    const grip = rows.find((r) => r.key === "grip")!;
    expect(grip.dAxS).toBeLessThan(0);
  });
});
