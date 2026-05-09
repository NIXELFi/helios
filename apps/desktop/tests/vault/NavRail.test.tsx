import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { NavRail } from "../../src/modules/vault/components/NavRail";

describe("<NavRail>", () => {
  it("renders Browse / History / Who has what entries", () => {
    render(<NavRail active="browse" onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /browse/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /history/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /who has what/i })).toBeInTheDocument();
  });

  it("marks the active entry with aria-current", () => {
    render(<NavRail active="who" onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /who has what/i })).toHaveAttribute("aria-current", "page");
  });

  it("calls onSelect on click", () => {
    const onSelect = vi.fn();
    render(<NavRail active="browse" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /history/i }));
    expect(onSelect).toHaveBeenCalledWith("history");
  });
});
