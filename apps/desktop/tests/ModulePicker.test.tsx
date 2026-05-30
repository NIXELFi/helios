import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ModulePicker } from "../src/shell/ModulePicker";

const baseProps = {
  appVersion: "3.7.0",
  updaterState: { kind: "up_to_date" as const, current: "3.7.0" },
  onUpdaterClick: () => {},
  userLabel: null as string | null,
  userSubteam: null as string | null,
  userRole: null as string | null,
  onOpenAuth: () => {},
  onSignOut: () => {},
  onDisconnect: () => {},
  onChangePassword: () => {},
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
    // UpdatesPill ("✓ v3.7.0"). The subtitle is the persistent label.
    expect(screen.getByText(/v3\.7\.0 · ground-station/i)).toBeInTheDocument();
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
    // The UpdatesPill's accessible name now mirrors its state (S9 aria-label),
    // so target it by the up-to-date description rather than the version glyph.
    fireEvent.click(screen.getByRole("button", { name: /latest version/i }));
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

  it("shows the user's subteam and role under their name in the pill", () => {
    render(
      <ModulePicker
        {...baseProps}
        active="logs"
        onSelect={() => {}}
        userLabel="Nick Murray"
        userSubteam="Engine"
        userRole="owner"
      />,
    );
    expect(screen.getByText("Engine")).toBeInTheDocument();
    expect(screen.getByText("owner")).toBeInTheDocument();
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

  // S9: the disabled-but-clickable Vault entry must show a real hover cue
  // (it opens sign-in) — not a no-op hover equal to its base border, and not
  // the default cursor that implies "dead".
  it("the disabled Vault entry advertises it is still clickable (S9)", () => {
    render(
      <ModulePicker {...baseProps} active="logs" onSelect={() => {}} vaultEnabled={false} />,
    );
    const vaultBtn = screen.getByRole("button", { name: /vault/i });
    // A real hover cue: a hover:border-* that is NOT the base helios-line.
    expect(vaultBtn.className).toMatch(/hover:border-asu-gold/);
    // No-op hover (hover === base border) must be gone.
    expect(vaultBtn.className).not.toMatch(/hover:border-helios-line/);
    // Clickable affordance, not the dead default cursor.
    expect(vaultBtn.className).toMatch(/cursor-pointer/);
  });

  // S9: the version subtitle truncates and shows a placeholder (not "vdev")
  // while the real version is still loading.
  it("shows a version placeholder instead of 'vdev' while loading (S9)", () => {
    render(<ModulePicker {...baseProps} active="logs" onSelect={() => {}} appVersion="dev" />);
    expect(screen.queryByText(/vdev/i)).not.toBeInTheDocument();
    // The persistent label still names the station.
    expect(screen.getByText(/ground-station/i)).toBeInTheDocument();
  });

  it("the version subtitle truncates a real version (S9)", () => {
    render(<ModulePicker {...baseProps} active="logs" onSelect={() => {}} appVersion="3.7.0" />);
    const line = screen.getByText(/v3\.7\.0 · ground-station/i);
    expect(line.className).toMatch(/truncate/);
  });

  // S9: arrow keys move focus between menu items (roving focus) and Escape
  // restores focus to the trigger.
  it("supports arrow-key navigation in the account menu and restores focus on close (S9)", () => {
    render(
      <ModulePicker {...baseProps} active="logs" onSelect={() => {}} userLabel="Nick M." />,
    );
    const pill = screen.getByRole("button", { name: /nick m\./i });
    fireEvent.click(pill);
    const items = screen.getAllByRole("menuitem");
    // First item is focused on open.
    expect(items[0]).toHaveFocus();
    // ArrowDown moves to the next item.
    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();
    // ArrowUp from the first wraps to the last.
    fireEvent.keyDown(items[1], { key: "ArrowUp" });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(items[0], { key: "ArrowUp" });
    expect(items[items.length - 1]).toHaveFocus();
    // Escape closes and restores focus to the trigger.
    fireEvent.keyDown(items[items.length - 1], { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(pill).toHaveFocus();
  });
});
