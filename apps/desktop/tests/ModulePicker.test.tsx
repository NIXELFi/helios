import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ModulePicker } from "../src/shell/ModulePicker";

const baseProps = {
  appVersion: "3.6.0",
  updaterState: { kind: "up_to_date" as const, current: "3.6.0" },
  onUpdaterClick: () => {},
  userLabel: null as string | null,
  onOpenAuth: () => {},
  onSignOut: () => {},
  onDisconnect: () => {},
  vaultEnabled: true,
};

describe("<ModulePicker>", () => {
  it("renders Logs (active), Vault, and CFD entries with NEW badges", () => {
    render(<ModulePicker {...baseProps} active="logs" onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /logs/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /vault/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cfd/i })).toBeInTheDocument();
    // Two "NEW" badges now (Vault + CFD).
    expect(screen.getAllByText(/^new$/i).length).toBeGreaterThanOrEqual(2);
  });

  it("highlights the active module via aria-current", () => {
    render(<ModulePicker {...baseProps} active="vault" onSelect={() => {}} />);
    const vaultBtn = screen.getByRole("button", { name: /vault/i });
    expect(vaultBtn).toHaveAttribute("aria-current", "page");
    const logsBtn = screen.getByRole("button", { name: /logs/i });
    expect(logsBtn).not.toHaveAttribute("aria-current", "page");
  });

  it("calls onSelect when an entry is clicked", () => {
    const onSelect = vi.fn();
    render(<ModulePicker {...baseProps} active="logs" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /vault/i }));
    expect(onSelect).toHaveBeenCalledWith("vault");
  });

  it("renders the HELIOS wordmark and app version in the sidebar header", () => {
    render(<ModulePicker {...baseProps} active="logs" onSelect={() => {}} />);
    expect(screen.getByText("HELIOS")).toBeInTheDocument();
    // Version appears in two spots — the sidebar header subtitle and the
    // UpdatesPill ("✓ v3.6.0"). The subtitle is the persistent label.
    expect(screen.getByText(/v3\.6\.0 · ground-station/i)).toBeInTheDocument();
  });

  it("invokes onUpdaterClick when the updates pill is clicked", () => {
    const onUpdaterClick = vi.fn();
    render(
      <ModulePicker
        {...baseProps}
        active="logs"
        onSelect={() => {}}
        onUpdaterClick={onUpdaterClick}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /v3\.6\.0/i }));
    expect(onUpdaterClick).toHaveBeenCalled();
  });

  it("shows a Sign in pill that calls onOpenAuth when logged out", () => {
    const onOpenAuth = vi.fn();
    render(
      <ModulePicker {...baseProps} active="logs" onSelect={() => {}} userLabel={null} onOpenAuth={onOpenAuth} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
    expect(onOpenAuth).toHaveBeenCalled();
  });

  it("shows the user label + a dropdown with Sign out / Disconnect when logged in", () => {
    const onSignOut = vi.fn();
    const onDisconnect = vi.fn();
    render(
      <ModulePicker
        {...baseProps}
        active="logs"
        onSelect={() => {}}
        userLabel="Nick M."
        onSignOut={onSignOut}
        onDisconnect={onDisconnect}
      />,
    );
    const pill = screen.getByRole("button", { name: /nick m\./i });
    fireEvent.click(pill);
    fireEvent.click(screen.getByRole("menuitem", { name: /sign out/i }));
    expect(onSignOut).toHaveBeenCalled();
    fireEvent.click(pill);
    fireEvent.click(screen.getByRole("menuitem", { name: /disconnect/i }));
    expect(onDisconnect).toHaveBeenCalled();
  });

  it("greys out the Vault button when vaultEnabled is false and still fires onSelect (Shell routes to auth)", () => {
    const onSelect = vi.fn();
    render(
      <ModulePicker {...baseProps} active="logs" onSelect={onSelect} vaultEnabled={false} />,
    );
    const vaultBtn = screen.getByRole("button", { name: /vault/i });
    expect(vaultBtn).toHaveAttribute("aria-disabled", "true");
    // aria-current is never set on a disabled entry.
    expect(vaultBtn).not.toHaveAttribute("aria-current", "page");
    // Click still fires onSelect — the Shell turns this into "open auth modal".
    fireEvent.click(vaultBtn);
    expect(onSelect).toHaveBeenCalledWith("vault");
  });
});
