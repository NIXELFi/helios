import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
// One stable client, like the real provider: a fresh object per render would
// re-run the fetch effect forever.
const client = { schema: () => ({ rpc: (...a: unknown[]) => rpc(...a) }) };
vi.mock("@helios/auth", () => ({ useSupabaseClient: () => client }));

import { groupMyPlugins, useMyPlugins, type MyVersionRow } from "../useMyPlugins";

const row = (version: string, status: string, publishedAt: string, over = {}): MyVersionRow =>
  ({
  plugin_id: "aero.tool",
  name: "Aero Tool",
  subteam: "s1",
  is_recommended: false,
  latest_version: "1.0.0",
  version,
  manifest: {},
  permissions: [],
  review_status: status,
  review_notes: null,
  reviewed_at: null,
  bundle_bytes: 100,
  published_by: "u1",
  published_at: publishedAt,
  ...over,
  }) as unknown as MyVersionRow;

beforeEach(() => {
  rpc.mockReset();
  rpc.mockImplementation((fn: string) =>
    Promise.resolve(
      fn === "my_published_plugins"
        ? { data: [row("1.0.0", "approved", "2026-09-01"), row("1.1.0", "pending", "2026-09-10")], error: null }
        : { data: [], error: null },
    ),
  );
});

describe("groupMyPlugins", () => {
  it("groups versions under their plugin, newest first", () => {
    const g = groupMyPlugins([
      row("1.0.0", "approved", "2026-09-01"),
      row("1.1.0", "pending", "2026-09-10"),
      row("0.1.0", "approved", "2026-08-01", { plugin_id: "a.first", name: "A First" }),
    ]);
    expect(g.map((p) => p.id)).toEqual(["a.first", "aero.tool"]);
    expect(g[1]!.versions.map((v) => v.version)).toEqual(["1.1.0", "1.0.0"]);
  });
});

describe("useMyPlugins", () => {
  it("withdraws a pending version and refetches", async () => {
    const { result } = renderHook(() => useMyPlugins());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.withdraw("aero.tool", "1.1.0");
    });
    expect(rpc).toHaveBeenCalledWith("withdraw_plugin_version", { p_plugin_id: "aero.tool", p_version: "1.1.0" });
    await waitFor(() =>
      expect(rpc.mock.calls.filter(([fn]) => fn === "my_published_plugins").length).toBe(2),
    );
  });

  it("yanks with a trimmed reason, or null when blank", async () => {
    const { result } = renderHook(() => useMyPlugins());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.yank("aero.tool", "1.0.0", "  broken  ");
      await result.current.yank("aero.tool", "1.0.0", "   ");
    });
    expect(rpc).toHaveBeenCalledWith("yank_plugin_version", { p_plugin_id: "aero.tool", p_version: "1.0.0", p_reason: "broken" });
    expect(rpc).toHaveBeenCalledWith("yank_plugin_version", { p_plugin_id: "aero.tool", p_version: "1.0.0", p_reason: null });
  });

  it("toggles recommended optimistically and rolls back on error", async () => {
    const { result } = renderHook(() => useMyPlugins());
    await waitFor(() => expect(result.current.loading).toBe(false));
    rpc.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === "set_plugin_recommended"
          ? { data: null, error: { message: "only a lead or VP for this subteam can change whether aero.tool is recommended" } }
          : { data: [row("1.0.0", "approved", "2026-09-01")], error: null },
      ),
    );
    let caught: unknown = null;
    await act(async () => {
      await result.current.setRecommended("aero.tool", true).catch((e) => (caught = e));
    });
    expect(caught).toBeTruthy();
    expect(result.current.plugins[0]!.isRecommended).toBe(false);
    expect(result.current.actionError).toMatch(/only a lead or VP/);
  });
});
