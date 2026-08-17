/**
 * Shared dashboard layout hook: server-adopt, offline fallback, capability
 * gating, the debounced save (structural changes only — switching the active
 * tab must never write the shared layout), the crash-safe pending marker, the
 * no-row bootstrap, and the scope-change hard reset (a scope prop change
 * without a remount must never leak one scope's tabs into another's row).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  addTab,
  defaultDashboardConfig,
  hasLayoutSavePending,
  markLayoutSavePending,
  rememberDashboardConfig,
  setActiveTab,
  sharedDashboardPayload,
} from "../dashboardSettings";

// The signed-in user; the hook only reads currentUserId from the store.
vi.mock("@pm/lib/pmStore", () => ({
  usePmStore: (sel: (s: { currentUserId: string | null }) => unknown) => sel({ currentUserId: "u1" }),
}));

// Chainable fake for client.schema("pm"). Behavior is driven per-test through
// the `remote` box: the row the select resolves, the capability answer, and a
// log of save_dashboard_layout calls.
interface RemoteBox {
  row: { data: { config: unknown } | null; error: { message: string } | null };
  // When set, the row fetch stalls until this resolves (for in-flight races).
  fetchGate: Promise<void> | null;
  canEdit: boolean;
  saveError: boolean;
  saves: Array<{ stid: string | null; cfg: unknown }>;
}
const remote: RemoteBox = { row: { data: null, error: null }, fetchGate: null, canEdit: false, saveError: false, saves: [] };

// One stable client object — a fresh reference per render would re-fire the
// hook's [client, ...] effects forever.
vi.mock("@helios/auth", () => {
  const schema = {
    from: () => {
      const builder = {
        select: () => builder,
        is: () => builder,
        eq: () => builder,
        maybeSingle: async () => {
          if (remote.fetchGate) await remote.fetchGate;
          return remote.row;
        },
      };
      return builder;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "has_capability") return { data: remote.canEdit, error: null };
      if (name === "save_dashboard_layout") {
        remote.saves.push(args as { stid: string | null; cfg: unknown });
        return remote.saveError ? { data: null, error: { message: "boom" } } : { data: null, error: null };
      }
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    },
  };
  const client = { schema: () => schema };
  return { useSupabaseClient: () => client };
});

import { useSharedDashboardLayout } from "../useSharedDashboardLayout";

type Props = { subteamId: string | null; teamSlug: string | null; isSubteamScope: boolean };
const PROJECT: Props = { subteamId: null, teamSlug: null, isSubteamScope: false };
const AERO: Props = { subteamId: "st1", teamSlug: "aero", isSubteamScope: true };

function mount(props: Props = PROJECT) {
  return renderHook((p: Props) => useSharedDashboardLayout(p), { initialProps: props });
}

// A shared server row: the project defaults plus one recognizable tab.
function serverRowWithTab(name: string, isSubteamScope = false) {
  return { data: { config: sharedDashboardPayload(addTab(defaultDashboardConfig(isSubteamScope), name)) }, error: null };
}

beforeEach(() => {
  window.localStorage.clear();
  remote.row = { data: null, error: null };
  remote.fetchGate = null;
  remote.canEdit = false;
  remote.saveError = false;
  remote.saves = [];
});

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
});

describe("loading the shared layout", () => {
  it("adopts server tabs (status synced), caches them, and backs up the pre-shared local copy", async () => {
    rememberDashboardConfig(null, addTab(defaultDashboardConfig(false), "My Personal Layout"));
    remote.row = serverRowWithTab("Leads Only");

    const { result } = mount();
    await waitFor(() => expect(result.current.status).toBe("synced"));
    expect(result.current.config.tabs.map((t) => t.name)).toContain("Leads Only");
    expect(window.localStorage.getItem("helios:dashboard:__project__")).toContain("Leads Only");
    // The replaced personal layout is preserved under the write-once backup.
    expect(window.localStorage.getItem("helios:dashboard:preshared-backup:__project__")).toContain(
      "My Personal Layout",
    );
  });

  it("no shared row (viewer) → status none, local default kept, no save", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.status).toBe("none"));
    expect(result.current.config.tabs).toHaveLength(3);
    expect(remote.saves).toHaveLength(0);
  });

  it("fetch error → status offline, cached layout preserved (nothing lost)", async () => {
    rememberDashboardConfig(null, addTab(defaultDashboardConfig(false), "My Cached Tab"));
    remote.row = { data: null, error: { message: "Failed to fetch" } };

    const { result } = mount();
    await waitFor(() => expect(result.current.status).toBe("offline"));
    expect(result.current.config.tabs.map((t) => t.name)).toContain("My Cached Tab");
  });

  it("foreign/invalid server payload → treated as none", async () => {
    remote.row = { data: { config: { version: 99, tabs: "nope" } }, error: null };
    const { result } = mount();
    await waitFor(() => expect(result.current.status).toBe("none"));
  });
});

describe("capability gating", () => {
  it("canEdit reflects pm.manage_dashboard", async () => {
    remote.canEdit = true;
    const { result } = mount();
    await waitFor(() => expect(result.current.canEdit).toBe(true));
  });

  it("defaults to not editable", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.status).toBe("none"));
    expect(result.current.canEdit).toBe(false);
  });
});

describe("bootstrap (no shared row yet)", () => {
  it("an editor's current local layout is published as the shared row", async () => {
    rememberDashboardConfig(null, addTab(defaultDashboardConfig(false), "Pre-Shared Custom"));
    remote.canEdit = true;

    const { result } = mount();
    await waitFor(() => expect(result.current.status).toBe("synced"));
    expect(remote.saves).toHaveLength(1);
    const payload = remote.saves[0]!.cfg as { tabs: Array<{ name: string }> };
    expect(payload.tabs.map((t) => t.name)).toContain("Pre-Shared Custom");
    // Confirmed save → no pending marker left behind.
    expect(hasLayoutSavePending(null)).toBe(false);
  });

  it("does not bootstrap for non-editors", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.status).toBe("none"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 900));
    });
    expect(remote.saves).toHaveLength(0);
  });
});

describe("saving", () => {
  it("a structural edit saves the shared payload (debounced), tab switching does not", async () => {
    remote.canEdit = true;
    remote.row = serverRowWithTab("Existing");
    const { result } = mount();
    await waitFor(() => expect(result.current.status).toBe("synced"));

    // Switching the active tab is a per-user preference: no server write.
    act(() => {
      result.current.setConfig((c) => setActiveTab(c, c.tabs[1]!.id));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 900));
    });
    expect(remote.saves).toHaveLength(0);

    // A structural change (new tab) saves once, with tabs but no activeTabId.
    act(() => {
      result.current.setConfig((c) => addTab(c, "Race Week"));
    });
    expect(hasLayoutSavePending(null)).toBe(true);
    await waitFor(() => expect(remote.saves).toHaveLength(1));
    const { stid, cfg } = remote.saves[0]!;
    expect(stid).toBeNull();
    const payload = cfg as { version: number; tabs: Array<{ name: string }>; activeTabId?: string };
    expect(payload.version).toBe(2);
    expect(payload.tabs.map((t) => t.name)).toContain("Race Week");
    expect(payload.activeTabId).toBeUndefined();
    await waitFor(() => expect(result.current.status).toBe("synced"));
    expect(hasLayoutSavePending(null)).toBe(false);
  });

  it("an edit right after adopting the server copy still saves (adopt is identity-scoped)", async () => {
    remote.canEdit = true;
    remote.row = serverRowWithTab("Existing");
    const { result } = mount();
    await waitFor(() => expect(result.current.status).toBe("synced"));

    act(() => {
      result.current.setConfig((c) => addTab(c, "Right After Adopt"));
    });
    await waitFor(() => expect(remote.saves).toHaveLength(1));
    const payload = remote.saves[0]!.cfg as { tabs: Array<{ name: string }> };
    expect(payload.tabs.map((t) => t.name)).toContain("Right After Adopt");
  });

  it("coalesces rapid edits into one save", async () => {
    remote.canEdit = true;
    remote.row = serverRowWithTab("Existing", true);
    const { result } = mount(AERO);
    await waitFor(() => expect(result.current.status).toBe("synced"));

    act(() => {
      result.current.setConfig((c) => addTab(c, "A"));
      result.current.setConfig((c) => addTab(c, "B"));
    });
    await waitFor(() => expect(remote.saves).toHaveLength(1));
    // Give the debounce window a chance to (wrongly) fire again.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 900));
    });
    expect(remote.saves).toHaveLength(1);
    const payload = remote.saves[0]!.cfg as { tabs: Array<{ name: string }> };
    expect(payload.tabs.map((t) => t.name)).toEqual(expect.arrayContaining(["A", "B"]));
    expect(remote.saves[0]!.stid).toBe("st1");
  });

  it("save failure → save_error with marker kept, retry re-sends, clears it, recovers", async () => {
    remote.canEdit = true;
    remote.row = serverRowWithTab("Existing");
    remote.saveError = true;
    const { result } = mount();
    await waitFor(() => expect(result.current.status).toBe("synced"));

    act(() => {
      result.current.setConfig((c) => addTab(c, "Fragile"));
    });
    await waitFor(() => expect(result.current.status).toBe("save_error"));
    expect(remote.saves).toHaveLength(1);
    // The marker survives the failed save — that's the crash-safety net.
    expect(hasLayoutSavePending(null)).toBe(true);

    remote.saveError = false;
    act(() => {
      result.current.retry();
    });
    await waitFor(() => expect(result.current.status).toBe("synced"));
    expect(remote.saves).toHaveLength(2);
    expect(hasLayoutSavePending(null)).toBe(false);
  });

  it("an edit made while the fetch is in flight is not clobbered by the server copy", async () => {
    remote.canEdit = true;
    let release!: () => void;
    remote.fetchGate = new Promise<void>((r) => (release = r));
    remote.row = serverRowWithTab("Server Copy");

    const { result } = mount();
    // Edit while the fetch is stalled behind the gate…
    act(() => {
      result.current.setConfig((c) => addTab(c, "Mine First"));
    });
    // …then let the server copy arrive.
    release();
    await waitFor(() => expect(remote.saves.length).toBeGreaterThan(0));
    // The local edit survived (server tabs did not replace it).
    expect(result.current.config.tabs.map((t) => t.name)).toContain("Mine First");
    expect(result.current.config.tabs.map((t) => t.name)).not.toContain("Server Copy");
  });
});

describe("pending-marker recovery (edit that never reached the server)", () => {
  it("an editor's marked cache wins over the server row and is re-published", async () => {
    // Previous session: edit cached locally, save never confirmed.
    rememberDashboardConfig(null, addTab(defaultDashboardConfig(false), "Recovered Edit"));
    markLayoutSavePending(null);
    remote.canEdit = true;
    remote.row = serverRowWithTab("Stale Server");

    const { result } = mount();
    await waitFor(() => expect(result.current.status).toBe("synced"));
    // The stale server copy was NOT adopted; the recovered layout was saved.
    expect(result.current.config.tabs.map((t) => t.name)).toContain("Recovered Edit");
    expect(result.current.config.tabs.map((t) => t.name)).not.toContain("Stale Server");
    expect(remote.saves).toHaveLength(1);
    const payload = remote.saves[0]!.cfg as { tabs: Array<{ name: string }> };
    expect(payload.tabs.map((t) => t.name)).toContain("Recovered Edit");
    expect(hasLayoutSavePending(null)).toBe(false);
  });

  it("a marker the user can no longer save (capability revoked) is abandoned for the server copy", async () => {
    rememberDashboardConfig(null, addTab(defaultDashboardConfig(false), "Orphan Edit"));
    markLayoutSavePending(null);
    remote.canEdit = false;
    remote.row = serverRowWithTab("Team Standard");

    const { result } = mount();
    await waitFor(() => expect(result.current.status).toBe("synced"));
    expect(result.current.config.tabs.map((t) => t.name)).toContain("Team Standard");
    expect(hasLayoutSavePending(null)).toBe(false);
    expect(remote.saves).toHaveLength(0);
  });
});

describe("scope change without a remount", () => {
  it("hard-resets to the new scope's cache and never writes across scopes", async () => {
    rememberDashboardConfig("aero", addTab(defaultDashboardConfig(true), "Aero Special"));
    rememberDashboardConfig(null, defaultDashboardConfig(false));
    remote.canEdit = true;
    remote.row = { data: null, error: null };

    const { result, rerender } = mount(AERO);
    await waitFor(() => expect(result.current.config.tabs.map((t) => t.name)).toContain("Aero Special"));

    rerender(PROJECT);
    // The project scope shows the project cache, not Aero's tabs.
    await waitFor(() => expect(result.current.config.tabs.map((t) => t.name)).not.toContain("Aero Special"));
    expect(result.current.config.tabs.map((t) => t.name)).toContain("Team Productivity");
    // Aero's cache was not overwritten with project tabs.
    expect(window.localStorage.getItem("helios:dashboard:aero")).toContain("Aero Special");
    // No save carried Aero's tabs into the project row (bootstrap publishes
    // per-scope local state only; nothing saved st1 tabs under stid null).
    for (const s of remote.saves) {
      const payload = s.cfg as { tabs: Array<{ name: string }> };
      if (s.stid === null) {
        expect(payload.tabs.map((t) => t.name)).not.toContain("Aero Special");
      }
    }
  });
});
