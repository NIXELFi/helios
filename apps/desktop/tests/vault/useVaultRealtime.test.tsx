import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import { useVaultRealtime } from "../../src/modules/vault/data/useVaultRealtime";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Build a fake Supabase client whose .channel() returns a chainable mock. The
 *  mock captures every .on() registration so tests can fire the corresponding
 *  table event by name and assert the right callback ran. */
function realtimeClient() {
  const handlers: Record<string, () => void> = {};
  let channelName = "";
  const channelNames: string[] = [];
  const subscribeMock = vi.fn();
  // Capture the status callback passed to .subscribe() so tests can drive
  // CHANNEL_ERROR / TIMED_OUT / SUBSCRIBED transitions.
  let statusCb: ((status: string, err?: unknown) => void) | undefined;
  const channelMock = {
    on: vi.fn(function (this: any, _event: string, filter: { table: string }, cb: () => void) {
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
    fireEvent: (table: string) => handlers[table]?.(),
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

describe("useVaultRealtime", () => {
  it("does not subscribe when vaultId is undefined", () => {
    const { client, channelMock } = realtimeClient();
    renderHook(() => useVaultRealtime(undefined, {}), { wrapper: wrap(client) });
    expect((client.channel as any).mock.calls.length).toBe(0);
    expect(channelMock.subscribe).not.toHaveBeenCalled();
  });

  it("subscribes once on mount with a `vault:<id>`-prefixed channel and the three table listeners", () => {
    const { client, fireEvent: _, getChannelName, channelMock, subscribeMock } = realtimeClient();
    const cb = { onVersion: vi.fn(), onLock: vi.fn(), onFile: vi.fn() };
    renderHook(() => useVaultRealtime("v1", cb), { wrapper: wrap(client) });
    // Name carries the vault id (so it's debuggable) plus a per-instance
    // suffix so concurrent subscribers don't collide on topic name.
    expect(getChannelName()).toMatch(/^vault:v1:/);
    expect(channelMock.on).toHaveBeenCalledTimes(3);
    expect(subscribeMock).toHaveBeenCalledTimes(1);
    // A status callback must be supplied (for logging + reconnect).
    expect(subscribeMock.mock.calls[0]![0]).toBeTypeOf("function");
  });

  it("gives each hook instance a unique channel name (no topic collision)", () => {
    const { client, getChannelNames } = realtimeClient();
    const cb = { onVersion: vi.fn() };
    // Two concurrent subscribers to the SAME vault must not share a topic name.
    renderHook(() => useVaultRealtime("v1", cb), { wrapper: wrap(client) });
    renderHook(() => useVaultRealtime("v1", cb), { wrapper: wrap(client) });
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
      renderHook(() => useVaultRealtime("v1", { onVersion: vi.fn() }), { wrapper: wrap(client) });
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
      renderHook(() => useVaultRealtime("v1", { onVersion: vi.fn() }), { wrapper: wrap(client) });
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
      renderHook(() => useVaultRealtime("v1", { onVersion: vi.fn() }), { wrapper: wrap(client) });
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
      const { unmount } = renderHook(
        () => useVaultRealtime("v1", { onVersion: vi.fn() }),
        { wrapper: wrap(client) },
      );
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

  it("invokes the correct callback when a postgres_changes event fires for that table", () => {
    const { client, fireEvent } = realtimeClient();
    const cb = { onVersion: vi.fn(), onLock: vi.fn(), onFile: vi.fn() };
    renderHook(() => useVaultRealtime("v1", cb), { wrapper: wrap(client) });

    fireEvent("versions");
    fireEvent("versions");
    fireEvent("locks");
    fireEvent("files");

    expect(cb.onVersion).toHaveBeenCalledTimes(2);
    expect(cb.onLock).toHaveBeenCalledTimes(1);
    expect(cb.onFile).toHaveBeenCalledTimes(1);
  });

  it("forwards the postgres_changes payload to the callback (for incremental apply)", () => {
    const { client, channelMock } = realtimeClient();
    const onFile = vi.fn();
    renderHook(() => useVaultRealtime("v1", { onFile }), { wrapper: wrap(client) });
    const payload = { eventType: "UPDATE", new: { id: "f1", deleted_at: "now" }, old: { id: "f1" } };
    const reg = (channelMock.on as any).mock.calls.find((c: any[]) => c[1].table === "files");
    reg[2](payload);
    expect(onFile).toHaveBeenCalledWith(payload);
  });

  it("calls the LATEST callback identity even when caller re-renders with a new inline arrow", () => {
    // Regression guard for the 2026-05-25 audit fix: the cb ref must be
    // updated inside an effect, not during render. The behavior we care
    // about is "use the freshest callback" — caller passing an inline
    // arrow shouldn't tear down the channel, but the callback fired by
    // realtime events should be the latest one.
    const { client, fireEvent, channelMock, subscribeMock } = realtimeClient();
    let count = 0;
    const fresh = vi.fn(() => { count++; });
    const stale = vi.fn();
    const { rerender } = renderHook(
      ({ cb }) => useVaultRealtime("v1", cb),
      { initialProps: { cb: { onVersion: stale } as any }, wrapper: wrap(client) },
    );
    rerender({ cb: { onVersion: fresh } });

    // No re-subscribe; channel was built once.
    expect(channelMock.on).toHaveBeenCalledTimes(3);
    expect(subscribeMock).toHaveBeenCalledTimes(1);

    fireEvent("versions");
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(stale).not.toHaveBeenCalled();
    expect(count).toBe(1);
  });

  it("re-subscribes when vaultId changes (tearing down the previous channel)", () => {
    const { client, getChannelName, channelMock } = realtimeClient();
    const cb = { onVersion: vi.fn() };
    const { rerender } = renderHook(
      ({ id }) => useVaultRealtime(id, cb),
      { initialProps: { id: "v1" as string | undefined }, wrapper: wrap(client) },
    );
    expect(getChannelName()).toMatch(/^vault:v1:/);
    expect((client.removeChannel as any).mock.calls.length).toBe(0);

    rerender({ id: "v2" });
    expect(getChannelName()).toMatch(/^vault:v2:/);
    expect((client.removeChannel as any).mock.calls.length).toBe(1);
    // .on was called 3 more times (3 for v1 + 3 for v2 = 6).
    expect(channelMock.on).toHaveBeenCalledTimes(6);
  });

  it("removes the channel on unmount", () => {
    const { client } = realtimeClient();
    const { unmount } = renderHook(
      () => useVaultRealtime("v1", { onVersion: vi.fn() }),
      { wrapper: wrap(client) },
    );
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
    expect(() =>
      renderHook(() => useVaultRealtime("v1", { onVersion: vi.fn() }), { wrapper: wrap(c) }),
    ).not.toThrow();
  });
});
