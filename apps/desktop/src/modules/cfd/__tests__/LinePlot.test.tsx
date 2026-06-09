// LinePlot x-axis rebuild regression: the plot pins its x range at creation
// (uPlot auto-scale workaround), so swapping SAME-SHAPED series to data over a
// different x domain (Lap Sim toggling autocross ↔ endurance) must REBUILD the
// plot with the new range — setData alone leaves the old pinned axis. uPlot is
// mocked to capture constructor options (axes are canvas-drawn, not DOM).

import { render } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

interface FakePlot {
  opts: { scales?: { x?: { range?: [number, number] } } };
  setDataCalls: number;
}
const instances: FakePlot[] = [];

vi.mock("uplot", () => ({
  default: class {
    opts: unknown;
    setDataCalls = 0;
    constructor(opts: unknown) {
      this.opts = opts;
      instances.push(this as unknown as FakePlot);
    }
    setData() {
      (this as unknown as FakePlot).setDataCalls++;
    }
    setSize() {}
    destroy() {}
  },
}));

import { LinePlot } from "../components/charts/LinePlot";

function dist(n: number): number[] {
  return Array.from({ length: 50 }, (_, i) => (i / 49) * n);
}
const ys = Array.from({ length: 50 }, (_, i) => i);

beforeEach(() => {
  instances.length = 0;
});

describe("LinePlot x-axis range", () => {
  it("pins the x range to the data extent at creation", () => {
    render(<LinePlot title="t" xs={dist(795)} series={[{ label: "speed", y: ys }]} />);
    expect(instances.length).toBe(1);
    expect(instances[0]!.opts.scales!.x!.range).toEqual([0, 795]);
  });

  it("REBUILDS with the new range when same-shaped series swap x domain (AX ↔ EN)", () => {
    const { rerender } = render(
      <LinePlot title="t" xs={dist(795)} series={[{ label: "speed", y: ys }]} />,
    );
    // Same series label/shape, new (longer) track → must not stay on 795 m.
    rerender(<LinePlot title="t" xs={dist(1340)} series={[{ label: "speed", y: ys }]} />);
    const last = instances[instances.length - 1]!;
    expect(instances.length).toBe(2);
    expect(last.opts.scales!.x!.range).toEqual([0, 1340]);

    // ...and back to the short track updates again (the reported bug).
    rerender(<LinePlot title="t" xs={dist(795)} series={[{ label: "speed", y: ys }]} />);
    expect(instances[instances.length - 1]!.opts.scales!.x!.range).toEqual([0, 795]);
  });

  it("does NOT rebuild when data changes within the same extent (setData path)", () => {
    const xs = dist(795);
    const { rerender } = render(<LinePlot title="t" xs={xs} series={[{ label: "speed", y: ys }]} />);
    rerender(<LinePlot title="t" xs={xs} series={[{ label: "speed", y: ys.map((v) => v * 2) }]} />);
    expect(instances.length).toBe(1); // same plot...
    expect(instances[0]!.setDataCalls).toBeGreaterThan(0); // ...updated via setData
  });
});
