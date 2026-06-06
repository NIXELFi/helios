import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@helios/auth";
import { subscribePmRealtime, PM_REALTIME_TABLES } from "../pm-realtime";

/** Fake client whose .channel() returns a chainable mock capturing every .on()
 *  registration (so a test can fire a table's event) and the .subscribe() status
 *  callback (to drive reconnect transitions). Mirrors the useVaultRealtime test. */
function realtimeClient() {
  const handlers: Record<string, () => void> = {};
  const channelNames: string[] = [];
  const subscribeMock = vi.fn();
  let statusCb: ((status: string, err?: unknown) => void) | undefined;
  const channelMock = {
    on: vi.fn(function (this: unknown, _e: string, filter: { table: string; schema: string }, cb: () => void) {
      handlers[`${filter.schema}.${filter.table}`] = cb;
      return channelMock;
    }),
    subscribe: vi.fn(function (this: unknown, cb?: (status: string, err?: unknown) => void) {
      statusCb = cb;
      subscribeMock(cb);
      return channelMock;
    }),
  };
  const client = {
    channel: vi.fn((name: string) => {
      channelNames.push(name);
      return channelMock;
    }),
    removeChannel: vi.fn(),
  } as unknown as SupabaseClient;
  return {
    client,
    channelMock,
    subscribeMock,
    channelNames,
    fire: (table: string) => handlers[`pm.${table}`]?.(),
    fireStatus: (s: string, e?: unknown) => statusCb?.(s, e),
    removeChannel: client.removeChannel as unknown as ReturnType<typeof vi.fn>,
  };
}

describe("subscribePmRealtime", () => {
  it("subscribes to every published pm table on a pm:realtime channel", () => {
    const h = realtimeClient();
    subscribePmRealtime(h.client, vi.fn());
    expect(h.channelNames[0]).toMatch(/^pm:realtime:/);
    expect(h.channelMock.on).toHaveBeenCalledTimes(PM_REALTIME_TABLES.length);
    expect(h.subscribeMock).toHaveBeenCalledTimes(1);
    // tasks is the most important one — make sure it's covered.
    expect(PM_REALTIME_TABLES).toContain("tasks");
  });

  it("calls onEvent when any subscribed table fires", () => {
    const h = realtimeClient();
    const onEvent = vi.fn();
    subscribePmRealtime(h.client, onEvent);
    h.fire("tasks");
    h.fire("milestones");
    h.fire("task_comments");
    expect(onEvent).toHaveBeenCalledTimes(3);
  });

  it("removes the channel on teardown", () => {
    const h = realtimeClient();
    const stop = subscribePmRealtime(h.client, vi.fn());
    expect(h.removeChannel).not.toHaveBeenCalled();
    stop();
    expect(h.removeChannel).toHaveBeenCalledTimes(1);
  });

  it("gives each subscription a distinct channel name", () => {
    const h = realtimeClient();
    subscribePmRealtime(h.client, vi.fn());
    subscribePmRealtime(h.client, vi.fn());
    expect(h.channelNames).toHaveLength(2);
    expect(h.channelNames[0]).not.toBe(h.channelNames[1]);
  });

  it("reconnects with backoff on CHANNEL_ERROR (rebuilds the channel)", () => {
    vi.useFakeTimers();
    try {
      const h = realtimeClient();
      subscribePmRealtime(h.client, vi.fn());
      expect(h.subscribeMock).toHaveBeenCalledTimes(1);
      h.fireStatus("CHANNEL_ERROR");
      expect((h.client.channel as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
      vi.advanceTimersByTime(5000);
      expect((h.client.channel as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
      expect(h.subscribeMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reconnect after teardown (no leaked timer)", () => {
    vi.useFakeTimers();
    try {
      const h = realtimeClient();
      const stop = subscribePmRealtime(h.client, vi.fn());
      h.fireStatus("CHANNEL_ERROR");
      stop();
      vi.advanceTimersByTime(10000);
      expect(h.subscribeMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a quiet no-op when the client has no realtime (test stubs)", () => {
    const c = {} as unknown as SupabaseClient;
    expect(() => {
      const stop = subscribePmRealtime(c, vi.fn());
      stop();
    }).not.toThrow();
  });
});
