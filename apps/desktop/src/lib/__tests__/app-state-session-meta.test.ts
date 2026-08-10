/** Persistence tests for the sessionMeta slice of the app-state blob:
 *  round-trip, patch-merge, override clearing, the bounded LRU, removal
 *  cleanup, and tolerance of blobs written before the field existed.
 *
 *  jsdom supplies a real localStorage, so these exercise the actual storage
 *  path; __resetAppStateForTest is the module's own test seam for wiping it.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  __resetAppStateForTest,
  loadSessionMeta, saveSessionMeta, removeSessionMeta,
  loadRecentSessions, loadLastWorkspaceId,
} from "../app-state";

const STORAGE_KEY = "helios.app-state.v1";

beforeEach(() => {
  __resetAppStateForTest();
});

describe("sessionMeta round-trip", () => {
  it("returns null for a session with nothing saved", () => {
    expect(loadSessionMeta("user:abc")).toBeNull();
  });

  it("saves and reads back every field", () => {
    saveSessionMeta("user:abc", { label: "Kaden", color: "#EF5350", visible: false });
    expect(loadSessionMeta("user:abc")).toEqual({
      label: "Kaden", color: "#EF5350", visible: false,
    });
  });

  it("merges successive patches instead of replacing the entry", () => {
    saveSessionMeta("user:abc", { color: "#EF5350" });
    saveSessionMeta("user:abc", { visible: false });
    saveSessionMeta("user:abc", { label: "Kaden" });
    expect(loadSessionMeta("user:abc")).toEqual({
      color: "#EF5350", visible: false, label: "Kaden",
    });
  });

  it("keeps sessions independent", () => {
    saveSessionMeta("user:a", { color: "#EF5350" });
    saveSessionMeta("user:b", { color: "#4FC3F7" });
    expect(loadSessionMeta("user:a")!.color).toBe("#EF5350");
    expect(loadSessionMeta("user:b")!.color).toBe("#4FC3F7");
  });
});

describe("sessionMeta clearing", () => {
  it("clears a single field when it's patched with undefined", () => {
    saveSessionMeta("user:abc", { label: "Kaden", color: "#EF5350" });
    saveSessionMeta("user:abc", { color: undefined });
    const meta = loadSessionMeta("user:abc")!;
    expect(meta.label).toBe("Kaden");
    expect("color" in meta).toBe(false);
  });

  it("drops the entry entirely once the last override is cleared", () => {
    saveSessionMeta("user:abc", { label: "Kaden" });
    saveSessionMeta("user:abc", { label: undefined });
    expect(loadSessionMeta("user:abc")).toBeNull();
    // …and it isn't left behind as an empty record in the blob.
    const blob = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(Object.keys(blob.sessionMeta)).toHaveLength(0);
  });

  it("removeSessionMeta forgets every override for one session only", () => {
    saveSessionMeta("user:a", { label: "Kaden", visible: false });
    saveSessionMeta("user:b", { label: "Ryan" });
    removeSessionMeta("user:a");
    expect(loadSessionMeta("user:a")).toBeNull();
    expect(loadSessionMeta("user:b")!.label).toBe("Ryan");
  });

  it("removeSessionMeta on an unknown id is a no-op", () => {
    saveSessionMeta("user:b", { label: "Ryan" });
    removeSessionMeta("user:nope");
    expect(loadSessionMeta("user:b")!.label).toBe("Ryan");
  });
});

describe("sessionMeta LRU bound", () => {
  it("keeps only the 64 most recently touched sessions", () => {
    for (let i = 0; i < 70; i++) saveSessionMeta(`user:${i}`, { visible: false });
    const blob = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(Object.keys(blob.sessionMeta)).toHaveLength(64);
    // The six oldest fell off the front; the newest survived.
    expect(loadSessionMeta("user:0")).toBeNull();
    expect(loadSessionMeta("user:5")).toBeNull();
    expect(loadSessionMeta("user:6")).not.toBeNull();
    expect(loadSessionMeta("user:69")).not.toBeNull();
  });

  it("re-saving an old entry refreshes its position so it survives overflow", () => {
    for (let i = 0; i < 64; i++) saveSessionMeta(`user:${i}`, { visible: false });
    // Touch the oldest, then push one past the cap. Without the LRU refresh,
    // user:0 would be the entry evicted.
    saveSessionMeta("user:0", { label: "Kaden" });
    saveSessionMeta("user:64", { visible: false });
    expect(loadSessionMeta("user:0")).not.toBeNull();
    expect(loadSessionMeta("user:1")).toBeNull();
  });
});

describe("sessionMeta blob compatibility", () => {
  it("tolerates a blob written before sessionMeta existed", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      lastWorkspaceId: "overview",
      recentSessions: ["C:/logs/a.csv"],
      viewStateBySession: {},
      lapSelection: null,
    }));
    expect(loadSessionMeta("user:abc")).toBeNull();
    // The pre-existing fields still load, and writing meta doesn't clobber them.
    saveSessionMeta("user:abc", { visible: false });
    expect(loadRecentSessions()).toEqual(["C:/logs/a.csv"]);
    expect(loadLastWorkspaceId()).toBe("overview");
    expect(loadSessionMeta("user:abc")!.visible).toBe(false);
  });

  it("falls back to no overrides when the saved map is malformed", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      lastWorkspaceId: null,
      recentSessions: [],
      viewStateBySession: {},
      lapSelection: null,
      sessionMeta: { "user:abc": { visible: "yes" } },
    }));
    expect(loadSessionMeta("user:abc")).toBeNull();
  });
});
