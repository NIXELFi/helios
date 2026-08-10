/** Unit tests for applySessionMeta — the pure post-pass that lays the user's
 *  saved per-session overrides (label / color / visibility) over a loaded
 *  session list.
 *
 *  The lookup is injected in every test, so none of these touch localStorage:
 *  what's under test is the merge rule, not the persistence.
 */

import { describe, it, expect } from "vitest";
import { ChannelStore } from "@helios/store";
import type { SessionMeta } from "../app-state";
import type { LoadedSession } from "../session";
import { SESSION_PALETTE, applySessionMeta, colorForIndex } from "../session";

function ses(id: string, label: string, overrides: Partial<LoadedSession> = {}): LoadedSession {
  return {
    id,
    label,
    store: new ChannelStore(),
    color: colorForIndex(0),
    visible: true,
    lapConfig: { mode: "none" },
    laps: null,
    channelOverrides: {},
    ...overrides,
  };
}

function lookup(map: Record<string, SessionMeta>) {
  return (id: string): SessionMeta | null => map[id] ?? null;
}

describe("applySessionMeta — no saved overrides", () => {
  it("keeps loader labels, assigns positional colors and stamps defaultLabel", () => {
    const out = applySessionMeta(
      [ses("a", "run-1"), ses("b", "run-2"), ses("c", "run-3")],
      lookup({}),
    );
    expect(out.map((s) => s.label)).toEqual(["run-1", "run-2", "run-3"]);
    expect(out.map((s) => s.color)).toEqual([
      colorForIndex(0), colorForIndex(1), colorForIndex(2),
    ]);
    // defaultLabel is what makes a later "clear the rename" recoverable.
    expect(out.map((s) => s.defaultLabel)).toEqual(["run-1", "run-2", "run-3"]);
  });

  it("ignores meta for ids that are not loaded", () => {
    const out = applySessionMeta(
      [ses("a", "run-1")],
      lookup({ ghost: { label: "Kaden", color: "#EF5350", visible: false } }),
    );
    expect(out[0]!.label).toBe("run-1");
    expect(out[0]!.color).toBe(colorForIndex(0));
    expect(out[0]!.visible).toBe(true);
  });

  it("leaves the loader's visibility choice alone when nothing is saved", () => {
    // Bundled samples load with only the first visible (overlay is opt-in);
    // an absent saved flag must not force them all on.
    const out = applySessionMeta(
      [ses("a", "sample-1"), ses("b", "sample-2", { visible: false })],
      lookup({}),
    );
    expect(out.map((s) => s.visible)).toEqual([true, false]);
  });
});

describe("applySessionMeta — labels", () => {
  it("applies a custom label and preserves the original in defaultLabel", () => {
    const out = applySessionMeta(
      [ses("a", "2026-07-31-endurance")],
      lookup({ a: { label: "Kaden — endurance" } }),
    );
    expect(out[0]!.label).toBe("Kaden — endurance");
    expect(out[0]!.defaultLabel).toBe("2026-07-31-endurance");
  });

  it("restores the filename-derived label once the override is cleared", () => {
    const renamed = applySessionMeta([ses("a", "run-1")], lookup({ a: { label: "Kaden" } }));
    expect(renamed[0]!.label).toBe("Kaden");
    // Re-applying with the override gone must recover the original, which is
    // only possible because defaultLabel survived the first pass.
    const cleared = applySessionMeta(renamed, lookup({}));
    expect(cleared[0]!.label).toBe("run-1");
    expect(cleared[0]!.defaultLabel).toBe("run-1");
  });

  it("ignores an empty or whitespace-only saved label instead of blanking the row", () => {
    const out = applySessionMeta(
      [ses("a", "run-1"), ses("b", "run-2")],
      lookup({ a: { label: "" }, b: { label: "   " } }),
    );
    expect(out.map((s) => s.label)).toEqual(["run-1", "run-2"]);
  });
});

describe("applySessionMeta — colors", () => {
  it("lets a pinned color win over the positional assignment", () => {
    const out = applySessionMeta(
      [ses("a", "run-1"), ses("b", "run-2")],
      lookup({ a: { color: "#EF5350" } }),
    );
    expect(out[0]!.color).toBe("#EF5350");
    // The un-pinned session still gets its positional color.
    expect(out[1]!.color).toBe(colorForIndex(1));
  });

  it("re-derives the positional color from array position, not the input color", () => {
    // Session carries a stale color (e.g. the placeholder loadUserSession used);
    // with no override saved it must snap to its slot color.
    const out = applySessionMeta(
      [ses("a", "run-1", { color: "#123456" }), ses("b", "run-2", { color: "#123456" })],
      lookup({}),
    );
    expect(out.map((s) => s.color)).toEqual([colorForIndex(0), colorForIndex(1)]);
  });

  it("returns a pinned session to its positional color when the override clears", () => {
    const pinned = applySessionMeta(
      [ses("a", "run-1"), ses("b", "run-2")],
      lookup({ b: { color: SESSION_PALETTE[7]! } }),
    );
    expect(pinned[1]!.color).toBe(SESSION_PALETTE[7]);
    const cleared = applySessionMeta(pinned, lookup({}));
    expect(cleared[1]!.color).toBe(colorForIndex(1));
  });
});

describe("applySessionMeta — visibility", () => {
  it("applies a saved visible:false so hidden sessions stay hidden", () => {
    const out = applySessionMeta(
      [ses("a", "run-1"), ses("b", "run-2")],
      lookup({ a: { visible: false } }),
    );
    expect(out.map((s) => s.visible)).toEqual([false, true]);
    // The boot code picks the first VISIBLE session as primary; with the meta
    // applied first, that can no longer be a session the user hid.
    expect(out.find((s) => s.visible)!.id).toBe("b");
  });

  it("applies a saved visible:true over a loader default of hidden", () => {
    const out = applySessionMeta(
      [ses("a", "run-1", { visible: false })],
      lookup({ a: { visible: true } }),
    );
    expect(out[0]!.visible).toBe(true);
  });
});

describe("applySessionMeta — purity", () => {
  it("does not mutate the input sessions", () => {
    const input = [ses("a", "run-1")];
    applySessionMeta(input, lookup({ a: { label: "Kaden", color: "#EF5350", visible: false } }));
    expect(input[0]!.label).toBe("run-1");
    expect(input[0]!.visible).toBe(true);
    expect(input[0]!.defaultLabel).toBeUndefined();
  });

  it("is idempotent and preserves object identity on re-application", () => {
    const meta = lookup({ a: { label: "Kaden", color: "#EF5350", visible: false } });
    const once = applySessionMeta([ses("a", "run-1"), ses("b", "run-2")], meta);
    const twice = applySessionMeta(once, meta);
    expect(twice[0]!.label).toBe("Kaden");
    expect(twice[0]!.defaultLabel).toBe("run-1");
    // Unchanged sessions come back as the SAME object so React can skip work.
    expect(twice[0]).toBe(once[0]);
    expect(twice[1]).toBe(once[1]);
  });
});
