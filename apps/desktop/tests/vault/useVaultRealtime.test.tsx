import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import {
  useVaultRealtime,
  useVaultRealtimeFeed,
} from "../../src/modules/vault/data/useVaultRealtime";
import {
  publishVaultEvent,
  subscribeVaultEvents,
  vaultEventSubscriberCount,
} from "../../src/modules/vault/data/vault-events";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Build a fake Supabase client whose .channel() returns a chainable mock. The
 *  mock captures every .on() registration so tests can fire the corresponding
 *  table event by name and assert the right callback ran. */
function realtimeClient() {
  const handlers: Record<string, (payload?: unknown) => void> = {};
  let channelName = "";
  const channelNames: string[] = [];
  const subscribeMock = vi.fn();
  // Capture the status callback passed to .subscribe() so tests can drive
  // CHANNEL_ERROR / TIMED_OUT / SUBSCRIBED transitions.
  let statusCb: ((status: string, err?: unknown) => void) | undefined;
  const channelMock = {
    on: vi.fn(function (this: any, _event: string, filter: { table: string }, cb: (p?: unknown) => void) {
      handlers[filter.table] = cb;
      return this;
    }),
    subscribe: vi.fn(function (this: any, cb?: (status: string, err?: unknown) => void) {
      statusCb = cb;
      subscribeMock(cb);
      return this;
    }),
  };
  const client = {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    channel: vi.fn((name: string) => {
      channelName = name;
      channelNames.push(name);
      return channelMock;
    }),
    removeChannel: vi.fn(),
  } as any as SupabaseClient;
  return {
    client,
    fireEvent: (table: string, payload?: unknown) => handlers[table]?.(payload),
    getChannelName: () => channelName,
    getChannelNames: () => channelNames,
    fireStatus: (status: string, err?: unknown) => statusCb?.(status, err),
    channelMock,
    subscribeMock,
  };
}

const wrap = (c: SupabaseClient) =>
  ({ children }: { children: ReactNode }) =>
    <SupabaseAuthProvider client={c}>{children}</SupabaseAuthProvider>;

describe("useVaultRealtimeFeed", () => {
  it("does not subscribe when vaultId is undefined", () => {
    const { client, channelMock } = realtimeClient();
    renderHook(() => useVaultRealtimeFeed(undefined), { wrapper: wrap(client) });
    expect((client.channel as any).mock.calls.length).toBe(0);
    expect(channelMock.subscribe).not.toHaveBeenCalled();
  });

  it("subscribes once on mount with a `vault:<id>`-prefixed channel and the four table listeners", () => {
    const { client, getChannelName, channelMock, subscribeMock } = realtimeClient();
    renderHook(() => useVaultRealtimeFeed("v1"), { wrapper: wrap(client) });
    // Name carries the vault id (so it's debuggable) plus a per-instance
    // suffix so concurrent subscribers don't collide on topic name.
    expect(getChannelName()).toMatch(/^vault:v1:/);
    expect(channelMock.on).toHaveBeenCalledTimes(4); // versions, locks, files, folders
    expect(subscribeMock).toHaveBeenCalledTimes(1);
    // A status callback must be supplied (for logging + reconnect).
    expect(subscribeMock.mock.calls[0]![0]).toBeTypeOf("function");
  });

  it("gives each feed instance a unique channel name (no topic collision)", () => {
    const { client, getChannelNames } = realtimeClient();
    renderHook(() => useVaultRealtimeFeed("v1"), { wrapper: wrap(client) });
    renderHook(() => useVaultRealtimeFeed("v1"), { wrapper: wrap(client) });
    const names = getChannelNames();
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^vault:v1:/);
    expect(names[1]).toMatch(/^vault:v1:/);
    expect(names[0]).not.toBe(names[1]);
  });

  it("re-subscribes on CHANNEL_ERROR with backoff (removes old channel, builds a new one)", () => {
    vi.useFakeTimers();
    try {
      const { client, fireStatus, subscribeMock } = realtimeClient();
      renderHook(() => useVaultRealtimeFeed("v1"), { wrapper: wrap(client) });
      expect(subscribeMock).toHaveBeenCalledTimes(1);
      expect((client.channel as any).mock.calls.length).toBe(1);
      expect((client.removeChannel as any).mock.calls.length).toBe(0);

      // Realtime drops the channel — fire the error status.
      fireStatus("CHANNEL_ERROR");
      // Backoff hasn't elapsed yet: no new channel.
      expect((client.channel as any).mock.calls.length).toBe(1);

      // After the backoff delay, the hook tears down the dead channel and
      // builds a fresh subscription.
      vi.advanceTimersByTime(5000);
      expect((client.removeChannel as any).mock.calls.length).toBeGreaterThanOrEqual(1);
      expect((client.channel as any).mock.calls.length).toBe(2);
      expect(subscribeMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-subscribes on TIMED_OUT", () => {
    vi.useFakeTimers();
    try {
      const { client, fireStatus, subscribeMock } = realtimeClient();
      renderHook(() => useVaultRealtimeFeed("v1"), { wrapper: wrap(client) });
      fireStatus("TIMED_OUT");
      vi.advanceTimersByTime(5000);
      expect(subscribeMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not re-subscribe on SUBSCRIBED (steady state)", () => {
    vi.useFakeTimers();
    try {
      const { client, fireStatus, subscribeMock } = realtimeClient();
      renderHook(() => useVaultRealtimeFeed("v1"), { wrapper: wrap(client) });
      fireStatus("SUBSCRIBED");
      vi.advanceTimersByTime(10000);
      expect(subscribeMock).toHaveBeenCalledTimes(1);
      expect((client.channel as any).mock.calls.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not schedule a reconnect after unmount (no leaked timer / channel)", () => {
    vi.useFakeTimers();
    try {
      const { client, fireStatus, subscribeMock } = realtimeClient();
      const { unmount } = renderHook(() => useVaultRealtimeFeed("v1"), { wrapper: wrap(client) });
      // Error fires, then we unmount before the backoff elapses.
      fireStatus("CHANNEL_ERROR");
      unmount();
      vi.advanceTimersByTime(10000);
      // No second subscribe — the reconnect timer was cleared on unmount.
      expect(subscribeMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes every table's payload onto the vault-events bus", () => {
    const { client, fireEvent } = realtimeClient();
    renderHook(() => useVaultRealtimeFeed("vbus"), { wrapper: wrap(client) });
    const seen: Array<[string, unknown]> = [];
    const off = subscribeVaultEvents("vbus", (table, payload) => seen.push([table, payload]));
    const p = { eventType: "UPDATE", new: { id: "f1" }, old: { id: "f1" } };
    fireEvent("versions", p);
    fireEvent("locks", p);
    fireEvent("files", p);
    fireEvent("folders", p);
    off();
    expect(seen.map(([t]) => t)).toEqual(["versions", "locks", "files", "folders"]);
    expect(seen[2]![1]).toBe(p);
  });

  it("re-subscribes when vaultId changes (tearing down the previous channel)", () => {
    const { client, getChannelName, channelMock } = realtimeClient();
    const { rerender } = renderHook(
      ({ id }) => useVaultRealtimeFeed(id),
      { initialProps: { id: "v1" as string | undefined }, wrapper: wrap(client) },
    );
    expect(getChannelName()).toMatch(/^vault:v1:/);
    expect((client.removeChannel as any).mock.calls.length).toBe(0);

    rerender({ id: "v2" });
    expect(getChannelName()).toMatch(/^vault:v2:/);
    expect((client.removeChannel as any).mock.calls.length).toBe(1);
    // .on was called 4 more times (4 for v1 + 4 for v2 = 8).
    expect(channelMock.on).toHaveBeenCalledTimes(8);
  });

  it("removes the channel on unmount", () => {
    const { client } = realtimeClient();
    const { unmount } = renderHook(() => useVaultRealtimeFeed("v1"), { wrapper: wrap(client) });
    expect((client.removeChannel as any).mock.calls.length).toBe(0);
    unmount();
    expect((client.removeChannel as any).mock.calls.length).toBe(1);
  });

  it("is a quiet no-op when the supabase client mock omits .channel (test environments)", () => {
    // Some test mocks construct a barebones client without realtime. The
    // hook should bail silently rather than throw.
    const c = {
      auth: {
        getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      },
      // no .channel function
    } as any as SupabaseClient;
    expect(() => renderHook(() => useVaultRealtimeFeed("v1"), { wrapper: wrap(c) })).not.toThrow();
  });
});

describe("useVaultRealtime (bus subscriber)", () => {
  it("opens NO channel of its own — the feed owns the only one per vault", () => {
    const { client } = realtimeClient();
    renderHook(() => useVaultRealtime("v1", { onVersion: vi.fn() }), { wrapper: wrap(client) });
    expect((client.channel as any).mock.calls.length).toBe(0);
  });

  it("invokes the correct callback for each table published on the bus", () => {
    const { client } = realtimeClient();
    const cb = { onVersion: vi.fn(), onLock: vi.fn(), onFile: vi.fn(), onFolder: vi.fn() };
    renderHook(() => useVaultRealtime("vsub1", cb), { wrapper: wrap(client) });

    publishVaultEvent("vsub1", "versions", {});
    publishVaultEvent("vsub1", "versions", {});
    publishVaultEvent("vsub1", "locks", {});
    publishVaultEvent("vsub1", "files", {});
    publishVaultEvent("vsub1", "folders", {});

    expect(cb.onVersion).toHaveBeenCalledTimes(2);
    expect(cb.onLock).toHaveBeenCalledTimes(1);
    expect(cb.onFile).toHaveBeenCalledTimes(1);
    expect(cb.onFolder).toHaveBeenCalledTimes(1);
  });

  it("forwards the payload to the callback (for incremental apply)", () => {
    const { client } = realtimeClient();
    const onFile = vi.fn();
    renderHook(() => useVaultRealtime("vsub2", { onFile }), { wrapper: wrap(client) });
    const payload = { eventType: "UPDATE", new: { id: "f1", deleted_at: "now" }, old: { id: "f1" } };
    publishVaultEvent("vsub2", "files", payload);
    expect(onFile).toHaveBeenCalledWith(payload);
  });

  it("calls the LATEST callback identity even when caller re-renders with a new inline arrow", () => {
    // Regression guard for the 2026-05-25 audit fix: the cb ref must be
    // updated inside an effect, not during render.
    const { client } = realtimeClient();
    const fresh = vi.fn();
    const stale = vi.fn();
    const { rerender } = renderHook(
      ({ cb }) => useVaultRealtime("vsub3", cb),
      { initialProps: { cb: { onVersion: stale } as any }, wrapper: wrap(client) },
    );
    rerender({ cb: { onVersion: fresh } });
    // Re-render must not have churned the bus subscription.
    expect(vaultEventSubscriberCount("vsub3")).toBe(1);

    publishVaultEvent("vsub3", "versions", {});
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(stale).not.toHaveBeenCalled();
  });

  it("moves its subscription when vaultId changes, and drops it on unmount", () => {
    const { client } = realtimeClient();
    const { rerender, unmount } = renderHook(
      ({ id }) => useVaultRealtime(id, { onVersion: vi.fn() }),
      { initialProps: { id: "vsub4" as string | undefined }, wrapper: wrap(client) },
    );
    expect(vaultEventSubscriberCount("vsub4")).toBe(1);
    rerender({ id: "vsub5" });
    expect(vaultEventSubscriberCount("vsub4")).toBe(0);
    expect(vaultEventSubscriberCount("vsub5")).toBe(1);
    unmount();
    expect(vaultEventSubscriberCount("vsub5")).toBe(0);
  });
});
