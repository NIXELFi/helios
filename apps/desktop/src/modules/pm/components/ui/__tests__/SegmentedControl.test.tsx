import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SegmentedControl } from "../SegmentedControl";

const OPTIONS = [
  { value: "week", label: "This week" },
  { value: "4w", label: "4 weeks" },
  { value: "season", label: "Season" },
] as const;

describe("SegmentedControl", () => {
  it("renders a radiogroup with the active segment checked", () => {
    render(<SegmentedControl value="4w" onChange={() => {}} options={OPTIONS} ariaLabel="Date range" />);
    expect(screen.getByRole("radiogroup", { name: "Date range" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "4 weeks" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "This week" })).toHaveAttribute("aria-checked", "false");
  });

  it("emits the clicked value", () => {
    const onChange = vi.fn();
    render(<SegmentedControl value="week" onChange={onChange} options={OPTIONS} ariaLabel="Date range" />);
    fireEvent.click(screen.getByRole("radio", { name: "Season" }));
    expect(onChange).toHaveBeenCalledWith("season");
  });

  it("moves with the arrow keys and wraps around", () => {
    const onChange = vi.fn();
    render(<SegmentedControl value="season" onChange={onChange} options={OPTIONS} ariaLabel="Date range" />);
    fireEvent.keyDown(screen.getByRole("radio", { name: "Season" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("week");
    fireEvent.keyDown(screen.getByRole("radio", { name: "Season" }), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("4w");
  });
});
