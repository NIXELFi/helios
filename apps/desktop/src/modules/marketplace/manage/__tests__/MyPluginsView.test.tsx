import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MyPlugin } from "../useMyPlugins";

const state = {
  plugins: [] as MyPlugin[],
  loading: false,
  error: null as string | null,
  userId: "author-1",
  reviewer: false,
};
const fns = {
  withdraw: vi.fn((_id: string, _v: string) => Promise.resolve()),
  yank: vi.fn((_id: string, _v: string, _r?: string) => Promise.resolve()),
  setRecommended: vi.fn((_id: string, _v: boolean) => Promise.resolve()),
};

vi.mock("@helios/auth", () => ({ useUser: () => ({ id: state.userId }) }));
vi.mock("../../../org/data/useOrgData", () => ({
  useMyCapabilities: () => ({
    can: (cap: string) => cap === "marketplace.review" && state.reviewer,
    canAnywhere: () => true,
    loading: false,
    error: null,
    refetch: () => {},
  }),
  useSubteams: () => ({ data: [{ id: "s1", name: "Aero" }], refetch: () => {} }),
}));
vi.mock("../useMyPlugins", async (orig) => ({
  ...(await orig<typeof import("../useMyPlugins")>()),
  useMyPlugins: () => ({
    loading: state.loading,
    error: state.error,
    plugins: state.plugins,
    refetch: () => {},
    withdraw: fns.withdraw,
    yank: fns.yank,
    setRecommended: fns.setRecommended,
    pending: null,
    actionError: null,
  }),
}));

import { MyPluginsView, YANK_EXPLAINER } from "../MyPluginsView";

const v = (version: string, status: MyPlugin["versions"][number]["status"], over = {}) => ({
  version,
  status,
  reviewNotes: null,
  reviewedAt: null,
  bundleBytes: 1000,
  publishedBy: "author-1",
  publishedAt: `2026-09-${version.replace(/\./g, "").padStart(2, "0")}T00:00:00Z`,
  permissions: [],
  ...over,
});

const PLUGIN: MyPlugin = {
  id: "aero.tool",
  name: "Aero Tool",
  subteam: "s1",
  isRecommended: false,
  latestVersion: "1.0.0",
  versions: [
    v("1.2.0", "pending"),
    v("1.1.0", "rejected", { reviewNotes: "Please drop the unused storage permission." }),
    v("1.0.0", "approved"),
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  state.plugins = [PLUGIN];
  state.loading = false;
  state.error = null;
  state.userId = "author-1";
  state.reviewer = false;
});

describe("MyPluginsView", () => {
  it("shows a status chip per version", () => {
    render(<MyPluginsView onHelp={() => {}} onAdd={() => {}} />);
    expect(screen.getByText("In review")).toBeInTheDocument();
    expect(screen.getByText("Changes requested")).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
  });

  it("renders the rejection note inline", () => {
    render(<MyPluginsView onHelp={() => {}} onAdd={() => {}} />);
    expect(screen.getByText(/drop the unused storage permission/i)).toBeInTheDocument();
  });

  it("only offers withdraw on pending and yank on approved", async () => {
    render(<MyPluginsView onHelp={() => {}} onAdd={() => {}} />);
    expect(screen.getAllByRole("button", { name: /withdraw/i })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^yank$/i })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /withdraw/i }));
    await waitFor(() => expect(fns.withdraw).toHaveBeenCalledWith("aero.tool", "1.2.0"));
  });

  it("states that yanking leaves existing installs working, then yanks with the reason", async () => {
    render(<MyPluginsView onHelp={() => {}} onAdd={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^yank$/i }));
    expect(screen.getByText(new RegExp(YANK_EXPLAINER.slice(0, 40)))).toBeInTheDocument();
    expect(YANK_EXPLAINER).toMatch(/keeps a working copy/);

    fireEvent.change(screen.getByLabelText(/reason for yanking/i), { target: { value: "crashes on load" } });
    fireEvent.click(screen.getByRole("button", { name: /yank v1\.0\.0/i }));
    await waitFor(() => expect(fns.yank).toHaveBeenCalledWith("aero.tool", "1.0.0", "crashes on load"));
  });

  it("does not offer withdraw or yank on a teammate's versions to a non-reviewer", () => {
    state.userId = "someone-else";
    render(<MyPluginsView onHelp={() => {}} onAdd={() => {}} />);
    expect(screen.queryByRole("button", { name: /withdraw/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^yank$/i })).not.toBeInTheDocument();
  });

  it("lets a reviewer manage a teammate's versions and toggle recommended", async () => {
    state.userId = "someone-else";
    state.reviewer = true;
    render(<MyPluginsView onHelp={() => {}} onAdd={() => {}} />);
    expect(screen.getByRole("button", { name: /withdraw/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^recommend$/i }));
    await waitFor(() => expect(fns.setRecommended).toHaveBeenCalledWith("aero.tool", true));
  });

  it("hides the recommend toggle from a publisher who is not a reviewer", () => {
    render(<MyPluginsView onHelp={() => {}} onAdd={() => {}} />);
    expect(screen.queryByRole("button", { name: /recommend/i })).not.toBeInTheDocument();
  });

  it("shows an empty state that points at Add to Marketplace", () => {
    state.plugins = [];
    const onAdd = vi.fn();
    render(<MyPluginsView onHelp={() => {}} onAdd={onAdd} />);
    fireEvent.click(screen.getByRole("button", { name: /add to marketplace/i }));
    expect(onAdd).toHaveBeenCalled();
  });

  it("keeps the list (and any half-typed yank reason) while reloading", () => {
    state.loading = true;
    render(<MyPluginsView onHelp={() => {}} onAdd={() => {}} />);
    expect(screen.getByText("Aero Tool")).toBeInTheDocument();
  });
});
