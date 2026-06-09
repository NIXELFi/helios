import { describe, it, expect } from "vitest";

import { sprocketOptions, sweepFinalDrive, comboLabel } from "../../lib/performance/fdOptimizer";
import { SDM26_VEHICLE, REFERENCE_2026 } from "../../lib/performance";
import type { TorqueCurve } from "../../lib/performance";

const CURVE: TorqueCurve = Array.from({ length: 12 }, (_, i) => ({
  rpm: 4000 + i * 1000,
  torqueNm: 60 - i * 2,
}));

describe("sprocketOptions", () => {
  it("returns unique sorted ratios with every tooth pair that lands on them", () => {
    const opts = sprocketOptions();
    const fd3 = opts.find((o) => o.fd === 3.0)!;
    // 36/12 = 42/14 = 45/15 = 48/16 = 3.0 — all real pairs listed.
    expect(fd3.combos.map(comboLabel)).toEqual(
      expect.arrayContaining(["36/12", "42/14", "45/15", "48/16"]),
    );
    const fds = opts.map((o) => o.fd);
    expect(fds).toEqual([...fds].sort((a, b) => a - b));
    expect(new Set(fds).size).toBe(fds.length);
    expect(fds.every((fd) => fd >= 2.4 && fd <= 4.4)).toBe(true);
  });
});

describe("sweepFinalDrive", () => {
  it("scores each ratio with the production event chain (current FD included)", () => {
    const opts = sprocketOptions(2.8, 3.4);
    const rows = sweepFinalDrive(CURVE, SDM26_VEHICLE, REFERENCE_2026, opts);
    expect(rows).toHaveLength(opts.length);
    expect(rows.some((r) => r.fd === 3.0)).toBe(true); // SDM26's actual FD is sweepable
    for (const r of rows) {
      expect(r.events.endurance.lapTimeS).toBeGreaterThan(0);
      expect(r.events.totalPoints).not.toBeNull(); // REFERENCE_2026 → scorable
    }
    // FD must actually move the result — different ratios, different laps.
    const times = new Set(rows.map((r) => r.events.endurance.lapTimeS.toFixed(3)));
    expect(times.size).toBeGreaterThan(1);
  });
});
