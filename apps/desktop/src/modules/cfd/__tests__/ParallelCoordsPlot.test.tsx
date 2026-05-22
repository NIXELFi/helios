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
});
