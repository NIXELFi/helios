// Integration test for the container's trust gate: install must go through the
// consent modal — there is NO code path from a Browse/Detail "Install" click to
// `useInstall` that skips it. This is the security-relevant assertion for C.

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makePlugin } from "./_fixtures";

const mocks = vi.hoisted(() => ({
  install: vi.fn(async () => {}),
  uninstall: vi.fn(async () => {}),
  refetch: vi.fn(),
  state: { plugins: [] as ReturnType<typeof makePlugin>[], loading: false, error: null as string | null },
}));

vi.mock("../data/useMarketplace", () => ({
  useAvailablePlugins: () => ({
    plugins: mocks.state.plugins,
    loading: mocks.state.loading,
    error: mocks.state.error,
    refetch: mocks.refetch,
  }),
  useInstall: () => ({ install: mocks.install, installing: false, error: null }),
  useUninstall: () => ({ uninstall: mocks.uninstall, removing: false, error: null }),
}));

import { MarketplaceModule } from "../MarketplaceModule";

afterEach(cleanup);
beforeEach(() => {
  mocks.install.mockClear();
  mocks.uninstall.mockClear();
  mocks.refetch.mockClear();
  mocks.state.plugins = [];
  mocks.state.loading = false;
  mocks.state.error = null;
});

describe("MarketplaceModule — install consent gate", () => {
  it("opens consent on Install and does not call useInstall until confirmed", async () => {
    mocks.state.plugins = [
      makePlugin({ id: "m", name: "Matlab Tool", permissions: ["engine:matlab"], installedVersion: null }),
    ];
    render(<MarketplaceModule />);

    fireEvent.click(screen.getByRole("button", { name: /^install$/i }));

    // Modal is up, the high-trust warning shows, and NOTHING has installed yet.
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/run code outside the sandbox/i)).toBeTruthy();
    expect(mocks.install).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /install anyway/i }));
    await waitFor(() => expect(mocks.install).toHaveBeenCalledWith({ id: "m", version: "1.0.0" }));
    await waitFor(() => expect(mocks.refetch).toHaveBeenCalled());
  });

  it("does not install when consent is cancelled", () => {
    mocks.state.plugins = [makePlugin({ id: "s", permissions: ["storage"], installedVersion: null })];
    render(<MarketplaceModule />);

    fireEvent.click(screen.getByRole("button", { name: /^install$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    expect(mocks.install).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Refresh button re-checks the catalog via refetch", () => {
    mocks.state.plugins = [makePlugin({ id: "a", name: "Alpha", installedVersion: null })];
    render(<MarketplaceModule />);

    fireEvent.click(screen.getByRole("button", { name: /refresh plugin list/i }));
    expect(mocks.refetch).toHaveBeenCalled();
  });

  it("does not uninstall until the confirmation is accepted", async () => {
    // The destructive twin of the install gate: the trash icon must never reach
    // `useUninstall` on its own.
    mocks.state.plugins = [makePlugin({ id: "b", name: "Bravo", installedVersion: "1.0.0", version: "1.0.0" })];
    render(<MarketplaceModule />);
    fireEvent.click(screen.getByRole("button", { name: /installed/i }));

    fireEvent.click(screen.getByRole("button", { name: /uninstall bravo/i }));
    expect(mocks.uninstall).not.toHaveBeenCalled();

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toMatch(/Bravo/);
    expect(dialog.textContent).toMatch(/can’t be undone/i);
    expect(dialog.textContent).toMatch(/erased/i);

    fireEvent.click(screen.getByRole("button", { name: /^uninstall$/i }));
    await waitFor(() => expect(mocks.uninstall).toHaveBeenCalledWith("b"));
    await waitFor(() => expect(mocks.refetch).toHaveBeenCalled());
  });

  it("does not uninstall when the confirmation is dismissed", () => {
    mocks.state.plugins = [makePlugin({ id: "b", name: "Bravo", installedVersion: "1.0.0", version: "1.0.0" })];
    render(<MarketplaceModule />);
    fireEvent.click(screen.getByRole("button", { name: /installed/i }));

    fireEvent.click(screen.getByRole("button", { name: /uninstall bravo/i }));
    fireEvent.click(screen.getByRole("button", { name: /keep it/i }));

    expect(mocks.uninstall).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("switches to the Installed tab and lists installed add-ons", () => {
    mocks.state.plugins = [
      makePlugin({ id: "a", name: "Alpha", installedVersion: null }),
      makePlugin({ id: "b", name: "Bravo", installedVersion: "1.0.0", version: "1.0.0" }),
    ];
    render(<MarketplaceModule />);

    fireEvent.click(screen.getByRole("button", { name: /installed/i }));
    expect(screen.getByText("Bravo")).toBeTruthy();
    // Alpha is not installed, so it should not appear on the Installed tab.
    expect(screen.queryByText("Alpha")).toBeNull();
  });
});
