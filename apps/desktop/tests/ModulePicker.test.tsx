import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ModulePicker } from "../src/shell/ModulePicker";

describe("<ModulePicker>", () => {
  it("renders Logs (active), Vault, and CFD entries with NEW badges", () => {
    render(<ModulePicker active="logs" onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /logs/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /vault/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cfd/i })).toBeInTheDocument();
    // Two "NEW" badges now (Vault + CFD).
    expect(screen.getAllByText(/^new$/i).length).toBeGreaterThanOrEqual(2);
  });

  it("highlights the active module via aria-current", () => {
    render(<ModulePicker active="vault" onSelect={() => {}} />);
    const vaultBtn = screen.getByRole("button", { name: /vault/i });
    expect(vaultBtn).toHaveAttribute("aria-current", "page");
    const logsBtn = screen.getByRole("button", { name: /logs/i });
    expect(logsBtn).not.toHaveAttribute("aria-current", "page");
  });

  it("calls onSelect when an entry is clicked", () => {
    const onSelect = vi.fn();
    render(<ModulePicker active="logs" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /vault/i }));
    expect(onSelect).toHaveBeenCalledWith("vault");
  });
});
