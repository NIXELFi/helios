import { describe, it, expect } from "vitest";

import { buildLapChannelsCsv } from "../../lib/export/lapChannelsCsv";
import { simLap, type VehicleConfig } from "../../lib/performance";
import { synthesizeAutocross } from "../../lib/performance";
import type { TorqueCurve } from "../../lib/performance";

const CURVE: TorqueCurve = [
  { rpm: 0, torqueNm: 60 },
  { rpm: 20000, torqueNm: 60 },
];

const VEHICLE: VehicleConfig = {
  name: "TestCar",
  massKg: 250,
  weightDistFront: 0.5,
  cgHeightM: 0.3,
  wheelbaseM: 1.5,
  trackWidthM: 1.2,
  tireRadiusM: 0.2,
  muLong: 1.5,
  muLat: 1.5,
  tireLoadSensitivity: 0,
  cdaM2: 1.0,
  claM2: 0,
  airDensityKgM3: 1.162,
  crr: 0.02,
  drivetrainEff: 0.9,
  gearRatios: [2.75, 2.0, 1.667],
  primaryReduction: 2.111,
  finalDrive: 3.0,
  shiftRpm: 9000,
  revLimitRpm: 14500,
  shiftTimeS: 0.1,
};

const META = {
  configName: "sdm26-test.json",
  vehicleName: "TestCar",
  event: "autocross",
  trackName: "AX",
  generatedAt: "2026-06-09T00:00:00Z",
};

describe("buildLapChannelsCsv", () => {
  const lap = simLap(CURVE, VEHICLE, synthesizeAutocross(), { channels: true });

  it("emits metadata comments, a header row, and one row per sample", () => {
    const csv = buildLapChannelsCsv(META, lap);
    const lines = csv.trimEnd().split("\n");
    const comments = lines.filter((l) => l.startsWith("#"));
    expect(comments.some((l) => l.includes("config: sdm26-test.json"))).toBe(true);
    expect(comments.some((l) => l.includes(`lap_time_s: ${lap.lapTimeS.toFixed(3)}`))).toBe(true);
    const headerIdx = lines.findIndex((l) => l.startsWith("dist_m,"));
    expect(headerIdx).toBeGreaterThan(0);
    expect(lines[headerIdx]).toBe("dist_m,time_s,speed_kph,rpm,gear,lat_g,long_g,throttle,brake,limit_state,fuel_cum_g");
    const rows = lines.slice(headerIdx + 1);
    expect(rows.length).toBe(lap.channels!.distM.length);
    // Every row is a clean 11-column rectangle.
    for (const r of rows) expect(r.split(",").length).toBe(11);
    // Duty telemetry travels in the comment block.
    expect(comments.some((l) => l.includes("brake_energy_kj:"))).toBe(true);
  });

  it("rows carry physical values (speed in km/h, fuel in grams, pedals 0..1)", () => {
    const csv = buildLapChannelsCsv(META, lap);
    const lines = csv.trimEnd().split("\n");
    const last = lines[lines.length - 1]!.split(",");
    expect(parseFloat(last[0]!)).toBeCloseTo(lap.channels!.distM[lap.channels!.distM.length - 1]!, 1);
    expect(parseFloat(last[10]!)).toBeCloseTo(lap.fuelKg * 1000, 1);
    expect(["power", "grip", "corner", "brake", "coast"]).toContain(last[9]);
    for (const col of [7, 8]) {
      const v = parseFloat(last[col]!);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("throws when the lap was run without channels", () => {
    const noCh = simLap(CURVE, VEHICLE, synthesizeAutocross());
    expect(() => buildLapChannelsCsv(META, noCh)).toThrow(/channels/);
  });

  it("escapes newlines in provenance names so they can't inject a comment/row", () => {
    // A config name carrying a CR/LF would otherwise break out of its "#"
    // comment line and forge an extra line in the output.
    const csv = buildLapChannelsCsv(
      { ...META, configName: "evil\nrpm,9999", vehicleName: "v\r\nx" },
      lap,
    );
    const lines = csv.trimEnd().split("\n");
    const commentLines = lines.filter((l) => l.startsWith("#"));
    // The config name collapses onto a single comment line — no extra line
    // that starts with the injected "rpm,9999".
    expect(commentLines.some((l) => l.includes("config: evil rpm,9999"))).toBe(true);
    expect(lines.some((l) => l.startsWith("rpm,9999"))).toBe(false);
    // Every non-comment, non-header line is still a clean 11-column row.
    const headerIdx = lines.findIndex((l) => l.startsWith("dist_m,"));
    for (const r of lines.slice(headerIdx + 1)) {
      expect(r.split(",").length).toBe(11);
    }
  });
});
