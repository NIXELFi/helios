// Integration test for the container's trust gate: install must go through the
// consent modal — there is NO code path from a Browse/Detail "Install" click to
// `useInstall` that skips it. This is the security-relevant assertion for C.

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makePlugin } from "./_fixtures";

const subteamList = vi.hoisted(() => [] as { id: string; name: string }[]);
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
  // null = the install list is unavailable, so Installed falls back to the
  // Browse-derived rows (see mergeInstalled), which is what these tests drive.
  useMyInstalls: () => ({ rows: null, loading: false, refetch: () => {}, forget: () => {} }),
  mergeInstalled: (available: ReturnType<typeof makePlugin>[]) =>
    available.filter((p) => p.installedVersion !== null),
}));

// The header's Add to Marketplace / Help affordances and the Review tab are
// capability-gated, so the module now reads org capabilities. Default to a member
// who can neither publish nor review — these tests are about the install gate.
vi.mock("../../org/data/useOrgData", () => ({
  useMyCapabilities: () => ({
    can: () => false,
    canAnywhere: () => false,
    loading: false,
    error: null,
    refetch: () => {},
  }),
  useSubteams: () => ({ data: subteamList, refetch: () => {} }),
}));

// The running-add-on stage reads the member and mounts the sandbox iframe;
// neither exists in jsdom, and neither is what these tests are about.
vi.mock("@helios/auth", () => ({ useUser: () => ({ id: "u1" }) }));
vi.mock("../runtime/PluginHost", () => ({ PluginHost: () => <div data-testid="plugin-host" /> }));

const loader = vi.hoisted(() => ({ version: "1.0.0" }));
vi.mock("../runtime/loader", () => ({
  installedBaseUrl: (id: string) => `plugin://${id}`,
  loadPlugin: async () => ({
    manifest: { id: "m", name: "M", version: loader.version, entry: "index.html", format: 1, sdk: "^1.0.0", permissions: [] },
    baseUrl: "plugin://m",
    entryHtml: "<!doctype html>",
  }),
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

describe("MarketplaceModule — opening an installed add-on", () => {
  it("refuses to run bytes whose version does not match the recorded install", async () => {
    loader.version = "1.0.0";
    mocks.state.plugins = [makePlugin({ id: "m", name: "M", installedVersion: "1.2.0", version: "1.2.0" })];
    render(<MarketplaceModule />);
    fireEvent.click(screen.getByRole("button", { name: /installed/i }));
    fireEvent.click(screen.getByRole("button", { name: /^open$/i }));
    expect(await screen.findByText(/this computer has v1\.0\.0, not v1\.2\.0/i)).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("covers the module with a running add-on instead of unmounting the tabs", async () => {
    loader.version = "1.2.0";
    mocks.state.plugins = [makePlugin({ id: "m", name: "M", installedVersion: "1.2.0", version: "1.2.0" })];
    render(<MarketplaceModule />);
    fireEvent.click(screen.getByRole("button", { name: /installed/i }));
    fireEvent.click(screen.getByRole("button", { name: /^open$/i }));
    // The stage is up, and the tab bar is still in the DOM underneath it.
    await screen.findByTestId("plugin-host");
    expect(screen.getByRole("button", { name: /^browse$/i, hidden: true })).toBeTruthy();
  });

  it("shows the owning subteam by name, never as a raw id", () => {
    mocks.state.plugins = [makePlugin({ id: "p", name: "Named", subteam: "s-1", installedVersion: null })];
    subteamList.push({ id: "s-1", name: "Performance Analysis" });
    render(<MarketplaceModule />);
    expect(screen.getAllByText(/performance analysis/i).length).toBeGreaterThan(0);
    expect(screen.queryByText("s-1")).toBeNull();
    subteamList.length = 0;
  });
});
