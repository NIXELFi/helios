import { beforeEach, describe, expect, it } from "vitest";
import { loadWorkspaces, saveWorkspaces } from "../src/lib/workspace-storage";
import { SESSION_PALETTE } from "../src/lib/session";

const KEY = "helios.workspaces.v1";

describe("workspace-storage", () => {
  beforeEach(() => localStorage.clear());

  it("seeds built-ins on first load (no blob)", () => {
    const ws = loadWorkspaces();
    expect(ws.length).toBeGreaterThan(0);
    expect(ws.every((w) => typeof w.color === "string" && w.color.startsWith("#"))).toBe(true);
  });

  it("v1→current migration fills color from SESSION_PALETTE indexed by position", () => {
    const v1 = {
      version: 1,
      workspaces: [
        { id: "a", label: "A", tiles: [] },
        { id: "b", label: "B", tiles: [] },
        { id: "c", label: "C", tiles: [] },
      ],
    };
    localStorage.setItem(KEY, JSON.stringify(v1));

    const ws = loadWorkspaces();

    // The three v1 workspaces survive with their palette-derived colors.
    // Later migrations may *append* (e.g. v3→v4 seeds a missing lap-analysis),
    // so we check the user-defined ones in order rather than the full array.
    expect(ws.slice(0, 3).map((w) => w.color)).toEqual([
      SESSION_PALETTE[0],
      SESSION_PALETTE[1],
      SESSION_PALETTE[2],
    ]);
    // The blob is rewritten at the current schema version. The exact number
    // is allowed to drift as new versions ship — what we care about is that
    // it's not still v1.
    const rewritten = JSON.parse(localStorage.getItem(KEY)!);
    expect(rewritten.version).toBeGreaterThanOrEqual(2);
  });

  it("v2 blob is loaded as-is (round-trip preserves color)", () => {
    const ws = [
      { id: "a", label: "A", color: "#123456", tiles: [] },
      { id: "b", label: "B", color: "#abcdef", tiles: [] },
    ];
    saveWorkspaces(ws);
    const loaded = loadWorkspaces();
    expect(loaded).toEqual(ws);
  });

  it("corrupt blob falls back to seeded built-ins", () => {
    localStorage.setItem(KEY, "not json {{{");
    const ws = loadWorkspaces();
    expect(ws.length).toBeGreaterThan(0);
    expect(ws[0]!.color).toMatch(/^#/);
  });

  it("empty workspaces array in stored blob falls back to built-ins", () => {
    localStorage.setItem(KEY, JSON.stringify({ version: 2, workspaces: [] }));
    const ws = loadWorkspaces();
    expect(ws.length).toBeGreaterThan(0);
  });

  it("v2→v3 migration appends a lap_delta tile to the lap-analysis workspace", () => {
    const v2 = {
      version: 2,
      workspaces: [
        {
          id: "lap-analysis", label: "Lap Analysis", color: "#FFC627",
          tiles: [
            { id: "time-report", widgetType: "time_report", config: {}, x: 0, y: 0, w: 0.5, h: 0.5 },
            { id: "distance-strip", widgetType: "strip_chart", config: { channels: [], yMin: 0, yMax: 1, xMode: "distance" }, x: 0, y: 0.5, w: 1, h: 0.25 },
          ],
        },
        // An unrelated workspace stays untouched.
        {
          id: "engine-focus", label: "Engine", color: "#4FC3F7",
          tiles: [{ id: "t", widgetType: "round_gauge", config: {}, x: 0, y: 0, w: 0.5, h: 0.5 }],
        },
      ],
    };
    localStorage.setItem(KEY, JSON.stringify(v2));

    const ws = loadWorkspaces();
    const lap = ws.find((w) => w.id === "lap-analysis")!;
    expect(lap.tiles.some((t) => t.widgetType === "lap_delta")).toBe(true);
    const engine = ws.find((w) => w.id === "engine-focus")!;
    expect(engine.tiles.some((t) => t.widgetType === "lap_delta")).toBe(false);
    // Blob is rewritten at the current schema version.
    const rewritten = JSON.parse(localStorage.getItem(KEY)!);
    expect(rewritten.version).toBeGreaterThanOrEqual(3);
  });

  it("v3→v4 seeds a lap-analysis workspace if none exists (defensive against earlier deletion)", () => {
    const v3 = {
      version: 3,
      workspaces: [
        { id: "overview", label: "Overview", color: "#FFC627", tiles: [] },
        // intentionally no lap-analysis workspace
        { id: "engine-focus", label: "Engine", color: "#EF5350", tiles: [] },
      ],
    };
    localStorage.setItem(KEY, JSON.stringify(v3));
    const ws = loadWorkspaces();
    expect(ws.some((w) => w.id === "lap-analysis")).toBe(true);
    const lap = ws.find((w) => w.id === "lap-analysis")!;
    expect(lap.tiles.some((t) => t.widgetType === "lap_delta")).toBe(true);
  });

  it("v3→v4 leaves an existing lap-analysis workspace's label and original tiles untouched", () => {
    const v3 = {
      version: 3,
      workspaces: [{
        id: "lap-analysis", label: "Custom Lap View", color: "#FFC627",
        tiles: [{ id: "x", widgetType: "round_gauge", config: {}, x: 0, y: 0, w: 0.5, h: 0.5 }],
      }],
    };
    localStorage.setItem(KEY, JSON.stringify(v3));
    const ws = loadWorkspaces();
    const lap = ws.find((w) => w.id === "lap-analysis")!;
    // User's custom label survives the chain. Later migrations may *append*
    // new built-in tiles (v4→v5 adds sector_table), but they never alter or
    // remove a user-placed one.
    expect(lap.label).toBe("Custom Lap View");
    expect(lap.tiles.some((t) => t.id === "x" && t.widgetType === "round_gauge")).toBe(true);
  });

  it("v4→v5 adds a sector_table tile to lap-analysis when missing", () => {
    const v4 = {
      version: 4,
      workspaces: [{
        id: "lap-analysis", label: "Lap Analysis", color: "#FFC627",
        tiles: [
          { id: "lap-delta", widgetType: "lap_delta", config: {}, x: 0, y: 0, w: 1, h: 0.2 },
        ],
      }],
    };
    localStorage.setItem(KEY, JSON.stringify(v4));
    const ws = loadWorkspaces();
    const lap = ws.find((w) => w.id === "lap-analysis")!;
    expect(lap.tiles.some((t) => t.widgetType === "sector_table")).toBe(true);
  });

  it("v4→v5 migration is idempotent — workspace already containing sector_table is unchanged", () => {
    const v4 = {
      version: 4,
      workspaces: [{
        id: "lap-analysis", label: "Lap Analysis", color: "#FFC627",
        tiles: [
          { id: "sector-table", widgetType: "sector_table", config: { sectorCount: 3, maxRows: 8, hideUntrusted: true }, x: 0, y: 0, w: 0.2, h: 0.45 },
        ],
      }],
    };
    localStorage.setItem(KEY, JSON.stringify(v4));
    const ws = loadWorkspaces();
    const lap = ws.find((w) => w.id === "lap-analysis")!;
    expect(lap.tiles.filter((t) => t.widgetType === "sector_table").length).toBe(1);
  });

  it("v2→v3 migration is idempotent — a workspace already containing lap_delta is unchanged", () => {
    const v2 = {
      version: 2,
      workspaces: [{
        id: "lap-analysis", label: "Lap Analysis", color: "#FFC627",
        tiles: [
          { id: "lap-delta", widgetType: "lap_delta", config: {}, x: 0, y: 0, w: 1, h: 0.2 },
        ],
      }],
    };
    localStorage.setItem(KEY, JSON.stringify(v2));
    const ws = loadWorkspaces();
    const lap = ws.find((w) => w.id === "lap-analysis")!;
    // Still exactly one lap_delta tile (no duplicate).
    expect(lap.tiles.filter((t) => t.widgetType === "lap_delta").length).toBe(1);
  });
});
