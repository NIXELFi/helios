// Time-weighted residency histogram (lap player section).

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MiniHistogram } from "../components/charts/MiniHistogram";

const series = {
  values: [1000, 1000, 9000, 9000, 9000],
  weights: [1, 1, 1, 1, 6],
  color: "#FFC627",
  label: "A",
};

describe("MiniHistogram", () => {
  it("renders bars sized by time weight, not sample count", () => {
    const { container } = render(
      <MiniHistogram title="rpm residency" unit="rpm" series={series} bins={4} />,
    );
    const rects = [...container.querySelectorAll("rect")];
    expect(rects.length).toBeGreaterThanOrEqual(2);
    // The 9000-rpm bin holds 8/10 of the time (weights 1+1+6) vs 2/10 for the
    // 1000-rpm bin — its bar must be the tallest.
    const heights = rects.map((r) => parseFloat(r.getAttribute("height") ?? "0"));
    const titles = rects.map((r) => r.querySelector("title")?.textContent ?? "");
    const tallest = heights.indexOf(Math.max(...heights));
    expect(titles[tallest]).toContain("80.0%");
  });

  it("renders an overlay polyline for the comparison series", () => {
    const { container } = render(
      <MiniHistogram
        title="rpm"
        unit="rpm"
        series={series}
        overlay={{ ...series, color: "#4FC3F7", label: "B" }}
        bins={4}
      />,
    );
    expect(container.querySelector("polyline")).not.toBeNull();
  });
});
