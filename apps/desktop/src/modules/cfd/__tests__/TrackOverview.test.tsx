import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import { TrackOverview } from "../components/charts/TrackOverview";
import { AUTOCROSS_2026 } from "../lib/performance";

describe("TrackOverview", () => {
  it("renders the plan polylines + curvature strip without NaN coords", () => {
    const { container, getByText } = render(<TrackOverview track={AUTOCROSS_2026} />);
    // At least one colored run for the plan view + bars for the strip.
    expect(container.querySelectorAll("polyline").length).toBeGreaterThan(0);
    expect(container.querySelectorAll("rect").length).toBeGreaterThan(0);
    for (const pl of container.querySelectorAll("polyline")) {
      expect(pl.getAttribute("points")).not.toContain("NaN");
    }
    // Header names the track + length + type.
    expect(getByText(/Autocross 2026/)).toBeTruthy();
    expect(getByText(/point-to-point/)).toBeTruthy();
  });

  it("labels the schematic caveat (turn directions approximated)", () => {
    const { getByText } = render(<TrackOverview track={AUTOCROSS_2026} />);
    expect(getByText(/schematic/)).toBeTruthy();
    expect(getByText(/start/)).toBeTruthy();
  });
});
