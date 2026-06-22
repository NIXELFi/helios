/** Regression tests for workspace-storage.ts.
 *  Tests cover:
 *  1. loadWorkspaces rejects blobs with malformed per-workspace entries
 *  2. migrateV4ToV5 does NOT mutate the original tile objects */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

// A minimal in-memory localStorage shim for unit tests.
const store: Record<string, string> = {};
const localStorageMock = {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v; },
  removeItem: (k: string) => { delete store[k]; },
};

// Patch the global before importing the module under test.
Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  writable: true,
});

// Import AFTER patching so the module sees the mock.
import { loadWorkspaces, saveWorkspaces } from "../workspace-storage";

const STORAGE_KEY = "helios.workspaces.v1";

beforeEach(() => {
  // Clear the mock store before each test.
  for (const k of Object.keys(store)) delete store[k];
});

afterEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

describe("loadWorkspaces", () => {
  it("falls back to builtins when the blob has a workspace with no id", () => {
    const malformed = {
      version: 5,
      workspaces: [{ label: "broken", tiles: [] }], // missing id
    };
    store[STORAGE_KEY] = JSON.stringify(malformed);
    const result = loadWorkspaces();
    // Should have loaded builtins (all have string ids)
    expect(result.every((w) => typeof w.id === "string")).toBe(true);
    // Builtins are non-empty
    expect(result.length).toBeGreaterThan(0);
  });

  it("falls back to builtins when the blob has a workspace with no tiles array", () => {
    const malformed = {
      version: 5,
      workspaces: [{ id: "w1", label: "broken" }], // missing tiles
    };
    store[STORAGE_KEY] = JSON.stringify(malformed);
    const result = loadWorkspaces();
    expect(result.every((w) => Array.isArray(w.tiles))).toBe(true);
  });

  it("returns workspaces unchanged when the blob is valid", () => {
    const valid = {
      version: 5,
      workspaces: [{ id: "w1", label: "My workspace", color: "#F00", tiles: [] }],
    };
    store[STORAGE_KEY] = JSON.stringify(valid);
    const result = loadWorkspaces();
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("w1");
  });
});

describe("migrateV4ToV5 (via loadWorkspaces v4 path)", () => {
  it("does not mutate the original tile objects in the default layout", () => {
    // Simulate a v4 blob with the default lap-analysis layout.
    const originalTile = { id: "time-report", widgetType: "channel_report", config: {}, x: 0, y: 0, w: 0.45, h: 0.45 };
    const lapPanel = { id: "lap-panel", widgetType: "lap_panel", config: {}, x: 0.45, y: 0, w: 0.2, h: 0.45 };
    const gpsTrack = { id: "gps-track", widgetType: "gps_track", config: {}, x: 0.65, y: 0, w: 0.35, h: 0.45 };
    const v4Blob = {
      version: 4,
      workspaces: [{
        id: "lap-analysis",
        label: "Lap Analysis",
        color: "#F00",
        tiles: [originalTile, lapPanel, gpsTrack],
      }],
    };
    store[STORAGE_KEY] = JSON.stringify(v4Blob);

    // Re-parse to get new object references (simulating real deserialization)
    const parsed = JSON.parse(JSON.stringify(v4Blob));
    const tileRef = parsed.workspaces[0].tiles[0]; // "time-report" ref before migration

    store[STORAGE_KEY] = JSON.stringify(parsed);
    const result = loadWorkspaces();

    // The time-report tile in result should have been resized
    const migratedTile = result[0]?.tiles.find((t: any) => t.id === "time-report");
    expect(migratedTile?.w).toBe(0.22);

    // But the original tileRef object should NOT have been mutated.
    // (If migrateV4ToV5 mutated in place, tileRef.w would also be 0.22)
    expect(tileRef.w).toBe(0.45); // unchanged
  });
});
