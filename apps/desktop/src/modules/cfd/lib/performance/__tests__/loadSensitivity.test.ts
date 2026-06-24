import { describe, it, expect } from "vitest";

import { dropoffPctFromSens, sensFromDropoffPct } from "../loadSensitivity";

// The tire load-sensitivity exponent `sens` (VehicleConfig.tireLoadSensitivity)
// is the source of truth in the grip model: μ_eff = μ·(Fz/Fz_static)^(−sens)
// (lapSim.ts:261). The %dropoff framing restates that EXACTLY as the grip lost
// per load DOUBLING: at Fz = 2·Fz_static, μ_eff/μ = 2^(−sens), so the fractional
// drop is 1 − 2^(−sens) and the percentage is (1 − 2^(−sens))·100.
describe("loadSensitivity — %dropoff ↔ sens", () => {
  it("dropoffPctFromSens matches the closed-form (1 − 2^(−sens))·100", () => {
    for (const sens of [0, 0.05, 0.1, 0.15, 0.2, 0.3]) {
      const expected = (1 - Math.pow(2, -sens)) * 100;
      expect(dropoffPctFromSens(sens)).toBeCloseTo(expected, 9);
    }
  });

  it("sens = 0 ⇒ 0% drop (load-independent μ)", () => {
    expect(dropoffPctFromSens(0)).toBeCloseTo(0, 12);
    expect(sensFromDropoffPct(0)).toBeCloseTo(0, 12);
  });

  it("the Hoosier-slick default sens = 0.15 ≈ 9.9% drop per doubling", () => {
    // 1 − 2^(−0.15) = 0.0987… → ~9.87%. Anchors the displayed chip value.
    expect(dropoffPctFromSens(0.15)).toBeCloseTo(9.872, 2);
  });

  it("round-trips sens → %drop → sens (inverse is exact)", () => {
    for (const sens of [0, 0.03, 0.1, 0.15, 0.22, 0.3]) {
      expect(sensFromDropoffPct(dropoffPctFromSens(sens))).toBeCloseTo(sens, 9);
    }
  });

  it("round-trips %drop → sens → %drop", () => {
    for (const pct of [0, 2.5, 5, 9.872, 15, 18]) {
      expect(dropoffPctFromSens(sensFromDropoffPct(pct))).toBeCloseTo(pct, 9);
    }
  });

  it("is monotone increasing in sens (more sensitivity ⇒ more drop)", () => {
    let prev = -1;
    for (const sens of [0, 0.05, 0.1, 0.2, 0.3]) {
      const d = dropoffPctFromSens(sens);
      expect(d).toBeGreaterThan(prev);
      prev = d;
    }
  });
});
