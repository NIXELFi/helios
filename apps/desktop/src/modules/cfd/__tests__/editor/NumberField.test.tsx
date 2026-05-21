import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { NumberField } from "../../editor/fields/NumberField";
import type { FieldMeta } from "../../lib/sdm26Schema";

const boreMeta: FieldMeta = {
  key: "cylinder.bore",
  label: "Bore",
  group: "Engine",
  type: "number",
  unit: "mm",
  format: (v) => (typeof v === "number" ? (v * 1000).toFixed(1) : ""),
  formatInverse: (s) => (s.trim() === "" ? null : Number(s) / 1000),
  min: 0.020,
  max: 0.150,
  required: true,
};

describe("NumberField", () => {
  it("renders SI value 0.067 as display '67.0'", () => {
    render(<NumberField meta={boreMeta} value={0.067} onChange={() => {}} />);
    expect(screen.getByLabelText("Bore")).toHaveValue("67.0");
  });
  it("renders unit suffix", () => {
    render(<NumberField meta={boreMeta} value={0.067} onChange={() => {}} />);
    expect(screen.getByText("mm")).toBeInTheDocument();
  });
  it("renders range hint in display units", () => {
    render(<NumberField meta={boreMeta} value={0.067} onChange={() => {}} />);
    expect(screen.getByText(/20\.0 – 150\.0 mm/)).toBeInTheDocument();
  });
  it("on blur, calls onChange with the SI-converted value", () => {
    const onChange = vi.fn();
    render(<NumberField meta={boreMeta} value={0.067} onChange={onChange} />);
    const input = screen.getByLabelText("Bore") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "70" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(0.07);
  });
  it("Enter blurs the input (committing)", () => {
    const onChange = vi.fn();
    render(<NumberField meta={boreMeta} value={0.067} onChange={onChange} />);
    const input = screen.getByLabelText("Bore") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "80" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(0.08);
  });
  it("empty value commits null", () => {
    const onChange = vi.fn();
    render(<NumberField meta={boreMeta} value={0.067} onChange={onChange} />);
    const input = screen.getByLabelText("Bore") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(null);
  });
  it("error replaces the range hint", () => {
    render(<NumberField meta={boreMeta} value={0.067} error="too small" onChange={() => {}} />);
    expect(screen.getByText("too small")).toBeInTheDocument();
    expect(screen.queryByText(/20\.0 – 150\.0 mm/)).not.toBeInTheDocument();
  });
});
