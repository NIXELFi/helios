import { describe, it, expect } from "vitest";

import type { VehicleConfig } from "../types";
import type { TorqueCurve } from "../torqueCurve";
import { simLap, makeGripModel } from "../lapSim";
import { tractionLimit, optimalShiftSpeeds, gearAtSpeed } from "../tractive";
import { gearVps } from "../vehicle";
import {
  synthesizeAutocross,
  synthesizeEndurance,
  trackLength,
  type Track,
} from "../track";

const G = 9.80665;

const flatCurve = (t: number): TorqueCurve => [
  { rpm: 0, torqueNm: t },
  { rpm: 20000, torqueNm: t },
];

function makeVehicle(over: Partial<VehicleConfig> = {}): VehicleConfig {
  return {
    name: "test",
    massKg: 250,
    weightDistFront: 0.5,
    cgHeightM: 0.3,
    wheelbaseM: 1.5,
    trackWidthM: 1.2,
    tireRadiusM: 0.2,
    muLong: 1.5,
    muLat: 1.5,
    tireLoadSensitivity: 0,
    cdaM2: 0,
    claM2: 0,
    airDensityKgM3: 1.162,
    crr: 0,
    drivetrainEff: 1,
    gearRatios: [2.0],
    primaryReduction: 1,
    finalDrive: 1,
    shiftRpm: 9000,
    revLimitRpm: 1e9,
    shiftTimeS: 0,
    ...over,
  };
}

describe("track synthesis", () => {
  it("autocross is ~800 m open; endurance is ~1000 m closed", () => {
    const ax = synthesizeAutocross();
    expect(ax.closed).toBe(false);
    expect(trackLength(ax)).toBeCloseTo(800, 0);

    const en = synthesizeEndurance();
    expect(en.closed).toBe(true);
    expect(trackLength(en)).toBeCloseTo(1000, 0);
  });
});

describe("simLap — shift losses", () => {
  // Gearing that forces real shifts: low ratios + a finite rev limit so the
  // car runs out of revs and must upshift while accelerating down a straight.
  const geared = (finalDrive: number, shiftTimeS = 0.1): VehicleConfig =>
    makeVehicle({
      gearRatios: [2.75, 2.0, 1.667, 1.444, 1.304, 1.208],
      primaryReduction: 2.111,
      finalDrive,
      revLimitRpm: 14500,
      shiftTimeS,
      muLat: 1.6,
    });
  const track = synthesizeAutocross();
  const torque = flatCurve(60);

  it("counts upshifts and adds shiftTimeS of dead time per shift", () => {
    const withCut = simLap(torque, geared(3.0, 0.1), track);
    const noCut = simLap(torque, geared(3.0, 0), track);
    expect(withCut.shiftCount).toBeGreaterThan(0);
    expect(noCut.shiftCount).toBe(withCut.shiftCount); // same gearing → same shifts
    // The ONLY difference is the per-shift time cut.
    expect(withCut.lapTimeS - noCut.lapTimeS).toBeCloseTo(withCut.shiftCount * 0.1, 6);
  });

  it("shorter gearing (higher final drive) shifts more and laps no faster", () => {
    const tall = simLap(torque, geared(3.0), track); // SDM26-like
    const short = simLap(torque, geared(3.5), track); // SDM25-like
    expect(short.shiftCount).toBeGreaterThan(tall.shiftCount);
    // More shift cuts → the shorter-geared car can't beat the taller one here.
    expect(short.lapTimeS).toBeGreaterThanOrEqual(tall.lapTimeS - 1e-9);
  });

  it("a single-gear car never shifts", () => {
    const oneGear = makeVehicle({ gearRatios: [2.0], revLimitRpm: 1e9, shiftTimeS: 0.1 });
    expect(simLap(torque, oneGear, track).shiftCount).toBe(0);
  });

  it("racing line (lineFactor>1) speeds the lap at the SAME tire μ", () => {
    const v = geared(3.0);
    const centerline = simLap(torque, v, track, { lineFactor: 1.0 });
    const racingLine = simLap(torque, v, track, { lineFactor: 1.3 });
    // Bigger effective corner radius → more corner speed → faster lap.
    expect(racingLine.lapTimeS).toBeLessThan(centerline.lapTimeS);
    // Cornering is still grip-limited, so peak lateral g barely moves (it's
    // μ·g_eff, independent of radius) — the speed gain comes from the line, not
    // from extra grip. This is what lets μ stay realistic.
    expect(Math.abs(racingLine.telemetry.maxLatG - centerline.telemetry.maxLatG)).toBeLessThan(0.25);
  });

  it("BSFC map: running far from the best-BSFC RPM burns more fuel", () => {
    const v = geared(3.0);
    const opts = { thermalEff: 0.3, fuelLhvMJkg: 43, fuelDensityKgL: 0.745 };
    // Sweet spot at a mid RPM the car actually uses vs. way out of reach (the
    // car then runs entirely below the sweet spot → BSFC penalty everywhere).
    const near = simLap(torque, v, track, { ...opts, bsfcSweetRpm: 8000 });
    const far = simLap(torque, v, track, { ...opts, bsfcSweetRpm: 30000 });
    expect(far.fuelKg).toBeGreaterThan(near.fuelKg); // worse BSFC → more fuel
    // Same lap work either way (BSFC only changes fuel, not the speed profile).
    expect(far.lapTimeS).toBeCloseTo(near.lapTimeS, 6);
  });

  it("reports sane telemetry (avg/max RPM, gear usage, g's, throttle)", () => {
    const tm = simLap(torque, geared(3.0), track).telemetry;
    expect(tm.avgRpm).toBeGreaterThan(0);
    expect(tm.maxRpm).toBeGreaterThan(tm.avgRpm);
    expect(tm.maxRpm).toBeLessThanOrEqual(14500 + 1e-6); // never past the rev limit
    expect(tm.shiftCount).toBeGreaterThan(0);
    // Gear-usage fractions are non-negative and sum to ~1 (the lap's moving time).
    const sum = tm.timeInGearFrac.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 2);
    expect(tm.timeInGearFrac.every((f) => f >= -1e-9)).toBe(true);
    expect(tm.maxLatG).toBeGreaterThan(0); // a track with corners loads laterally
    expect(tm.pctOnThrottle).toBeGreaterThan(0);
    expect(tm.pctOnThrottle).toBeLessThanOrEqual(1);
  });
});

describe("grip model (χ + rear-axle drive traction)", () => {
  const geared = makeVehicle({
    gearRatios: [2.75, 2.0, 1.667, 1.444, 1.304, 1.208],
    primaryReduction: 2.111,
    finalDrive: 3.0,
    revLimitRpm: 14500,
  });

  it("drive traction on a straight MATCHES the accel event's tractionLimit (unified physics)", () => {
    const grip = makeGripModel(geared); // sens = 0 → loadMult = 1
    for (const v of [0, 10, 20, 30]) {
      expect(geared.massKg * grip.aDriveGrip(v, Infinity)).toBeCloseTo(tractionLimit(geared, v), 6);
    }
  });

  it("χ = 1 with no load sensitivity; < 1 in a corner with it; = 1 on straights", () => {
    const noSens = makeGripModel(geared);
    expect(noSens.chi(15, 20)).toBe(1);
    const sens = makeGripModel(makeVehicle({ ...geared, tireLoadSensitivity: 0.15 }));
    expect(sens.chi(15, 20)).toBeLessThan(1); // cornering shifts load outboard
    expect(sens.chi(15, 20)).toBeGreaterThan(0.9); // …but it's a few-% effect
    expect(sens.chi(15, Infinity)).toBe(1); // no lateral load → no transfer
  });

  it("load transfer costs corner speed: same μ corners slower with sensitivity", () => {
    const base = makeGripModel(geared).vCorner(20);
    const withSens = makeGripModel(makeVehicle({ ...geared, tireLoadSensitivity: 0.15 })).vCorner(20);
    expect(withSens).toBeLessThan(base);
  });
});

describe("optimal shift schedule", () => {
  const geared = makeVehicle({
    gearRatios: [2.75, 2.0, 1.667, 1.444, 1.304, 1.208],
    primaryReduction: 2.111,
    finalDrive: 3.0,
    revLimitRpm: 14500,
  });

  it("flat torque → shift at redline (the shorter gear always wins below it)", () => {
    const shiftV = optimalShiftSpeeds(flatCurve(60), geared);
    for (let g = 0; g < shiftV.length; g++) {
      expect(shiftV[g]!).toBeCloseTo(gearVps(geared, g) * 14500, 0);
    }
  });

  it("torque that dies at high RPM → shift BEFORE redline (the crossover)", () => {
    // Strong mid-range, dead past 11k — riding to 14.5k would be wrong.
    const peaky: TorqueCurve = [
      { rpm: 4000, torqueNm: 60 },
      { rpm: 10000, torqueNm: 60 },
      { rpm: 12000, torqueNm: 20 },
      { rpm: 14500, torqueNm: 10 },
    ];
    const shiftV = optimalShiftSpeeds(peaky, geared);
    const redline1 = gearVps(geared, 0) * 14500;
    expect(shiftV[0]!).toBeLessThan(redline1 * 0.95);
  });

  it("gearAtSpeed is a monotone non-decreasing map over the schedule", () => {
    const shiftV = optimalShiftSpeeds(flatCurve(60), geared);
    let prev = 0;
    for (let v = 0; v < 70; v += 1) {
      const g = gearAtSpeed(shiftV, v);
      expect(g).toBeGreaterThanOrEqual(prev);
      prev = g;
    }
    expect(prev).toBe(geared.gearRatios.length - 1); // reaches top gear
  });
});

describe("simLap — channels", () => {
  const geared = makeVehicle({
    gearRatios: [2.75, 2.0, 1.667, 1.444, 1.304, 1.208],
    primaryReduction: 2.111,
    finalDrive: 3.0,
    revLimitRpm: 14500,
    shiftTimeS: 0.1,
    muLat: 1.6,
  });
  const track = synthesizeAutocross();
  const torque = flatCurve(60);

  it("are absent by default (the optimizer must not pay for them)", () => {
    expect(simLap(torque, geared, track).channels).toBeUndefined();
  });

  it("emits aligned, monotone, in-range traces", () => {
    const res = simLap(torque, geared, track, { channels: true });
    const ch = res.channels!;
    expect(ch).toBeDefined();
    const n = ch.distM.length;
    expect(n).toBeGreaterThan(100);
    // All channels aligned to the same sample count.
    for (const arr of [ch.tS, ch.vMps, ch.rpm, ch.gear, ch.latG, ch.longG, ch.limit, ch.fuelCumKg, ch.throttle, ch.brake]) {
      expect(arr.length).toBe(n);
    }
    // Distance + time + fuel are monotone non-decreasing.
    for (let i = 1; i < n; i++) {
      expect(ch.distM[i]!).toBeGreaterThan(ch.distM[i - 1]!);
      expect(ch.tS[i]!).toBeGreaterThan(ch.tS[i - 1]!);
      expect(ch.fuelCumKg[i]!).toBeGreaterThanOrEqual(ch.fuelCumKg[i - 1]!);
    }
    // Gear is 1-based and within the box; rpm within the rev limit.
    expect(Math.min(...ch.gear)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...ch.gear)).toBeLessThanOrEqual(6);
    expect(Math.max(...ch.rpm)).toBeLessThanOrEqual(14500 + 1e-6);
    // Cumulative fuel ends at the lap total; channel clock ends within a couple
    // of shift cuts of the lap time (shift counting on final vs accel profile).
    expect(ch.fuelCumKg[n - 1]!).toBeCloseTo(res.fuelKg, 9);
    expect(Math.abs(ch.tS[n - 1]! - res.lapTimeS)).toBeLessThan(0.3);
  });

  it("classifies limit states that cover the lap (power somewhere, corner somewhere, braking somewhere)", () => {
    // A modest engine: with honest rear-axle drive traction, a flat-60 Nm
    // monster would be traction-limited everywhere (correctly!), so "power"
    // segments need an engine that can actually run out of force.
    const ch = simLap(flatCurve(25), geared, track, { channels: true }).channels!;
    const states = new Set(ch.limit);
    expect(states.has("power")).toBe(true);
    expect(states.has("corner")).toBe(true);
    expect(states.has("brake")).toBe(true);
    // And the torque monster IS grip-limited out of corners — the rear axle
    // can only put down so much, no matter the curve.
    const strong = simLap(torque, geared, track, { channels: true }).channels!;
    expect(new Set(strong.limit).has("grip")).toBe(true);
  });

  it("telemetry pct power/corner-limited are sane fractions and respond to torque", () => {
    const weak = simLap(flatCurve(25), geared, track).telemetry;
    const strong = simLap(flatCurve(120), geared, track).telemetry;
    for (const tm of [weak, strong]) {
      expect(tm.pctPowerLimited).toBeGreaterThanOrEqual(0);
      expect(tm.pctPowerLimited).toBeLessThanOrEqual(1);
      expect(tm.pctCornerLimited).toBeGreaterThanOrEqual(0);
      expect(tm.pctCornerLimited).toBeLessThanOrEqual(1);
    }
    // A weaker engine spends MORE of the lap power-limited than a monster one.
    expect(weak.pctPowerLimited).toBeGreaterThan(strong.pctPowerLimited);
  });

  it("paced laps never label an accelerating straight as 'corner' (pace scales corner ceilings only)", () => {
    // Regression: the classifier used pace×vCorner unconditionally, but the
    // solver paces only grip-limited corner ceilings (straights run flat-out).
    // Under endurance pace, every straight above pace×vCap got labeled
    // "corner" while the car was at full throttle — hiding power-limited time.
    const ch = simLap(flatCurve(25), geared, track, { pace: 0.6, channels: true }).channels!;
    for (let i = 0; i < ch.limit.length; i++) {
      const straight = ch.latG[i]! < 0.05;
      const accelerating = ch.longG[i]! > 0.05;
      if (straight && accelerating) expect(ch.limit[i]).not.toBe("corner");
    }
    // And the paced lap still finds power-limited time somewhere.
    expect(ch.limit).toContain("power");
  });

  it("pedal channels are 0..1, mutually exclusive, and consistent with the motion", () => {
    const ch = simLap(torque, geared, track, { channels: true }).channels!;
    for (let i = 0; i < ch.throttle.length; i++) {
      expect(ch.throttle[i]).toBeGreaterThanOrEqual(0);
      expect(ch.throttle[i]).toBeLessThanOrEqual(1);
      expect(ch.brake[i]).toBeGreaterThanOrEqual(0);
      expect(ch.brake[i]).toBeLessThanOrEqual(1);
      // Never both pedals in the same segment (QSS: one net force).
      expect(Math.min(ch.throttle[i]!, ch.brake[i]!)).toBe(0);
      // Hard deceleration must show brake demand.
      if (ch.longG[i]! < -0.3) expect(ch.brake[i]).toBeGreaterThan(0);
    }
    // Power-limited segments are (near-)wide-open — demand is evaluated at the
    // mid-cell speed while the solver limits at cell entry, so allow the
    // discretization gap.
    const weak = simLap(flatCurve(25), geared, track, { channels: true }).channels!;
    const wot = weak.limit
      .map((l, i) => (l === "power" ? weak.throttle[i]! : null))
      .filter((x): x is number => x != null);
    expect(wot.length).toBeGreaterThan(0);
    expect(wot.reduce((a, b) => a + b, 0) / wot.length).toBeGreaterThan(0.85);
    expect(Math.min(...wot)).toBeGreaterThan(0.5);
  });

  it("duty metrics: braking dissipates energy on a lap with corners, none on a straight", () => {
    const withCorners = simLap(torque, geared, track).telemetry;
    expect(withCorners.brakeEnergyKJ).toBeGreaterThan(0);
    expect(withCorners.peakBrakePowerKw).toBeGreaterThan(0);
    expect(withCorners.tireDutyGkm).toBeGreaterThan(0);
    const straight: Track = { name: "drag", segments: [{ length: 500, radius: Infinity }], closed: false };
    const drag = simLap(torque, geared, straight).telemetry;
    expect(drag.brakeEnergyKJ).toBe(0);
    expect(drag.peakBrakePowerKw).toBe(0);
    expect(drag.tireDutyGkm).toBe(0);
  });

  it("channels do not change the solved lap (pure observation)", () => {
    const a = simLap(torque, geared, track);
    const b = simLap(torque, geared, track, { channels: true });
    expect(b.lapTimeS).toBeCloseTo(a.lapTimeS, 12);
    expect(b.fuelKg).toBeCloseTo(a.fuelKg, 12);
    expect(b.shiftCount).toBe(a.shiftCount);
  });
});

describe("simLap", () => {
  it("a constant-radius circle laps at the cornering-speed limit", () => {
    const R = 20;
    const track: Track = {
      name: "circle",
      segments: [{ length: 2 * Math.PI * R, radius: R }],
      closed: true,
    };
    const v = makeVehicle({ muLat: 1.5, claM2: 0, cdaM2: 0, crr: 0 });
    const res = simLap(flatCurve(120), v, track, { ds: 1 });
    const vCorner = Math.sqrt(1.5 * G * R); // no aero → exact
    const expected = (2 * Math.PI * R) / vCorner;
    expect(res.lapTimeS).toBeGreaterThan(expected * 0.97);
    expect(res.lapTimeS).toBeLessThan(expected * 1.05);
    expect(res.vMaxMps).toBeCloseTo(vCorner, 0);
  });

  it("a tighter circle is slower (lower avg speed) than an open one", () => {
    const v = makeVehicle({ claM2: 0 });
    const tight: Track = { name: "t", segments: [{ length: 2 * Math.PI * 8, radius: 8 }], closed: true };
    const open: Track = { name: "o", segments: [{ length: 2 * Math.PI * 30, radius: 30 }], closed: true };
    expect(simLap(flatCurve(120), v, tight, { ds: 1 }).avgSpeedMps).toBeLessThan(
      simLap(flatCurve(120), v, open, { ds: 1 }).avgSpeedMps,
    );
  });

  it("a straight gives a finite accel-limited time and burns fuel", () => {
    const track: Track = { name: "straight", segments: [{ length: 200, radius: Infinity }], closed: false };
    const res = simLap(flatCurve(80), makeVehicle(), track);
    expect(res.lapTimeS).toBeGreaterThan(0);
    expect(Number.isFinite(res.lapTimeS)).toBe(true);
    expect(res.fuelKg).toBeGreaterThan(0);
    expect(res.co2Kg).toBeGreaterThan(0);
  });

  it("E85 CO₂ factor yields less CO₂ than gasoline for the same work", () => {
    const track: Track = { name: "straight", segments: [{ length: 200, radius: Infinity }], closed: false };
    const v = makeVehicle();
    const gas = simLap(flatCurve(80), v, track, { co2PerL: 2.31 });
    const e85 = simLap(flatCurve(80), v, track, { co2PerL: 1.65 });
    expect(e85.co2Kg).toBeLessThan(gas.co2Kg);
  });

  it("runs on the synthesized autocross + endurance tracks", () => {
    const v = makeVehicle({
      gearRatios: [2.75, 2.0, 1.667, 1.444, 1.304, 1.208],
      primaryReduction: 2.111,
      finalDrive: 3.0,
      tireRadiusM: 0.2,
      revLimitRpm: 14500,
      cdaM2: 1.24,
      claM2: 3.09,
      crr: 0.02,
    });
    const ax = simLap(flatCurve(50), v, synthesizeAutocross());
    const en = simLap(flatCurve(50), v, synthesizeEndurance());
    expect(ax.lapTimeS).toBeGreaterThan(0);
    expect(Number.isFinite(ax.lapTimeS)).toBe(true);
    expect(en.lapTimeS).toBeGreaterThan(0);
    expect(Number.isFinite(en.lapTimeS)).toBe(true);
  });
});
