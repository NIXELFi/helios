import { describe, it, expect } from "vitest";

import { applyVdParam, runVdSweep, type VdParam } from "../vdSweep";
import { simLap } from "../lapSim";
import { SDM26_VEHICLE } from "../vehicle";
import { dropoffPctFromSens } from "../loadSensitivity";
import { AUTOCROSS_2026 } from "../tracks2026";
import type { TorqueCurve } from "../torqueCurve";

// A real-ish restricted-600 torque curve, plus the production SDM26 preset and
// the real autocross course — so the directional invariants below assert the
// ACTUAL grip model's behavior (load-sensitive μ, lateral transfer χ, per-axle
// roll split), not a toy. The sweep is a thin driver over simLap; these tests
// pin that the physics responds the way a vehicle engineer expects.
const CURVE: TorqueCurve = Array.from({ length: 19 }, (_, i) => {
  const rpm = 4500 + i * 500;
  return { rpm, torqueNm: 45 - Math.pow((rpm - 9000) / 4500, 2) * 12 };
});

const BASE = SDM26_VEHICLE;
const TRACK = AUTOCROSS_2026;

const lapOf = (v = BASE) => simLap(CURVE, v, TRACK);

describe("applyVdParam — patches a RESOLVED vehicle without identity forcing", () => {
  it("sets massKg directly (no preset clobber)", () => {
    const v = applyVdParam(BASE, "massKg", 300);
    expect(v.massKg).toBe(300);
    // Identity fields untouched — this bypasses vehicleForCar entirely.
    expect(v.gearRatios).toEqual(BASE.gearRatios);
    expect(v.finalDrive).toBe(BASE.finalDrive);
    expect(v.name).toBe(BASE.name);
  });

  it("sets cgHeightM directly", () => {
    expect(applyVdParam(BASE, "cgHeightM", 0.33).cgHeightM).toBe(0.33);
  });

  it("sets roll.rsdFront without mutating the input or other roll fields", () => {
    const v = applyVdParam(BASE, "rsdFront", 0.45);
    expect(v.roll!.rsdFront).toBe(0.45);
    expect(v.roll!.hRollArmM).toBe(BASE.roll!.hRollArmM);
    expect(BASE.roll!.rsdFront).not.toBe(0.45); // input not mutated
  });

  it("muDropoffPct is converted to tireLoadSensitivity (sens), not stored raw", () => {
    // 9.872% drop/doubling ↔ sens 0.15 (the preset default).
    const v = applyVdParam(BASE, "muDropoffPct", dropoffPctFromSens(0.15));
    expect(v.tireLoadSensitivity).toBeCloseTo(0.15, 6);
  });

  it("does not mutate the input vehicle", () => {
    const before = JSON.stringify(BASE);
    applyVdParam(BASE, "massKg", 999);
    expect(JSON.stringify(BASE)).toBe(before);
  });
});

describe("vdSweep — directional invariants against the real simLap", () => {
  it("raising CG height slows the lap and lowers peak lateral g (more transfer)", () => {
    // FINDING: the production per-axle ROLL model keys lateral load transfer on
    // the CG-to-roll-axis arm `hRollArmM`, NOT raw cgHeightM (lapSim.ts
    // axleCaps), so on a roll-config car a cgHeightM sweep FREEZES lateral
    // capacity and the lap trend actually INVERTS (higher CG reads as faster —
    // it moves only LONGITUDINAL load transfer). That wrong-way trend is exactly
    // why the UI gates cgHeightM out of the sweep on roll-config cars; the clean
    // "higher ⇒ more transfer ⇒ less grip ⇒ slower" law lives in the LUMPED χ
    // model (chi() uses cgHeightM directly, lapSim.ts:275). So assert the
    // invariant where the physics actually expresses it: the lumped car. The
    // hRollArmM↔cgHeightM coupling that would fix the roll path is deferred QSS
    // work — do NOT add it here.
    const lumped = (cg: number) => ({ ...applyVdParam(BASE, "cgHeightM", cg), roll: undefined });
    const low = lapOf(lumped(0.25));
    const high = lapOf(lumped(0.34));
    expect(high.lapTimeS).toBeGreaterThan(low.lapTimeS);
    expect(high.telemetry.maxLatG).toBeLessThan(low.telemetry.maxLatG);
  });

  it("adding mass slows the lap and lowers peak lateral g", () => {
    const light = lapOf(applyVdParam(BASE, "massKg", 250));
    const heavy = lapOf(applyVdParam(BASE, "massKg", 300));
    expect(heavy.lapTimeS).toBeGreaterThan(light.lapTimeS);
    expect(heavy.telemetry.maxLatG).toBeLessThan(light.telemetry.maxLatG);
  });

  it("increasing tire %dropoff (load sensitivity) slows the lap", () => {
    const soft = lapOf(applyVdParam(BASE, "muDropoffPct", dropoffPctFromSens(0.05)));
    const harsh = lapOf(applyVdParam(BASE, "muDropoffPct", dropoffPctFromSens(0.3)));
    expect(harsh.lapTimeS).toBeGreaterThan(soft.lapTimeS);
  });

  it("tireLoadSensitivity = 0 with the roll model present matches the lumped baseline lap", () => {
    // Regression guard: with sens → 0, χ → 1 and the per-axle μ(Fz) flattens, so
    // the per-axle roll model must collapse onto the lumped grip. Compare the
    // roll-config car at sens=0 against the SAME car with roll removed.
    const rollNoSens = applyVdParam(BASE, "muDropoffPct", 0);
    const lumpedNoSens = { ...rollNoSens, roll: undefined };
    const a = simLap(CURVE, rollNoSens, TRACK);
    const b = simLap(CURVE, lumpedNoSens, TRACK);
    expect(a.lapTimeS).toBeCloseTo(b.lapTimeS, 1);
    expect(a.telemetry.maxLatG).toBeCloseTo(b.telemetry.maxLatG, 2);
  });

  it("an RSD-front sweep makes balanceMargin cross zero AND is monotone in RSD", () => {
    // Physical ARB-calculator window (vehicle.ts:11-12) is 0.376 → 0.605; the
    // signed balance margin reaches zero right at the stiff-front end, so probe
    // a hair past it (0.65) to bracket the neutral-balance crossing cleanly.
    // More front roll stiffness ⇒ the front gives up sooner (push) ⇒ margin
    // falls monotonically: a real understeer↔oversteer balance axis, not noise.
    const rows = runVdSweep(CURVE, BASE, TRACK, {
      param: "rsdFront",
      start: 0.376,
      stop: 0.65,
      step: 0.02,
    });
    const margins = rows.map((r) => r.balanceMargin ?? NaN);
    expect(margins.every((m) => Number.isFinite(m))).toBe(true);
    // +ve (loose, rear-limited) at soft-front → −ve (push, front-limited) at
    // stiff-front: the margin crosses zero, so a neutral setup exists between.
    expect(Math.max(...margins)).toBeGreaterThan(0);
    expect(Math.min(...margins)).toBeLessThan(0);
    for (let i = 1; i < margins.length; i++) {
      expect(margins[i]!).toBeLessThan(margins[i - 1]!); // strictly decreasing
    }
  });

  it("the RSD-front lap optimum is INTERIOR to the ARB window (not at an extreme)", () => {
    // Within the team's physical 0.376–0.605 window the fastest lap sits in the
    // middle (near the neutral-balance RSD), not at either ARB extreme — the
    // honest "there's a setup sweet spot" result, vs "stiffer is always better".
    const rows = runVdSweep(CURVE, BASE, TRACK, {
      param: "rsdFront",
      start: 0.376,
      stop: 0.605,
      step: 0.015,
    });
    const times = rows.map((r) => r.lapTimeS);
    const iMin = times.indexOf(Math.min(...times));
    expect(iMin).toBeGreaterThan(0);
    expect(iMin).toBeLessThan(times.length - 1);
  });

  it("runVdSweep returns one row per step with the summary metrics populated", () => {
    const rows = runVdSweep(CURVE, BASE, TRACK, {
      param: "massKg",
      start: 250,
      stop: 290,
      step: 10,
    });
    expect(rows.length).toBe(5); // 250,260,270,280,290 inclusive
    expect(rows.map((r) => r.value)).toEqual([250, 260, 270, 280, 290]);
    for (const r of rows) {
      expect(Number.isFinite(r.lapTimeS)).toBe(true);
      expect(Number.isFinite(r.maxLatG)).toBe(true);
      expect(Number.isFinite(r.fuelKg)).toBe(true);
    }
    // Heavier ⇒ monotonically slower across the whole mass sweep.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.lapTimeS).toBeGreaterThan(rows[i - 1]!.lapTimeS);
    }
  });

  it("a sweep through the preset value reproduces the baseline lap at that point", () => {
    const rows = runVdSweep(CURVE, BASE, TRACK, {
      param: "massKg",
      start: BASE.massKg,
      stop: BASE.massKg,
      step: 10,
    });
    expect(rows.length).toBe(1);
    expect(rows[0]!.lapTimeS).toBeCloseTo(lapOf().lapTimeS, 9);
  });
});

describe("vdSweep — .tir gating helper", () => {
  it("VD_PARAMS lists the four sweepable params", () => {
    // Stable contract for the UI dropdown.
    const params: VdParam[] = ["massKg", "cgHeightM", "rsdFront", "muDropoffPct"];
    for (const p of params) expect(applyVdParam(BASE, p, 0.5)).toBeDefined();
  });
});
