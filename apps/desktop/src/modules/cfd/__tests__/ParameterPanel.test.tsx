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

describe("ParameterPanel — in/out diameter lock", () => {
  const pairSchema: ParameterMeta[] = [
    {
      path: "primary_diameter_in",
      kind: "array",
      arrayLen: 4,
      unit: "m",
      default: 0.035,
      suggestedMin: 0.025,
      suggestedMax: 0.055,
      group: "Exhaust",
    },
    {
      path: "primary_diameter_out",
      kind: "array",
      arrayLen: 4,
      unit: "m",
      default: 0.035,
      suggestedMin: 0.025,
      suggestedMax: 0.055,
      group: "Exhaust",
    },
  ];

  it("only the leader row shows the 'lock in/out' toggle", () => {
    render(<ParameterPanel schema={pairSchema} bounds={[]} onChange={vi.fn()} />);
    expect(screen.getByLabelText("Lock primary_diameter_in in/out together")).toBeInTheDocument();
    expect(screen.queryByLabelText("Lock primary_diameter_out in/out together")).toBeNull();
  });

  it("activating the lock on the leader forces the follower row into a disabled, locked state", () => {
    const onChange = vi.fn();
    const bounds: ParameterBoundsUI[] = [
      {
        path: "primary_diameter_in",
        enabled: true,
        perElement: null,
        min: 0.025,
        max: 0.055,
        step: null,
      },
    ];
    const { rerender } = render(
      <ParameterPanel schema={pairSchema} bounds={bounds} onChange={onChange} />,
    );

    fireEvent.click(screen.getByLabelText("Lock primary_diameter_in in/out together"));

    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls.at(-1)?.[0] as ParameterBoundsUI[];
    const leader = next.find((b) => b.path === "primary_diameter_in");
    const follower = next.find((b) => b.path === "primary_diameter_out");
    expect(leader?.lockToFollower).toBe(true);
    // Follower row is materialized (so the panel can dim it deterministically),
    // with enabled=false and perElement mirroring the leader.
    expect(follower).toBeDefined();
    expect(follower?.enabled).toBe(false);
    expect(follower?.perElement).toBe(null);

    rerender(<ParameterPanel schema={pairSchema} bounds={next} onChange={onChange} />);
    // The follower row's enable checkbox is now disabled and shows "locked to" badge.
    const followerEnable = screen.getByLabelText(
      "Enable primary_diameter_out as tunable",
    ) as HTMLInputElement;
    expect(followerEnable.disabled).toBe(true);
    expect(screen.getByText(/← locked to primary_diameter_in/)).toBeInTheDocument();
  });

  it("changing the leader's perElement scope syncs the follower row's displayed index", () => {
    const onChange = vi.fn();
    const bounds: ParameterBoundsUI[] = [
      {
        path: "primary_diameter_in",
        enabled: true,
        perElement: null,
        min: 0.025,
        max: 0.055,
        step: null,
        lockToFollower: true,
      },
      {
        path: "primary_diameter_out",
        enabled: false,
        perElement: null,
        min: 0.025,
        max: 0.055,
        step: null,
      },
    ];
    render(<ParameterPanel schema={pairSchema} bounds={bounds} onChange={onChange} />);
    const leaderScope = screen.getByLabelText(
      "primary_diameter_in scope",
    ) as HTMLSelectElement;
    fireEvent.change(leaderScope, { target: { value: "2" } });

    const next = onChange.mock.calls.at(-1)?.[0] as ParameterBoundsUI[];
    const follower = next.find((b) => b.path === "primary_diameter_out");
    expect(follower?.perElement).toBe(2);
    expect(follower?.enabled).toBe(false);
  });
});
