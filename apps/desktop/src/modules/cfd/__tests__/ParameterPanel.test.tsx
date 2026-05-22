import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { ParameterPanel } from "../components/optimization/ParameterPanel";
import type { ParameterBoundsUI, ParameterMeta } from "../state/types";

const schema: ParameterMeta[] = [
  {
    path: "restrictor_cd",
    kind: "scalar",
    arrayLen: 1,
    unit: "-",
    default: 0.9,
    suggestedMin: 0.7,
    suggestedMax: 1.0,
    group: "Restrictor",
  },
  {
    path: "runner_length",
    kind: "array",
    arrayLen: 4,
    unit: "m",
    default: 0.25,
    suggestedMin: 0.1,
    suggestedMax: 0.5,
    group: "Intake",
  },
];

describe("ParameterPanel", () => {
  it("renders one row per schema entry grouped by category", () => {
    render(<ParameterPanel schema={schema} bounds={[]} onChange={vi.fn()} />);
    expect(screen.getByText("Restrictor")).toBeInTheDocument();
    expect(screen.getByText("Intake")).toBeInTheDocument();
    expect(screen.getByText("restrictor_cd")).toBeInTheDocument();
    expect(screen.getByText("runner_length")).toBeInTheDocument();
  });

  it("toggling enable fires onChange with enabled=true and suggested bounds", () => {
    const onChange = vi.fn();
    render(<ParameterPanel schema={schema} bounds={[]} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Enable restrictor_cd as tunable"));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]?.[0] as ParameterBoundsUI[];
    const row = next.find((b) => b.path === "restrictor_cd");
    expect(row).toBeDefined();
    expect(row?.enabled).toBe(true);
    expect(row?.min).toBe(0.7);
    expect(row?.max).toBe(1.0);
  });

  it("array-kind row exposes a per-element scope dropdown", () => {
    const enabled: ParameterBoundsUI[] = [
      { path: "runner_length", enabled: true, perElement: null, min: 0.1, max: 0.5, step: null },
    ];
    render(<ParameterPanel schema={schema} bounds={enabled} onChange={vi.fn()} />);
    const scope = screen.getByLabelText("runner_length scope") as HTMLSelectElement;
    expect(scope).toBeInTheDocument();
    // uniform + 4 indexed options
    expect(scope.querySelectorAll("option")).toHaveLength(5);
  });
});
