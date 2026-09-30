import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { fieldError, fieldErrors, runSizingFields, OPT_N_CYCLES_MAX } from "../lib/runParams";
import { vdSweepValues, VD_SWEEP_MAX_POINTS } from "../lib/performance/vdSweep";
import { SweepParamsModal } from "../components/SweepParamsModal";

describe("runParams field checks", () => {
  it("accepts the modal defaults", () => {
    expect(fieldErrors(runSizingFields(40, 5e-3, 30))).toEqual([]);
    expect(fieldErrors(runSizingFields(8, 5e-3, 3, OPT_N_CYCLES_MAX))).toEqual([]);
  });

  it("rejects huge, zero, fractional and non-finite max cycles", () => {
    for (const n of [1e9, 0, 2.5, NaN, Infinity]) {
      expect(fieldErrors(runSizingFields(n, 5e-3, 30))[0]).toMatch(/Max cycles/);
    }
    expect(fieldErrors(runSizingFields(51, 5e-3, 3, OPT_N_CYCLES_MAX))).toHaveLength(1);
  });

  it("rejects out-of-range rpm and tolerance", () => {
    expect(fieldError({ label: "RPM", value: 0, min: 500, max: 20000 })).toMatch(/RPM/);
    expect(fieldError({ label: "RPM", value: NaN, min: 500, max: 20000 })).not.toBeNull();
    expect(fieldErrors(runSizingFields(40, -1, 30))[0]).toMatch(/tol/);
  });
});

describe("vdSweepValues bounds", () => {
  it("caps a tiny step over a wide range", () => {
    expect(vdSweepValues({ param: "massKg", start: 0, stop: 1e6, step: 1e-9 })).toHaveLength(
      VD_SWEEP_MAX_POINTS,
    );
  });

  it("returns [] for non-finite bounds", () => {
    expect(vdSweepValues({ param: "massKg", start: 0, stop: Infinity, step: 1 })).toEqual([]);
    expect(vdSweepValues({ param: "massKg", start: 0, stop: 10, step: NaN })).toEqual([]);
  });
});

describe("SweepParamsModal validation", () => {
  it("disables Start and names the field when max cycles is out of range", () => {
    const onStart = vi.fn();
    render(<SweepParamsModal open defaultPath="C:/x/sdm26.json" onCancel={() => {}} onStart={onStart} />);
    const start = screen.getByRole("button", { name: "Start sweep" });
    expect(start).not.toBeDisabled();

    const nCycles = screen.getByDisplayValue("40");
    fireEvent.change(nCycles, { target: { value: "1000000000" } });
    expect(start).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/Max cycles must be an integer in \[1, 200\]/);
    fireEvent.click(start);
    expect(onStart).not.toHaveBeenCalled();
  });
});
