import { describe, expect, it, vi } from "vitest";

// App.tsx transitively imports @helios/widgets → maplibre-gl, which calls
// URL.createObjectURL at import time. tests/setup.ts stubs that globally, so
// importing App's PURE helpers below collects cleanly. We only exercise pure
// functions here — no widget ever renders.

import {
  mergeSessionsWithColors,
  computeOverrideChange,
  computeMathChannelsUpdate,
} from "../src/App";
import type { LoadedSession } from "../src/lib/session";
import { applySessionMeta, colorForIndex } from "../src/lib/session";
import type { SessionMeta } from "../src/lib/app-state";
import type { MathChannel } from "../src/lib/math-channels";

/** Minimal ChannelStore stub recording the override/math calls the handlers
 *  make against it, so we can assert the store is mutated exactly once and
 *  with the right arguments — without standing up a real ChannelStore + CSV. */
function fakeStore() {
  return {
    setChannelOverride: vi.fn(),
    clearChannelOverride: vi.fn(),
    removeChannel: vi.fn(),
  };
}

function session(id: string, overrides: Record<string, string> = {}): LoadedSession {
  return {
    id,
    label: id,
    // Only the methods the handlers touch are exercised; cast through unknown.
    store: fakeStore() as unknown as LoadedSession["store"],
    color: "#000000",
    visible: true,
    lapConfig: { mode: "none" } as LoadedSession["lapConfig"],
    laps: null,
    channelOverrides: overrides,
  };
}

describe("mergeSessionsWithColors — COLOR-DESYNC", () => {
  it("appends a genuinely new session and colors it by its final array position", () => {
    const prev = [session("a"), session("b")]; // positions 0,1
    const incoming = [session("c")];
    const next = mergeSessionsWithColors(prev, incoming);
    expect(next.map((s) => s.id)).toEqual(["a", "b", "c"]);
    // Every session's color is derived from its FINAL position.
    expect(next[0]!.color).toBe(colorForIndex(0));
    expect(next[1]!.color).toBe(colorForIndex(1));
    expect(next[2]!.color).toBe(colorForIndex(2));
  });

  it("re-loading an existing id REPLACES in place and keeps that position's color (no skew)", () => {
    // Three sessions; re-load the middle one. The array must NOT grow, and the
    // re-loaded session must keep position 1's color — the regression was that
    // a per-file nextIndex advanced past the array length, so the reloaded
    // session got colorForIndex(3) (== colorForIndex(0) wrap) instead of (1).
    const prev = [session("a"), session("b"), session("c")];
    const incoming = [session("b")]; // re-load b
    const next = mergeSessionsWithColors(prev, incoming);
    expect(next.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(next[1]!.id).toBe("b");
    expect(next[1]!.color).toBe(colorForIndex(1));
    // No duplicate colors across the overlaid set.
    const colors = next.map((s) => s.color);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it("a multi-file drop mixing one replace + one new colors both by final position", () => {
    const prev = [session("a"), session("b")]; // 0,1
    const incoming = [session("b"), session("d")]; // replace b, add d
    const next = mergeSessionsWithColors(prev, incoming);
    expect(next.map((s) => s.id)).toEqual(["a", "b", "d"]);
    expect(next[0]!.color).toBe(colorForIndex(0));
    expect(next[1]!.color).toBe(colorForIndex(1));
    expect(next[2]!.color).toBe(colorForIndex(2));
    const colors = next.map((s) => s.color);
    expect(new Set(colors).size).toBe(colors.length);
  });
});

describe("mergeSessionsWithColors + applySessionMeta — the commit path App uses", () => {
  const lookup = (map: Record<string, SessionMeta>) =>
    (id: string): SessionMeta | null => map[id] ?? null;

  it("lets a pinned color win over the positional one the merge just assigned", () => {
    const prev = [session("a"), session("b")];
    const incoming = [session("c")];
    const next = applySessionMeta(
      mergeSessionsWithColors(prev, incoming),
      lookup({ a: { color: "#EF5350" } }),
    );
    expect(next[0]!.color).toBe("#EF5350");
    // Positional assignment still flows for everyone without an override.
    expect(next[1]!.color).toBe(colorForIndex(1));
    expect(next[2]!.color).toBe(colorForIndex(2));
  });

  it("keeps a session hidden across a merge, so it can't be picked as primary", () => {
    const next = applySessionMeta(
      mergeSessionsWithColors([session("a"), session("b")], [session("c")]),
      lookup({ a: { visible: false } }),
    );
    expect(next.map((s) => s.visible)).toEqual([false, true, true]);
    // App picks the first VISIBLE session as primary on both boot and add.
    expect(next.find((s) => s.visible)!.id).toBe("b");
  });

  it("applies a custom label without disturbing the merge's dedup/order", () => {
    const next = applySessionMeta(
      mergeSessionsWithColors([session("a"), session("b")], [session("b")]),
      lookup({ b: { label: "Kaden" } }),
    );
    expect(next.map((s) => s.id)).toEqual(["a", "b"]);
    expect(next[1]!.label).toBe("Kaden");
    expect(next[1]!.defaultLabel).toBe("b");
  });
});

describe("computeOverrideChange — IMPURE-UPDATERS (pure compute)", () => {
  it("sets an override: returns next sessions + the map to persist, mutates only the target store once", () => {
    const a = session("a");
    const b = session("b");
    const { next, saved } = computeOverrideChange([a, b], "b", "engine.rpm", "RPM");
    // saved is the overrides map to persist for session b.
    expect(saved).toEqual({ "engine.rpm": "RPM" });
    // next is a new array; b's channelOverrides reflects the new binding.
    expect(next).not.toBe(undefined);
    const nb = next!.find((s) => s.id === "b")!;
    expect(nb.channelOverrides).toEqual({ "engine.rpm": "RPM" });
    expect(nb).not.toBe(b); // new object, immutable update
    // Store mutated exactly once on the target, never on the other session.
    expect((b.store.setChannelOverride as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((b.store.setChannelOverride as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("engine.rpm", "RPM");
    expect((a.store.setChannelOverride as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    // The original 'a' object is untouched (referential stability for unchanged rows).
    expect(next!.find((s) => s.id === "a")).toBe(a);
  });

  it("clearing an override (null header) deletes the key and calls clearChannelOverride", () => {
    const b = session("b", { "engine.rpm": "RPM" });
    const { next, saved } = computeOverrideChange([b], "b", "engine.rpm", null);
    expect(saved).toEqual({});
    expect(next!.find((s) => s.id === "b")!.channelOverrides).toEqual({});
    expect((b.store.clearChannelOverride as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("engine.rpm");
    expect((b.store.setChannelOverride as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

describe("computeMathChannelsUpdate — IMPURE-UPDATERS (pure compute)", () => {
  const mc = (id: string): MathChannel => ({
    id, display_name: id, units: "", decimals: 2, color: "#FFC627",
    group: "Math", expression: "1 + 1",
  });

  it("removes the union of old+new ids from each store, then returns a per-session errors map", () => {
    const a = session("a");
    const b = session("b");
    const oldChannels = [mc("old1")];
    const nextChannels = [mc("new1")];
    const { errors } = computeMathChannelsUpdate([a, b], oldChannels, nextChannels);
    // An errors entry exists for every session.
    expect(errors.has("a")).toBe(true);
    expect(errors.has("b")).toBe(true);
    // Both the old and the new id were removed from each store before re-apply,
    // so a renamed/deleted math channel can't leave a stale column behind.
    const removedFromA = (a.store.removeChannel as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(removedFromA).toContain("old1");
    expect(removedFromA).toContain("new1");
  });
});
