import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { NavRail, DEFAULT_NAV_ENTRIES } from "../components/NavRail";

describe("NavRail", () => {
  it("renders default entries in order", () => {
    render(<NavRail active="config" onSelect={() => {}} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(DEFAULT_NAV_ENTRIES.map((e) => e.label));
  });

  it("marks the active entry with aria-current=page", () => {
    render(<NavRail active="results" onSelect={() => {}} />);
    expect(screen.getByText("Results")).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("Config")).not.toHaveAttribute("aria-current", "page");
  });

  it("invokes onSelect with the entry id", () => {
    const onSelect = vi.fn();
    render(<NavRail active="config" onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Studies"));
    expect(onSelect).toHaveBeenCalledWith("studies");
  });

  it("respects disabled entries (does not invoke onSelect)", () => {
    const onSelect = vi.fn();
    render(
      <NavRail
        active="config"
        onSelect={onSelect}
        entries={[
          { id: "config", label: "Config" },
          { id: "studies", label: "Studies", disabled: true, description: "Coming later" },
        ]}
      />,
    );
    fireEvent.click(screen.getByText("Studies"));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
