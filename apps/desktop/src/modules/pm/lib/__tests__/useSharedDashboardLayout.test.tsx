/**
 * Shared dashboard layout hook: server-adopt, offline fallback, capability
 * gating, and the debounced save (structural changes only — switching the
 * active tab must never write the shared layout).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  addTab,
  defaultDashboardConfig,
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

function mount(subteamId: string | null = null) {
  return renderHook(() =>
    useSharedDashboardLayout({ subteamId, teamSlug: subteamId ? "aero" : null, isSubteamScope: subteamId !== null }),
  );
}

beforeEach(() => {
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
  it("adopts server tabs (status synced) and caches them locally", async () => {
    const shared = addTab(defaultDashboardConfig(false), "Leads Only");
    remote.row = { data: { config: sharedDashboardPayload(shared) }, error: null };

    const { result } = mount();
    await waitFor(() => expect(result.current.status).toBe("synced"));
    expect(result.current.config.tabs.map((t) => t.name)).toContain("Leads Only");
    // Cache updated: a fresh recall (new mount, server now silent) shows it too.
    expect(window.localStorage.getItem("helios:dashboard:__project__")).toContain("Leads Only");
  });

  it("no shared row → status none, local default kept", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.status).toBe("none"));
    expect(result.current.config.tabs).toHaveLength(3);
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

describe("saving", () => {
  it("a structural edit saves the shared payload (debounced), tab switching does not", async () => {
    remote.canEdit = true;
    const { result } = mount();
    await waitFor(() => expect(result.current.status).toBe("none"));

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
    await waitFor(() => expect(remote.saves).toHaveLength(1));
    const { stid, cfg } = remote.saves[0]!;
    expect(stid).toBeNull();
    const payload = cfg as { version: number; tabs: Array<{ name: string }>; activeTabId?: string };
    expect(payload.version).toBe(2);
    expect(payload.tabs.map((t) => t.name)).toContain("Race Week");
    expect(payload.activeTabId).toBeUndefined();
    await waitFor(() => expect(result.current.status).toBe("synced"));
  });

  it("coalesces rapid edits into one save", async () => {
    remote.canEdit = true;
    const { result } = mount("st1");
    await waitFor(() => expect(result.current.status).toBe("none"));

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

  it("save failure → save_error, retry re-sends and recovers", async () => {
    remote.canEdit = true;
    remote.saveError = true;
    const { result } = mount();
    await waitFor(() => expect(result.current.status).toBe("none"));

    act(() => {
      result.current.setConfig((c) => addTab(c, "Fragile"));
    });
    await waitFor(() => expect(result.current.status).toBe("save_error"));
    expect(remote.saves).toHaveLength(1);

    remote.saveError = false;
    act(() => {
      result.current.retry();
    });
    await waitFor(() => expect(result.current.status).toBe("synced"));
    expect(remote.saves).toHaveLength(2);
  });

  it("an edit made while the fetch is in flight is not clobbered by the server copy", async () => {
    remote.canEdit = true;
    let release!: () => void;
    remote.fetchGate = new Promise<void>((r) => (release = r));
    remote.row = { data: { config: sharedDashboardPayload(defaultDashboardConfig(false)) }, error: null };

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
  });
});
