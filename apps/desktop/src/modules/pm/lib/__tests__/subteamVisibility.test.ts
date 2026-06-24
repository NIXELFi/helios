import { afterEach, describe, expect, test } from "vitest";
import type { Subteam } from "@helios/pm-ui";
import {
  recallVisibility,
  rememberVisibility,
  visibleSubteams,
  type SubteamVisibility,
} from "../subteamVisibility";

afterEach(() => {
  window.localStorage.clear();
});

// ---------------------------------------------------------------------------
// Per-user localStorage prefs (recall/remember)
// ---------------------------------------------------------------------------
describe("recallVisibility / rememberVisibility", () => {
  test("round-trips hide + unhide arrays for a project", () => {
    const pref: SubteamVisibility = { hide: ["a", "b"], unhide: ["c"] };
    rememberVisibility("proj1", pref);
    expect(recallVisibility("proj1")).toEqual(pref);
  });

  test("empty / unseen project returns the empty default", () => {
    expect(recallVisibility("never-saved")).toEqual({ hide: [], unhide: [] });
  });

  test("empty projectId returns the default without touching storage", () => {
    rememberVisibility("", { hide: ["x"], unhide: [] });
    expect(recallVisibility("")).toEqual({ hide: [], unhide: [] });
  });

  test("scopes are isolated per project", () => {
    rememberVisibility("p1", { hide: ["x"], unhide: [] });
    rememberVisibility("p2", { hide: [], unhide: ["y"] });
    expect(recallVisibility("p1")).toEqual({ hide: ["x"], unhide: [] });
    expect(recallVisibility("p2")).toEqual({ hide: [], unhide: ["y"] });
  });

  test("malformed JSON falls back to the empty default (never throws)", () => {
    window.localStorage.setItem("helios:pmSubteamVis:bad", "{nope");
    expect(recallVisibility("bad")).toEqual({ hide: [], unhide: [] });
  });

  test("wrong-shaped payload (not an object) falls back to default", () => {
    window.localStorage.setItem("helios:pmSubteamVis:weird", JSON.stringify([1, 2, 3]));
    expect(recallVisibility("weird")).toEqual({ hide: [], unhide: [] });
  });

  test("partial / non-array fields are coerced to empty arrays of strings", () => {
    window.localStorage.setItem(
      "helios:pmSubteamVis:partial",
      JSON.stringify({ hide: ["ok", 7, null, "two"], unhide: "nope" }),
    );
    expect(recallVisibility("partial")).toEqual({ hide: ["ok", "two"], unhide: [] });
  });

  test("remember de-dupes and drops empties so storage stays tidy", () => {
    rememberVisibility("p", { hide: ["a", "a", "b"], unhide: [] });
    expect(recallVisibility("p")).toEqual({ hide: ["a", "b"], unhide: [] });
    const raw = window.localStorage.getItem("helios:pmSubteamVis:p");
    expect(raw).not.toBeNull();
    // unhide was empty → should not bloat the stored payload with junk.
    expect(JSON.parse(raw as string).unhide).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pure display selector — the 3-way filter
// ---------------------------------------------------------------------------
function st(id: string): Subteam {
  return { id, name: id.toUpperCase(), code: id, slug: id, color: null };
}

describe("visibleSubteams (pure 3-way filter)", () => {
  const all = [st("aero"), st("battery"), st("hv"), st("lv"), st("chassis")];

  test("nothing hidden → all shown, order preserved", () => {
    const out = visibleSubteams(all, new Set(), { hide: [], unhide: [] });
    expect(out.map((s) => s.id)).toEqual(["aero", "battery", "hv", "lv", "chassis"]);
  });

  test("server-hidden subteams are removed by default", () => {
    const out = visibleSubteams(all, new Set(["battery", "hv", "lv"]), { hide: [], unhide: [] });
    expect(out.map((s) => s.id)).toEqual(["aero", "chassis"]);
  });

  test("user unhide overrides a server hide", () => {
    const out = visibleSubteams(all, new Set(["battery", "hv", "lv"]), {
      hide: [],
      unhide: ["hv"],
    });
    expect(out.map((s) => s.id)).toEqual(["aero", "hv", "chassis"]);
  });

  test("user hide removes a subteam that is otherwise shown", () => {
    const out = visibleSubteams(all, new Set(), { hide: ["aero"], unhide: [] });
    expect(out.map((s) => s.id)).toEqual(["battery", "hv", "lv", "chassis"]);
  });

  test("a brand-new subteam (no server-hide row) is shown by default", () => {
    const withNew = [...all, st("newteam")];
    const out = visibleSubteams(withNew, new Set(["battery"]), { hide: [], unhide: [] });
    expect(out.map((s) => s.id)).toContain("newteam");
  });

  test("user-hide takes precedence even over a user-unhide of the same id", () => {
    // If a user has both unhidden a server-hidden team AND explicitly hidden it,
    // the explicit hide wins (it's the more recent intent in the UI flow).
    const out = visibleSubteams(all, new Set(["hv"]), { hide: ["hv"], unhide: ["hv"] });
    expect(out.map((s) => s.id)).not.toContain("hv");
  });

  test("stale ids in prefs that match no subteam are inert", () => {
    const out = visibleSubteams(all, new Set(["deleted-server-id"]), {
      hide: ["also-gone"],
      unhide: ["ghost"],
    });
    expect(out.map((s) => s.id)).toEqual(["aero", "battery", "hv", "lv", "chassis"]);
  });
});
