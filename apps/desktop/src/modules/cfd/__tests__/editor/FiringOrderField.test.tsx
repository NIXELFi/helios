import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { FiringOrderField } from "../../editor/fields/FiringOrderField";

describe("FiringOrderField", () => {
  it("renders one chip per position with the cylinder number", () => {
    render(<FiringOrderField value={[1, 2, 4, 3]} nCylinders={4} onChange={() => {}} />);
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  it("right arrow on position 1 swaps it with position 2", () => {
    const onChange = vi.fn();
    render(<FiringOrderField value={[1, 2, 4, 3]} nCylinders={4} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Move position 1 right"));
    expect(onChange).toHaveBeenCalledWith([2, 1, 4, 3]);
  });

  it("left arrow on the first slot is disabled", () => {
    render(<FiringOrderField value={[1, 2, 4, 3]} nCylinders={4} onChange={() => {}} />);
    expect(screen.getByLabelText("Move position 1 left")).toBeDisabled();
  });

  it("right arrow on the last slot is disabled", () => {
    render(<FiringOrderField value={[1, 2, 4, 3]} nCylinders={4} onChange={() => {}} />);
    expect(screen.getByLabelText("Move position 4 right")).toBeDisabled();
  });

  it("displays a validation error for a wrong-length order", () => {
    render(<FiringOrderField value={[1, 2, 3]} nCylinders={4} onChange={() => {}} />);
    expect(screen.getByText(/needs exactly 4 entries/)).toBeInTheDocument();
  });
});
