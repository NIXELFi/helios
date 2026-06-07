import { render, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { ParallelCoordsPlot } from "../components/charts/ParallelCoordsPlot";

describe("ParallelCoordsPlot", () => {
  it("renders one polyline per trial", () => {
    const { container } = render(
      <ParallelCoordsPlot
        axes={[
          { label: "x", min: 0, max: 1 },
          { label: "y", min: 0, max: 10 },
        ]}
        trials={[
          { trialIdx: 0, values: [0.2], objective: 5 },
          { trialIdx: 1, values: [0.7], objective: 8 },
        ]}
      />,
    );
    expect(container.querySelectorAll("polyline")).toHaveLength(2);
  });

  it("clicking polyline fires onTrialClick with trialIdx", () => {
    const onClick = vi.fn();
    const { container } = render(
      <ParallelCoordsPlot
        axes={[
          { label: "x", min: 0, max: 1 },
          { label: "y", min: 0, max: 10 },
        ]}
        trials={[{ trialIdx: 7, values: [0.5], objective: 6 }]}
        onTrialClick={onClick}
      />,
    );
    const line = container.querySelector("polyline");
    expect(line).not.toBeNull();
    fireEvent.click(line!);
    expect(onClick).toHaveBeenCalledWith(7);
  });

  it("handles empty trials without crashing", () => {
    const { container } = render(
      <ParallelCoordsPlot
        axes={[{ label: "x", min: 0, max: 1 }]}
        trials={[]}
      />,
    );
    expect(container.querySelectorAll("polyline")).toHaveLength(0);
  });

  it("renders the selected trial on top in white", () => {
    const { container } = render(
      <ParallelCoordsPlot
        axes={[
          { label: "x", min: 0, max: 1 },
          { label: "y", min: 0, max: 10 },
        ]}
        trials={[
          { trialIdx: 0, values: [0.2], objective: 5 },
          { trialIdx: 1, values: [0.7], objective: 8 },
        ]}
        selectedTrialIdx={1}
      />,
    );
    const polylines = container.querySelectorAll("polyline");
    // The last polyline is the selected one.
    const last = polylines[polylines.length - 1];
    expect(last?.getAttribute("stroke")).toBe("#fafafa");
  });

  it("colors rank 1/2/3 polylines gold/silver/bronze with width 2", () => {
    const { container } = render(
      <ParallelCoordsPlot
        axes={[
          { label: "x", min: 0, max: 1 },
          { label: "y", min: 0, max: 10 },
        ]}
        trials={[
          { trialIdx: 0, values: [0.1], objective: 5, rank: 1 },
          { trialIdx: 1, values: [0.4], objective: 6, rank: 2 },
          { trialIdx: 2, values: [0.7], objective: 7, rank: 3 },
          { trialIdx: 3, values: [0.9], objective: 8 }, // unranked → neutral
        ]}
      />,
    );
    const strokes = Array.from(container.querySelectorAll("polyline")).map((p) => ({
      stroke: p.getAttribute("stroke"),
      width: p.getAttribute("stroke-width"),
    }));
    const gold = strokes.find((s) => s.stroke === "#fbbf24");
    const silver = strokes.find((s) => s.stroke === "#C0C7D1");
    const bronze = strokes.find((s) => s.stroke === "#CD7F32");
    expect(gold?.width).toBe("2");
    expect(silver?.width).toBe("2");
    expect(bronze?.width).toBe("2");
    // The unranked neutral trial is neither a podium color nor white.
    expect(strokes.some((s) => s.stroke !== "#fbbf24" && s.stroke !== "#C0C7D1" && s.stroke !== "#CD7F32" && s.stroke !== "#fafafa")).toBe(true);
  });

  it("draws the gold rank-1 polyline last among the podium (on top)", () => {
    const { container } = render(
      <ParallelCoordsPlot
        axes={[
          { label: "x", min: 0, max: 1 },
          { label: "y", min: 0, max: 10 },
        ]}
        trials={[
          { trialIdx: 0, values: [0.1], objective: 5, rank: 1 },
          { trialIdx: 1, values: [0.4], objective: 6, rank: 2 },
          { trialIdx: 2, values: [0.7], objective: 7, rank: 3 },
        ]}
      />,
    );
    const lines = container.querySelectorAll("polyline");
    expect(lines[lines.length - 1]?.getAttribute("stroke")).toBe("#fbbf24");
  });

  it("back-compat: bestTrial still renders the gold rank-1 stroke (width 2)", () => {
    const { container } = render(
      <ParallelCoordsPlot
        axes={[
          { label: "x", min: 0, max: 1 },
          { label: "y", min: 0, max: 10 },
        ]}
        trials={[
          { trialIdx: 0, values: [0.2], objective: 5 },
          { trialIdx: 1, values: [0.7], objective: 8, bestTrial: true },
        ]}
      />,
    );
    const best = Array.from(container.querySelectorAll("polyline")).find(
      (p) => p.getAttribute("stroke") === "#fbbf24",
    );
    expect(best).toBeTruthy();
    expect(best?.getAttribute("stroke-width")).toBe("2");
  });

  it("selected wins over rank: rank-1 selected renders white on top", () => {
    const { container } = render(
      <ParallelCoordsPlot
        axes={[
          { label: "x", min: 0, max: 1 },
          { label: "y", min: 0, max: 10 },
        ]}
        trials={[{ trialIdx: 9, values: [0.5], objective: 6, rank: 1 }]}
        selectedTrialIdx={9}
      />,
    );
    const lines = container.querySelectorAll("polyline");
    // Only one polyline (the selected one); it's white, not gold.
    expect(lines).toHaveLength(1);
    expect(lines[0]?.getAttribute("stroke")).toBe("#fafafa");
  });
});
