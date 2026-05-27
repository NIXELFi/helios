import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { NavRail, DEFAULT_NAV_ENTRIES, formatDataSize } from "../components/NavRail";

const baseProps = {
  dataUsageBytes: 0,
  onRequestClearData: () => {},
};

describe("NavRail", () => {
  it("renders default entries in order", () => {
    render(<NavRail {...baseProps} active="config" onSelect={() => {}} />);
    // Anchor the regex so the Clear-data button's "configs preserved"
    // subtitle doesn't match the /Config/i screen-entry probe.
    const navEntries = DEFAULT_NAV_ENTRIES.map((e) =>
      screen.getByRole("button", { name: new RegExp(`^${e.label}$`, "i") }),
    );
    expect(navEntries.map((b) => b.textContent)).toEqual(DEFAULT_NAV_ENTRIES.map((e) => e.label));
  });

  it("marks the active entry with aria-current=page", () => {
    render(<NavRail {...baseProps} active="results" onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /^results$/i })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: /^config$/i })).not.toHaveAttribute("aria-current", "page");
  });

  it("invokes onSelect with the entry id", () => {
    const onSelect = vi.fn();
    render(<NavRail {...baseProps} active="config" onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Studies"));
    expect(onSelect).toHaveBeenCalledWith("studies");
  });

  it("respects disabled entries (does not invoke onSelect)", () => {
    const onSelect = vi.fn();
    render(
      <NavRail
        {...baseProps}
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

  it("renders the Clear-data button with the formatted byte size and calls onRequestClearData on click", () => {
    const onRequestClearData = vi.fn();
    render(
      <NavRail
        active="config"
        onSelect={() => {}}
        dataUsageBytes={1.5 * 1024 * 1024 * 1024}
        onRequestClearData={onRequestClearData}
      />,
    );
    const clearBtn = screen.getByRole("button", { name: /clear data/i });
    expect(clearBtn).toHaveTextContent("1.50 GB");
    fireEvent.click(clearBtn);
    expect(onRequestClearData).toHaveBeenCalled();
  });

  it("renders an ellipsis while the byte size is loading (null)", () => {
    render(
      <NavRail
        {...baseProps}
        dataUsageBytes={null}
        active="config"
        onSelect={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /clear data/i })).toHaveTextContent("…");
  });
});

describe("formatDataSize", () => {
  it("renders 0 / negative / NaN as '0 B'", () => {
    expect(formatDataSize(0)).toBe("0 B");
    expect(formatDataSize(-5)).toBe("0 B");
    expect(formatDataSize(Number.NaN)).toBe("0 B");
  });

  it("renders bytes / KB / MB / GB at the right thresholds", () => {
    expect(formatDataSize(512)).toBe("512 B");
    expect(formatDataSize(1024)).toBe("1 KB");
    expect(formatDataSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatDataSize(1024 * 1024 * 1024)).toBe("1.00 GB");
    expect(formatDataSize(2.5 * 1024 * 1024 * 1024)).toBe("2.50 GB");
  });
});
