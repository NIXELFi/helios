import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIN_TRACK_GAP_MS, SELF_HEAL_AFTER_MS, useHeliosPresence } from "../useHeliosPresence";
import type { ModuleId } from "../ModulePicker";

/** A stand-in Realtime channel: records track() calls and lets the test fire
 *  presence events the way realtime-js does. */
function fakeClient() {
  const handlers: Record<string, Array<(p?: unknown) => void>> = {};
  let state: Record<string, unknown[]> = {};
  let onStatus: (s: string) => void = () => {};
  const track = vi.fn((_meta: Record<string, unknown>) => Promise.resolve("ok"));
  const channel = {
    on: (_type: string, filter: { event: string }, cb: (p?: unknown) => void) => {
      (handlers[filter.event] ??= []).push(cb);
      return channel;
    },
    subscribe: (cb: (s: string) => void) => { onStatus = cb; return channel; },
    track,
    untrack: vi.fn(() => Promise.resolve("ok")),
    presenceState: () => state,
  };
  const client = { channel: () => channel, removeChannel: vi.fn() };
  return {
    client,
    track,
    setState: (s: Record<string, unknown[]>) => { state = s; },
    fire: (event: string) => { for (const cb of handlers[event] ?? []) cb({}); },
    status: (s: string) => onStatus(s),
  };
}

const ME = "me-0000";
const others = (n: number) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`u${i}`, [{ user_id: `u${i}`, name: `User ${i}`, module: "pm", online_at: 1 }]]));

function mount(f: ReturnType<typeof fakeClient>, module: ModuleId = "pm") {
  return renderHook((p: { module: ModuleId }) => useHeliosPresence({
    client: f.client as never, userId: ME, name: "Me", subteam: null, module: p.module,
  }), { initialProps: { module } });
}

describe("useHeliosPresence track rate", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
  afterEach(() => { vi.useRealTimers(); });

  it("tracks once on connect even when ~70 people are already online", async () => {
    const f = fakeClient();
    mount(f);
    await act(async () => { f.status("SUBSCRIBED"); });
    // Phoenix replays a join per existing key, then one sync, all before our
    // own entry has echoed back.
    f.setState(others(70));
    await act(async () => {
      for (let i = 0; i < 70; i++) f.fire("join");
      f.fire("sync");
    });
    expect(f.track).toHaveBeenCalledTimes(1);
  });

  it("re-announces when our entry is still missing after the self-heal window", async () => {
    const f = fakeClient();
    mount(f);
    await act(async () => { f.status("SUBSCRIBED"); });
    f.setState(others(5));
    await act(async () => { f.fire("sync"); });
    expect(f.track).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(SELF_HEAL_AFTER_MS); f.fire("sync"); });
    expect(f.track).toHaveBeenCalledTimes(2);
    // Present now: further syncs send nothing.
    f.setState({ ...others(5), [ME]: [{ user_id: ME }] });
    await act(async () => { vi.advanceTimersByTime(SELF_HEAL_AFTER_MS); f.fire("sync"); });
    expect(f.track).toHaveBeenCalledTimes(2);
  });

  it("coalesces rapid module switches into one trailing track with the last module", async () => {
    const f = fakeClient();
    const h = mount(f);
    await act(async () => { f.status("SUBSCRIBED"); });
    expect(f.track).toHaveBeenCalledTimes(1);
    for (const m of ["vault", "agora", "games", "logs", "org"] as ModuleId[]) {
      await act(async () => { h.rerender({ module: m }); });
    }
    expect(f.track).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(MIN_TRACK_GAP_MS); });
    expect(f.track).toHaveBeenCalledTimes(2);
    expect(f.track.mock.calls[1]![0]).toMatchObject({ module: "org" });
  });
});
