// LinePlot x-axis rebuild regression: the plot pins its x range at creation
// (uPlot auto-scale workaround), so swapping SAME-SHAPED series to data over a
// different x domain (Lap Sim toggling autocross ↔ endurance) must REBUILD the
// plot with the new range — setData alone leaves the old pinned axis. uPlot is
// mocked to capture constructor options (axes are canvas-drawn, not DOM).

import { render } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

interface FakePlot {
  opts: {
    scales?: { x?: { range?: [number, number] } };
    series?: { spanGaps?: boolean }[];
  };
  data: (number | null)[][];
  setDataCalls: number;
}
const instances: FakePlot[] = [];

vi.mock("uplot", () => ({
  default: class {
    opts: unknown;
    data: unknown;
    setDataCalls = 0;
    constructor(opts: unknown, data: unknown) {
      this.opts = opts;
      this.data = data;
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

  it("draws own-x series with disjoint grids (Compare overlay): null gaps + spanGaps", () => {
    // A sweep on a 500-rpm grid vs an optimization best on an offset grid: the
    // x union interleaves, so every other sample is a gap for each series. With
    // NaN gaps and spanGaps unset, uPlot draws NO line segments at all (the
    // reported blank Compare chart). Gaps must be null and the series must span.
    render(
      <LinePlot
        title="t"
        series={[
          { label: "sweep", xs: [4000, 5000, 6000], y: [50, 60, 55], showPoints: false },
          { label: "opt", xs: [4500, 5500, 6500], y: [52, 62, 57], showPoints: false },
        ]}
      />,
    );
    const p = instances[instances.length - 1]!;
    const [xu, y1, y2] = p.data;
    expect(xu).toEqual([4000, 4500, 5000, 5500, 6000, 6500]);
    expect(y1).toEqual([50, null, 60, null, 55, null]);
    expect(y2).toEqual([null, 52, null, 62, null, 57]);
    // series[0] is uPlot's x slot; data series follow.
    expect(p.opts.series![1]!.spanGaps).toBe(true);
    expect(p.opts.series![2]!.spanGaps).toBe(true);
  });

  it("does NOT rebuild when data changes within the same extent (setData path)", () => {
    const xs = dist(795);
    const { rerender } = render(<LinePlot title="t" xs={xs} series={[{ label: "speed", y: ys }]} />);
    rerender(<LinePlot title="t" xs={xs} series={[{ label: "speed", y: ys.map((v) => v * 2) }]} />);
    expect(instances.length).toBe(1); // same plot...
    expect(instances[0]!.setDataCalls).toBeGreaterThan(0); // ...updated via setData
  });
});
