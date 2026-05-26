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
  const subscribeMock = vi.fn();
  const channelMock = {
    on: vi.fn(function (this: any, _event: string, filter: { table: string }, cb: () => void) {
      handlers[filter.table] = cb;
      return this;
    }),
    subscribe: vi.fn(function (this: any) {
      subscribeMock();
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
      return channelMock;
    }),
    removeChannel: vi.fn(),
  } as any as SupabaseClient;
  return {
    client,
    fireEvent: (table: string) => handlers[table]?.(),
    getChannelName: () => channelName,
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

  it("subscribes once on mount with channel `vault:<id>` and the three table listeners", () => {
    const { client, fireEvent: _, getChannelName, channelMock, subscribeMock } = realtimeClient();
    const cb = { onVersion: vi.fn(), onLock: vi.fn(), onFile: vi.fn() };
    renderHook(() => useVaultRealtime("v1", cb), { wrapper: wrap(client) });
    expect(getChannelName()).toBe("vault:v1");
    expect(channelMock.on).toHaveBeenCalledTimes(3);
    expect(subscribeMock).toHaveBeenCalledTimes(1);
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
    expect(getChannelName()).toBe("vault:v1");
    expect((client.removeChannel as any).mock.calls.length).toBe(0);

    rerender({ id: "v2" });
    expect(getChannelName()).toBe("vault:v2");
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
