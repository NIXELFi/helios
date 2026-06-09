// Dyno CSV parser + sim-vs-dyno comparison stats + the sweep dynoRef reducer.

import { describe, it, expect } from "vitest";

import { parseDynoCsv, dynoPowerKw, dynoTorqueNm } from "../../lib/import/importDyno";
import { compareDyno } from "../../lib/analytics/dynoCompare";
import { reducer, initialState, type State } from "../../state/CfdContext";
import { makeSweepStudy } from "../fakes/study";

// Exact header shape of physics_findings/references/dyno/sdm26-team-dyno.csv.
const TEAM_CSV = `rpm,brake_power_kW,brake_torque_Nm,bsfc_g_per_kWh,egt_K,source,notes
4500,14.578,30.926,,,Team chassis dyno run SDM(1) (Dynojet),
5000,17.159,32.770,,,Team chassis dyno run SDM(1) (Dynojet),
junk,row,should,be,skipped,,
6000,29.850,47.508,,,Team chassis dyno run SDM(1) (Dynojet),`;

describe("parseDynoCsv", () => {
  it("parses the team Dynojet reference format (kW + Nm), skipping junk rows", () => {
    const ref = parseDynoCsv(TEAM_CSV, "sdm26-team-dyno.csv");
    expect(ref.points).toHaveLength(3);
    expect(ref.points[0]).toEqual({ rpm: 4500, powerKw: 14.578, torqueNm: 30.926 });
    expect(ref.label).toBe("sdm26-team-dyno.csv");
  });

  it("converts hp and lb-ft from a raw Dynojet sheet", () => {
    const ref = parseDynoCsv("RPM,Power (hp),Torque (lb-ft)\n8000,60,40\n", "run.csv");
    expect(ref.points[0]!.powerKw).toBeCloseTo(44.74, 1);
    expect(ref.points[0]!.torqueNm).toBeCloseTo(54.23, 1);
  });

  it("derives power from torque (and vice versa) when one is missing", () => {
    const p = { rpm: 9549.3, powerKw: null, torqueNm: 50 };
    expect(dynoPowerKw(p)).toBeCloseTo(50, 1); // P[kW] = T·rpm/9549.3
    const q = { rpm: 9549.3, powerKw: 50, torqueNm: null };
    expect(dynoTorqueNm(q)).toBeCloseTo(50, 1);
  });

  it("rejects files without rpm or without power/torque", () => {
    expect(() => parseDynoCsv("speed,boost\n1,2\n", "x")).toThrow(/rpm/i);
    expect(() => parseDynoCsv("rpm,egt\n8000,900\n", "x")).toThrow(/power.*torque/i);
  });
});

describe("compareDyno", () => {
  const sim = [
    { rpm: 6000, powerKw: 30 },
    { rpm: 8000, powerKw: 50 },
    { rpm: 10000, powerKw: 60 },
  ];

  it("interpolates sim power at dyno rpms; RMSE/bias by hand", () => {
    // sim @7000 = 40 (dyno 38 → e=+2), sim @9000 = 55 (dyno 56 → e=−1)
    const cmp = compareDyno(sim, [
      { rpm: 7000, powerKw: 38, torqueNm: null },
      { rpm: 9000, powerKw: 56, torqueNm: null },
      { rpm: 12000, powerKw: 70, torqueNm: null }, // outside sim band → skipped
    ])!;
    expect(cmp.n).toBe(2);
    expect(cmp.biasKw).toBeCloseTo(0.5, 6);
    expect(cmp.rmseKw).toBeCloseTo(Math.sqrt((4 + 1) / 2), 6);
    expect(cmp.rpmMin).toBe(7000);
    expect(cmp.rpmMax).toBe(9000);
  });

  it("returns null with no overlap", () => {
    expect(compareDyno(sim, [{ rpm: 15000, powerKw: 20, torqueNm: null }])).toBeNull();
  });
});

describe("setSweepDynoRef reducer", () => {
  it("attaches and clears the dyno ref on a sweep", () => {
    const study = makeSweepStudy({ id: "s1" });
    const ref = { label: "d.csv", points: [{ rpm: 8000, powerKw: 50, torqueNm: null }] };
    let s: State = { ...initialState, studies: { s1: study } };
    s = reducer(s, { type: "setSweepDynoRef", id: "s1", dynoRef: ref });
    expect((s.studies["s1"] as typeof study).dynoRef).toEqual(ref);
    s = reducer(s, { type: "setSweepDynoRef", id: "s1", dynoRef: undefined });
    expect("dynoRef" in s.studies["s1"]!).toBe(false);
  });
});
