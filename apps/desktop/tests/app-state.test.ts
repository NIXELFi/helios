import { describe, it, expect, beforeEach } from "vitest";
import {
  loadLastWorkspaceId, saveLastWorkspaceId,
  loadRecentSessions, addRecentSession, removeRecentSession,
  loadViewStateFor, saveViewStateFor,
  loadLapSelection, saveLapSelection,
  __resetAppStateForTest,
} from "../src/lib/app-state";

describe("app-state persistence", () => {
  beforeEach(() => __resetAppStateForTest());

  describe("lastWorkspaceId", () => {
    it("returns null when nothing is stored", () => {
      expect(loadLastWorkspaceId()).toBeNull();
    });

    it("round-trips a saved id", () => {
      saveLastWorkspaceId("engine-focus");
      expect(loadLastWorkspaceId()).toBe("engine-focus");
    });

    it("can clear back to null", () => {
      saveLastWorkspaceId("engine-focus");
      saveLastWorkspaceId(null);
      expect(loadLastWorkspaceId()).toBeNull();
    });

    it("survives partial / malformed blobs", () => {
      localStorage.setItem("helios.app-state.v1", "{not json");
      expect(loadLastWorkspaceId()).toBeNull();
      // After a read, we don't auto-rewrite — but a fresh save still works.
      saveLastWorkspaceId("x");
      expect(loadLastWorkspaceId()).toBe("x");
    });
  });

  describe("recentSessions", () => {
    it("starts empty", () => {
      expect(loadRecentSessions()).toEqual([]);
    });

    it("adds paths most-recent first", () => {
      addRecentSession("/data/a.csv");
      addRecentSession("/data/b.csv");
      addRecentSession("/data/c.csv");
      expect(loadRecentSessions()).toEqual(["/data/c.csv", "/data/b.csv", "/data/a.csv"]);
    });

    it("dedupes — re-adding promotes to head", () => {
      addRecentSession("/data/a.csv");
      addRecentSession("/data/b.csv");
      addRecentSession("/data/a.csv");
      expect(loadRecentSessions()).toEqual(["/data/a.csv", "/data/b.csv"]);
    });

    it("caps at 32 entries", () => {
      for (let i = 0; i < 50; i++) addRecentSession(`/data/${i}.csv`);
      const list = loadRecentSessions();
      expect(list.length).toBe(32);
      // Most recent first, so entry 49 is head.
      expect(list[0]).toBe("/data/49.csv");
      expect(list[31]).toBe("/data/18.csv");
    });

    it("removes paths cleanly", () => {
      addRecentSession("/data/a.csv");
      addRecentSession("/data/b.csv");
      removeRecentSession("/data/a.csv");
      expect(loadRecentSessions()).toEqual(["/data/b.csv"]);
    });

    it("remove is a no-op for unknown paths", () => {
      addRecentSession("/data/a.csv");
      removeRecentSession("/data/ghost.csv");
      expect(loadRecentSessions()).toEqual(["/data/a.csv"]);
    });
  });

  describe("lapSelection", () => {
    it("returns null when nothing is stored", () => {
      expect(loadLapSelection()).toBeNull();
    });

    it("round-trips a saved selection", () => {
      const sel = {
        main: { sessionId: "A", lapIndex: 3 },
        ref:  { sessionId: "B", lapIndex: 5 },
        overlays: [{ sessionId: "C", lapIndex: 1 }],
      };
      saveLapSelection(sel);
      expect(loadLapSelection()).toEqual(sel);
    });

    it("collapses an empty selection to null (don't bloat the blob)", () => {
      saveLapSelection({ main: null, ref: null, overlays: [] });
      expect(loadLapSelection()).toBeNull();
    });

    it("clears back to null via explicit null", () => {
      saveLapSelection({ main: { sessionId: "A", lapIndex: 0 }, ref: null, overlays: [] });
      saveLapSelection(null);
      expect(loadLapSelection()).toBeNull();
    });

    it("ignores malformed saved selections on load", () => {
      localStorage.setItem("helios.app-state.v1", JSON.stringify({
        version: 1,
        lastWorkspaceId: null,
        recentSessions: [],
        viewStateBySession: {},
        lapSelection: { main: { sessionId: "A", lapIndex: "not-a-number" }, ref: null, overlays: [] },
      }));
      expect(loadLapSelection()).toBeNull();
    });
  });

  it("lastWorkspaceId and recentSessions live in one blob and don't clobber each other", () => {
    saveLastWorkspaceId("lap-analysis");
    addRecentSession("/x.csv");
    saveLastWorkspaceId("overview");
    expect(loadRecentSessions()).toEqual(["/x.csv"]);
    expect(loadLastWorkspaceId()).toBe("overview");
  });

  describe("viewStateBySession", () => {
    it("returns null when nothing is stored for a session", () => {
      expect(loadViewStateFor("sess-a")).toBeNull();
    });

    it("round-trips a cursor + zoom snapshot", () => {
      saveViewStateFor("sess-a", { cursorUs: 12_345_000, zoomRange: { startUs: 1000, endUs: 60_000_000 } });
      const snap = loadViewStateFor("sess-a");
      expect(snap).toEqual({ cursorUs: 12_345_000, zoomRange: { startUs: 1000, endUs: 60_000_000 } });
    });

    it("accepts null zoomRange (full extent)", () => {
      saveViewStateFor("sess-a", { cursorUs: 0, zoomRange: null });
      expect(loadViewStateFor("sess-a")).toEqual({ cursorUs: 0, zoomRange: null });
    });

    it("keeps per-session entries independent", () => {
      saveViewStateFor("sess-a", { cursorUs: 100, zoomRange: null });
      saveViewStateFor("sess-b", { cursorUs: 200, zoomRange: null });
      expect(loadViewStateFor("sess-a")!.cursorUs).toBe(100);
      expect(loadViewStateFor("sess-b")!.cursorUs).toBe(200);
    });

    it("evicts oldest entries past 64-session cap, retaining the just-saved one", () => {
      for (let i = 0; i < 70; i++) saveViewStateFor(`sess-${i}`, { cursorUs: i, zoomRange: null });
      // The 6 oldest (0..5) should be evicted; 6..69 retained.
      expect(loadViewStateFor("sess-0")).toBeNull();
      expect(loadViewStateFor("sess-5")).toBeNull();
      expect(loadViewStateFor("sess-6")!.cursorUs).toBe(6);
      expect(loadViewStateFor("sess-69")!.cursorUs).toBe(69);
    });

    it("re-saving a session moves it to most-recent (so it survives eviction)", () => {
      for (let i = 0; i < 64; i++) saveViewStateFor(`sess-${i}`, { cursorUs: i, zoomRange: null });
      // Re-save sess-0 → moves to newest position.
      saveViewStateFor("sess-0", { cursorUs: 999, zoomRange: null });
      // Add another distinct session → evicts sess-1 (oldest), keeps sess-0.
      saveViewStateFor("sess-100", { cursorUs: 100, zoomRange: null });
      expect(loadViewStateFor("sess-1")).toBeNull();
      expect(loadViewStateFor("sess-0")!.cursorUs).toBe(999);
    });

    it("round-trips datum markers (optional field)", () => {
      saveViewStateFor("sess-a", {
        cursorUs: 1000, zoomRange: null,
        datums: [500_000, 1_200_000, 7_500_000],
      });
      const snap = loadViewStateFor("sess-a")!;
      expect(snap.datums).toEqual([500_000, 1_200_000, 7_500_000]);
    });

    it("ignores malformed snapshots on load", () => {
      localStorage.setItem("helios.app-state.v1", JSON.stringify({
        version: 1,
        lastWorkspaceId: null,
        recentSessions: [],
        viewStateBySession: { "sess-a": { cursorUs: "not-a-number" } },
      }));
      // Malformed map → whole field falls back to {}; other fields preserved.
      expect(loadViewStateFor("sess-a")).toBeNull();
    });
  });
});
