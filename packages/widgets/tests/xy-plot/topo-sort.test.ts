import { describe, it, expect } from "vitest";
import { topoSort, type TopoNode } from "../../src/xy-plot/topo-sort";

const node = (id: string, deps: string[] = []): TopoNode<string> => ({
  id, dependsOn: deps, value: id,
});

describe("topoSort", () => {
  it("preserves insertion order when there are no dependencies", () => {
    const r = topoSort([node("a"), node("b"), node("c")]);
    expect(r.hadCycle).toBe(false);
    expect(r.sorted).toEqual(["a", "b", "c"]);
  });

  it("places dependents after their targets", () => {
    // 'stats' depends on 'fit'; despite appearing first it must run after.
    const r = topoSort([node("stats", ["fit"]), node("fit")]);
    expect(r.hadCycle).toBe(false);
    expect(r.sorted).toEqual(["fit", "stats"]);
  });

  it("handles multiple dependents on a single target", () => {
    const r = topoSort([
      node("statsA", ["fit"]),
      node("statsB", ["fit"]),
      node("fit"),
    ]);
    expect(r.hadCycle).toBe(false);
    expect(r.sorted[0]).toBe("fit");
    expect(r.sorted.slice(1).sort()).toEqual(["statsA", "statsB"]);
  });

  it("ignores dangling dependency targets", () => {
    // 'stats' references a fit that isn't in the input — should not
    // crash, should not delay 'stats'.
    const r = topoSort([node("stats", ["missing-fit"]), node("scatter")]);
    expect(r.hadCycle).toBe(false);
    expect(r.sorted).toEqual(["stats", "scatter"]);
  });

  it("ignores self-edges", () => {
    const r = topoSort([node("a", ["a"]), node("b")]);
    expect(r.hadCycle).toBe(false);
    expect(r.sorted).toEqual(["a", "b"]);
  });

  it("falls back to insertion order on a cycle and flags hadCycle", () => {
    const r = topoSort([node("a", ["b"]), node("b", ["a"])]);
    expect(r.hadCycle).toBe(true);
    expect(r.sorted).toEqual(["a", "b"]);
  });

  it("breaks ties in insertion order among indegree-0 nodes", () => {
    const r = topoSort([
      node("scatter"),
      node("fit"),
      node("stats", ["fit"]),
      node("bins"),
    ]);
    expect(r.hadCycle).toBe(false);
    // scatter, fit, bins all start indegree-0; stats waits on fit.
    // Stable order means scatter < fit < bins, with stats after fit.
    const idx = (id: string) => r.sorted.indexOf(id);
    expect(idx("fit")).toBeLessThan(idx("stats"));
    expect(idx("scatter")).toBe(0);
  });
});
