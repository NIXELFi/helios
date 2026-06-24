import { describe, it, expect } from "vitest";

import { sortStudies } from "../sortStudies";
import { makeStudy, makeSweepStudy, makeOptimizationStudy } from "../../__tests__/fakes/study";
import type { Study } from "../../state/types";

// Three studies with DISTINCT id / name / startedAt so each ordering is
// unambiguous. Names "alpha 2" vs "alpha 10" exercise locale numeric sort
// (a naive code-point compare would put "alpha 10" before "alpha 2").
const single = makeStudy({
  id: "a",
  name: "alpha 2",
  status: "running",
  startedAt: 3_000,
}); // kind single-rpm
const sweep = makeSweepStudy({
  id: "b",
  name: "alpha 10",
  status: "done",
  startedAt: 1_000,
}); // kind sweep
const opt = makeOptimizationStudy({
  id: "c",
  name: "beta",
  status: "error",
  startedAt: 2_000,
}); // kind optimization

const all: Study[] = [single, sweep, opt];

function ids(list: Study[]): string[] {
  return list.map((s) => s.id);
}

describe("sortStudies", () => {
  it("does not mutate the input list", () => {
    const input = [...all];
    sortStudies(input, { key: "name", dir: "asc" });
    expect(ids(input)).toEqual(["a", "b", "c"]);
  });

  it("sorts by name A-Z with locale numeric ordering (alpha 2 < alpha 10 < beta)", () => {
    const out = sortStudies(all, { key: "name", dir: "asc" });
    // alpha 2 (a) < alpha 10 (b) < beta (c) — numeric:true keeps 2 before 10.
    expect(ids(out)).toEqual(["a", "b", "c"]);
  });

  it("sorts by name Z-A", () => {
    const out = sortStudies(all, { key: "name", dir: "desc" });
    expect(ids(out)).toEqual(["c", "b", "a"]);
  });

  it("sorts by startedAt newest-first (desc)", () => {
    const out = sortStudies(all, { key: "startedAt", dir: "desc" });
    // a=3000, c=2000, b=1000
    expect(ids(out)).toEqual(["a", "c", "b"]);
  });

  it("sorts by startedAt oldest-first (asc)", () => {
    const out = sortStudies(all, { key: "startedAt", dir: "asc" });
    expect(ids(out)).toEqual(["b", "c", "a"]);
  });

  it("sorts by kind ascending (single-rpm < sweep < optimization)", () => {
    const out = sortStudies(all, { key: "kind", dir: "asc" });
    expect(out.map((s) => s.kind)).toEqual(["single-rpm", "sweep", "optimization"]);
  });

  it("sorts by status ascending using lifecycle rank (running < done < error)", () => {
    const out = sortStudies(all, { key: "status", dir: "asc" });
    expect(out.map((s) => s.status)).toEqual(["running", "done", "error"]);
  });

  it("breaks ties deterministically by startedAt desc then id", () => {
    // Same kind + same startedAt → tie-break must be stable: startedAt desc,
    // then id.localeCompare. Distinct ids, equal startedAt.
    const t1 = makeStudy({ id: "z", kind: "single-rpm", startedAt: 5_000 });
    const t2 = makeStudy({ id: "y", kind: "single-rpm", startedAt: 5_000 });
    const t3 = makeStudy({ id: "x", kind: "single-rpm", startedAt: 5_000 });
    // All identical kind/startedAt → only id.localeCompare decides: x < y < z.
    const out = sortStudies([t1, t2, t3], { key: "kind", dir: "asc" });
    expect(ids(out)).toEqual(["x", "y", "z"]);
  });
});
