import { render, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { ScatterPlot } from "../components/charts/ScatterPlot";
import type { ScatterPt } from "../components/charts/ScatterPlot";

const base = { title: "Convergence", xLabel: "trial", yLabel: "objective" };

function noNaN(container: HTMLElement) {
  for (const c of container.querySelectorAll("circle")) {
    expect(c.getAttribute("cx")).not.toContain("NaN");
    expect(c.getAttribute("cy")).not.toContain("NaN");
  }
}

describe("ScatterPlot", () => {
  it("renders one circle per point", () => {
    const pts: ScatterPt[] = [
      { id: 0, x: 1, y: 5 },
      { id: 1, x: 2, y: 8 },
      { id: 2, x: 3, y: 6 },
    ];
    const { container } = render(<ScatterPlot {...base} points={pts} />);
    expect(container.querySelectorAll("circle")).toHaveLength(3);
  });

  it("colors rank 1/2/3 points gold/silver/bronze via fill", () => {
    const pts: ScatterPt[] = [
      { id: 0, x: 1, y: 5, rank: 1 },
      { id: 1, x: 2, y: 8, rank: 2 },
      { id: 2, x: 3, y: 6, rank: 3 },
      { id: 3, x: 4, y: 4 },
    ];
    const { container } = render(<ScatterPlot {...base} points={pts} />);
    const fills = Array.from(container.querySelectorAll("circle")).map((c) =>
      c.getAttribute("fill"),
    );
    expect(fills).toContain("#fbbf24"); // rank 1 gold
    expect(fills).toContain("#C0C7D1"); // rank 2 silver
    expect(fills).toContain("#CD7F32"); // rank 3 bronze
    expect(fills).toContain("#4FC3F7"); // neutral
  });

  it("renders the selected id with a white ring", () => {
    const pts: ScatterPt[] = [
      { id: 0, x: 1, y: 5, rank: 1 },
      { id: 1, x: 2, y: 8 },
    ];
    const { container } = render(<ScatterPlot {...base} points={pts} selectedId={0} />);
    const ringed = Array.from(container.querySelectorAll("circle")).filter(
      (c) => c.getAttribute("stroke") === "#fafafa",
    );
    expect(ringed).toHaveLength(1);
    expect(ringed[0]?.getAttribute("fill")).toBe("none");
  });

  it("draws the step polyline when stepLine is provided", () => {
    const pts: ScatterPt[] = [
      { id: 0, x: 1, y: 5 },
      { id: 1, x: 2, y: 8 },
    ];
    const step = [
      { x: 1, y: 5 },
      { x: 2, y: 8 },
    ];
    const { container } = render(<ScatterPlot {...base} points={pts} stepLine={step} />);
    const poly = container.querySelector("polyline");
    expect(poly).not.toBeNull();
    expect(poly?.getAttribute("stroke")).toBe("#FFC627");
    // Right-angle step: an intermediate corner is emitted -> more vertices
    // than the input (3 points for a 2-point line).
    const verts = poly!.getAttribute("points")!.trim().split(/\s+/);
    expect(verts.length).toBe(3);
  });

  it("fires onPointClick with the point id", () => {
    const onClick = vi.fn();
    const pts: ScatterPt[] = [{ id: 42, x: 1, y: 5 }];
    const { container } = render(
      <ScatterPlot {...base} points={pts} onPointClick={onClick} />,
    );
    const circle = container.querySelector("circle");
    expect(circle).not.toBeNull();
    fireEvent.click(circle!);
    expect(onClick).toHaveBeenCalledWith(42);
  });

  it("renders a single point without producing NaN coordinates", () => {
    const pts: ScatterPt[] = [{ id: 0, x: 5, y: 5 }];
    const { container } = render(<ScatterPlot {...base} points={pts} />);
    expect(container.querySelectorAll("circle")).toHaveLength(1);
    noNaN(container);
  });

  it("renders zero points without crashing", () => {
    const { container } = render(<ScatterPlot {...base} points={[]} />);
    expect(container.querySelectorAll("circle")).toHaveLength(0);
    noNaN(container);
  });

  it("handles a degenerate axis (all x equal) without NaN", () => {
    const pts: ScatterPt[] = [
      { id: 0, x: 3, y: 1 },
      { id: 1, x: 3, y: 9 },
    ];
    const { container } = render(<ScatterPlot {...base} points={pts} />);
    noNaN(container);
  });

  it("draws in-flight points as hollow dashed circles", () => {
    const pts: ScatterPt[] = [{ id: 0, x: 1, y: 5, inFlight: true }];
    const { container } = render(<ScatterPlot {...base} points={pts} />);
    const circle = container.querySelector("circle");
    expect(circle?.getAttribute("fill")).toBe("none");
    expect(circle?.getAttribute("stroke-dasharray")).toBe("2 2");
  });
});
