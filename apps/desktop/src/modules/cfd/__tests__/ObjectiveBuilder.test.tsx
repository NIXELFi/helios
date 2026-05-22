import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { ObjectiveBuilder } from "../components/optimization/ObjectiveBuilder";
import type { ObjectiveSpec } from "../state/types";

const baseValue: ObjectiveSpec = {
  metric: "imep_bar",
  aggregator: { kind: "max" },
  rpmList: [6000],
  direction: "maximize",
};

describe("ObjectiveBuilder", () => {
  it("switching aggregator to at-rpm seeds an integer RPM input", () => {
    const onChange = vi.fn();
    render(
      <ObjectiveBuilder
        value={baseValue}
        rpmListText="6000"
        onRpmListTextChange={vi.fn()}
        onChange={onChange}
      />,
    );
    const aggSelect = screen.getByDisplayValue("Max across RPM list");
    fireEvent.change(aggSelect, { target: { value: "at-rpm" } });
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls[0][0] as ObjectiveSpec;
    expect(next.aggregator.kind).toBe("at-rpm");
    if (next.aggregator.kind === "at-rpm") {
      expect(next.aggregator.rpmInt).toBe(6000);
    }
  });

  it("invalid RPM list text surfaces an error message", () => {
    render(
      <ObjectiveBuilder
        value={baseValue}
        rpmListText="not-rpms"
        onRpmListTextChange={vi.fn()}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("changing direction radio fires onChange", () => {
    const onChange = vi.fn();
    render(
      <ObjectiveBuilder
        value={baseValue}
        rpmListText="6000"
        onRpmListTextChange={vi.fn()}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByLabelText(/minimize/i));
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls[0][0] as ObjectiveSpec;
    expect(next.direction).toBe("minimize");
  });
});
