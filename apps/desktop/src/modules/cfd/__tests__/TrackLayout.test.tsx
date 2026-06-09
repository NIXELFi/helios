import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import { TrackLayout } from "../components/charts/TrackLayout";
import { AUTOCROSS_2026_VISUAL, ENDURANCE_2026_VISUAL } from "../lib/performance";

describe("TrackLayout", () => {
  it("renders the ribbon polygon + colored centerline without NaN", () => {
    const { container } = render(<TrackLayout track={AUTOCROSS_2026_VISUAL} />);
    const poly = container.querySelector("polygon");
    expect(poly).not.toBeNull();
    expect(poly!.getAttribute("points")).not.toContain("NaN");
    expect(container.querySelectorAll("polyline").length).toBeGreaterThan(0);
    for (const pl of container.querySelectorAll("polyline")) {
      expect(pl.getAttribute("points")).not.toContain("NaN");
    }
  });

  it("labels point-to-point vs closed loop and the name", () => {
    const { getByText } = render(<TrackLayout track={AUTOCROSS_2026_VISUAL} />);
    expect(getByText(/Autocross 2026/)).toBeTruthy();
    expect(getByText(/point-to-point/)).toBeTruthy();
  });

  it("renders the endurance loop as closed (no finish marker distinct from start)", () => {
    const { getByText } = render(<TrackLayout track={ENDURANCE_2026_VISUAL} />);
    expect(getByText(/closed loop/)).toBeTruthy();
  });
});
