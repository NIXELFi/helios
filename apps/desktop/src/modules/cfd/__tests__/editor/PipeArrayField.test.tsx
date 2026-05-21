import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { PipeArrayField, type PipeRow } from "../../editor/fields/PipeArrayField";

const samplePipe: PipeRow = {
  name: "ir1",
  length: 0.245,
  diameter: 0.038,
  diameter_out: null,
  n_points: 30,
  wall_temperature: 325,
  roughness: 3e-5,
};

describe("PipeArrayField", () => {
  it("renders one editor row per pipe", () => {
    render(
      <PipeArrayField
        title="Intake"
        rows={[samplePipe, { ...samplePipe, name: "ir2" }]}
        onChange={() => {}}
        onAdd={() => {}}
        onDuplicate={() => {}}
        onRemove={() => {}}
      />,
    );
    // Header + 2 data rows = 3 rows total
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getByDisplayValue("ir1")).toBeInTheDocument();
    expect(screen.getByDisplayValue("ir2")).toBeInTheDocument();
  });

  it("Add Pipe calls onAdd", () => {
    const onAdd = vi.fn();
    render(
      <PipeArrayField
        title="Intake"
        rows={[samplePipe]}
        onChange={() => {}}
        onAdd={onAdd}
        onDuplicate={() => {}}
        onRemove={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /\+ Pipe/i }));
    expect(onAdd).toHaveBeenCalledOnce();
  });

  it("Duplicate row calls onDuplicate with the index", () => {
    const onDuplicate = vi.fn();
    render(
      <PipeArrayField
        title="Intake"
        rows={[samplePipe, samplePipe]}
        onChange={() => {}}
        onAdd={() => {}}
        onDuplicate={onDuplicate}
        onRemove={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Duplicate pipe 2/i }));
    expect(onDuplicate).toHaveBeenCalledWith(1);
  });

  it("Remove is hidden when length equals minRows", () => {
    const onRemove = vi.fn();
    render(
      <PipeArrayField
        title="Intake"
        rows={[samplePipe]}
        minRows={1}
        onChange={() => {}}
        onAdd={() => {}}
        onDuplicate={() => {}}
        onRemove={onRemove}
      />,
    );
    expect(screen.queryByRole("button", { name: /Remove pipe/ })).not.toBeInTheDocument();
  });

  it("editing length commits via onChange with SI value", () => {
    const onChange = vi.fn();
    render(
      <PipeArrayField
        title="Intake"
        rows={[samplePipe]}
        onChange={onChange}
        onAdd={() => {}}
        onDuplicate={() => {}}
        onRemove={() => {}}
      />,
    );
    const input = screen.getByLabelText(/Pipe 1 length/);
    fireEvent.change(input, { target: { value: "260" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls.at(-1)?.[0] as PipeRow[];
    expect(last[0]?.length).toBeCloseTo(0.260, 6);
  });
});
