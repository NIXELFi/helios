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

  it("v1→v2 migration fills color from SESSION_PALETTE indexed by position", () => {
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

    expect(ws.map((w) => w.color)).toEqual([
      SESSION_PALETTE[0],
      SESSION_PALETTE[1],
      SESSION_PALETTE[2],
    ]);
    // The blob is rewritten as v2 in the same key.
    const rewritten = JSON.parse(localStorage.getItem(KEY)!);
    expect(rewritten.version).toBe(2);
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
});
