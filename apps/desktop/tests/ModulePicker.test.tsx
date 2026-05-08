import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ModulePicker } from "../src/shell/ModulePicker";

describe("<ModulePicker>", () => {
  it("renders Logs (active) and Vault (with NEW badge) entries", () => {
    render(<ModulePicker active="logs" onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /logs/i })).toBeInTheDocument();
    const vaultBtn = screen.getByRole("button", { name: /vault/i });
    expect(vaultBtn).toBeInTheDocument();
    expect(screen.getByText(/new/i)).toBeInTheDocument();
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
