import { describe, expect, it } from "vitest";
import {
  WAVE_FIELD_META,
  computeMach,
  fieldRange,
  GAMMA_AIR,
  R_AIR,
  P_ATM,
} from "../fields";

describe("WAVE_FIELD_META", () => {
  it("has entries for every WaveField", () => {
    for (const k of ["p", "u", "T", "rho", "Mach"] as const) {
      expect(WAVE_FIELD_META[k]).toBeDefined();
      expect(WAVE_FIELD_META[k].label).toBeTruthy();
      expect(WAVE_FIELD_META[k].unit).toBeTruthy();
      expect(WAVE_FIELD_META[k].colormap).toBeDefined();
    }
  });

  it("centers pressure at atmospheric and velocity at zero", () => {
    expect(WAVE_FIELD_META.p.centerOn).toBe(P_ATM);
    expect(WAVE_FIELD_META.u.centerOn).toBe(0);
    expect(WAVE_FIELD_META.T.centerOn).toBeNull();
    expect(WAVE_FIELD_META.rho.centerOn).toBeNull();
    expect(WAVE_FIELD_META.Mach.centerOn).toBeNull();
  });
});

describe("computeMach", () => {
  it("matches u / sqrt(gamma R T) for known inputs", () => {
    const u = 100;
    const T = 300;
    const c = Math.sqrt(GAMMA_AIR * R_AIR * T);
    expect(computeMach(u, T)).toBeCloseTo(u / c, 6);
  });
  it("returns 0 when T <= 0 (guard)", () => {
    expect(computeMach(100, 0)).toBe(0);
    expect(computeMach(100, -5)).toBe(0);
  });
  it("supports negative velocity (reverse flow)", () => {
    expect(computeMach(-100, 300)).toBeLessThan(0);
  });
});

describe("fieldRange", () => {
  it("returns symmetric ±max(|min-ref|, |max-ref|) for centered fields", () => {
    const r = fieldRange("p", { min: P_ATM - 5000, max: P_ATM + 8000 });
    expect(r.vmin).toBeCloseTo(P_ATM - 8000);
    expect(r.vmax).toBeCloseTo(P_ATM + 8000);
  });
  it("returns [min, max] for sequential fields", () => {
    const r = fieldRange("T", { min: 300, max: 1800 });
    expect(r.vmin).toBe(300);
    expect(r.vmax).toBe(1800);
  });
  it("returns [0, max] for Mach", () => {
    const r = fieldRange("Mach", { min: -0.1, max: 0.6 });
    expect(r.vmin).toBe(0);
    expect(r.vmax).toBe(0.6);
  });
});
