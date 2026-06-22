import { describe, it, expect } from "vitest";

import { parseStudyImport } from "../../lib/import/importStudy";
import { buildStudyJson, buildWorkspaceJson } from "../../lib/export/buildJson";
import {
  makeOptimizationStudy,
  makeSweepStudy,
  makeStudy,
} from "../fakes/study";
import type { OptimizationStudy } from "../../state/types";

const idFor = (i: number) => `imp-${i}`;

describe("parseStudyImport", () => {
  it("round-trips an exported optimization study (export → import)", () => {
    const original = makeOptimizationStudy();
    const json = buildStudyJson(original);
    const { studies, warnings } = parseStudyImport(json, idFor);

    expect(warnings).toEqual([]);
    expect(studies).toHaveLength(1);
    const s = studies[0] as OptimizationStudy;
    expect(s.id).toBe("imp-0"); // fresh id, NOT the original
    expect(s.kind).toBe("optimization");
    expect(s.configPath).toBe(original.configPath);
    expect(s.trials).toHaveLength(original.trials.length);
    expect(s.parameterPaths).toEqual(original.parameterPaths);
    expect(s.objectiveDirection).toBe(original.objectiveDirection);
    expect(s.bestTrialIdx).toBe(original.bestTrialIdx);
    // Trial objective values + params survive so it re-ranks identically.
    expect(s.trials.map((t) => t.objectiveValue)).toEqual(
      original.trials.map((t) => t.objectiveValue),
    );
  });

  it("round-trips a sweep study", () => {
    const json = buildStudyJson(makeSweepStudy());
    const { studies, warnings } = parseStudyImport(json, idFor);
    expect(warnings).toEqual([]);
    expect(studies).toHaveLength(1);
    expect(studies[0]!.kind).toBe("sweep");
  });

  it("imports a workspace dump of multiple studies with unique ids", () => {
    const json = buildWorkspaceJson([makeOptimizationStudy(), makeSweepStudy(), makeStudy({ status: "done" })]);
    const { studies, warnings } = parseStudyImport(json, idFor);
    expect(warnings).toEqual([]);
    expect(studies.map((s) => s.kind)).toEqual(["optimization", "sweep", "single-rpm"]);
    expect(new Set(studies.map((s) => s.id)).size).toBe(3); // all unique
  });

  it("reports a warning (no throw) on invalid JSON", () => {
    const r = parseStudyImport("{not json", idFor);
    expect(r.studies).toEqual([]);
    expect(r.warnings[0]).toMatch(/Not valid JSON/);
  });

  it("rejects an unrecognized shape", () => {
    const r = parseStudyImport(JSON.stringify({ hello: "world" }), idFor);
    expect(r.studies).toEqual([]);
    expect(r.warnings[0]).toMatch(/Unrecognized file/);
  });

  it("skips a bad bundle in a workspace but keeps the good ones", () => {
    const good = JSON.parse(buildStudyJson(makeSweepStudy()));
    const bad = { meta: { kind: "optimization" }, params: {}, results: {} }; // no tunables
    const json = JSON.stringify({ schemaVersion: 1, studies: [good, bad] });
    const r = parseStudyImport(json, idFor);
    expect(r.studies).toHaveLength(1);
    expect(r.studies[0]!.kind).toBe("sweep");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/Skipped study 2/);
  });

  it("drops sweep points missing lastCycle so downstream readers can't crash", () => {
    const good = JSON.parse(buildStudyJson(makeSweepStudy()));
    // Inject a malformed point with no lastCycle alongside the real points.
    good.results.points = [
      ...good.results.points,
      { rpm: 99999, cycles: [] }, // no lastCycle → must be dropped
    ];
    const r = parseStudyImport(JSON.stringify(good), idFor);
    expect(r.studies).toHaveLength(1);
    const sweep = r.studies[0] as import("../../state/types").SweepStudy;
    // The bad point is gone; every surviving point has a usable lastCycle.
    expect(sweep.points.every((p) => p.lastCycle != null)).toBe(true);
    expect(sweep.points.some((p) => p.rpm === 99999)).toBe(false);
  });

  it("derives objective direction from params when derived is absent", () => {
    const bundle = {
      meta: { kind: "optimization", configPath: "/x/sdm26.json", status: "done", startedAt: 1 },
      params: { tunables: [{ path: "runner_length", min: 0, max: 1, step: null }], objective: { direction: "minimize" } },
      results: { trials: [] },
    };
    const { studies } = parseStudyImport(JSON.stringify(bundle), idFor);
    expect((studies[0] as OptimizationStudy).objectiveDirection).toBe("minimize");
    expect((studies[0] as OptimizationStudy).parameterPaths).toEqual(["runner_length"]);
  });
});
