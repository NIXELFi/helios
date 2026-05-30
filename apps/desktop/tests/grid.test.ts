import { describe, it, expect } from "vitest";
import { findNextFreeSlot, GRID_COLS, GRID_ROWS } from "../src/lib/grid";
import type { TileSpec } from "../src/workspaces/types";

function tile(id: string, x: number, y: number, w: number, h: number): TileSpec {
  return { id, widgetType: "channel_report", config: {}, x, y, w, h };
}

function intersects(slot: { x: number; y: number; w: number; h: number }, t: TileSpec): boolean {
  return (
    slot.x < t.x + t.w &&
    slot.x + slot.w > t.x &&
    slot.y < t.y + t.h &&
    slot.y + slot.h > t.y
  );
}

describe("findNextFreeSlot — rectangle intersection (L8)", () => {
  it("returns top-left for an empty workspace", () => {
    const slot = findNextFreeSlot([], 6, 4);
    expect(slot).toEqual({ x: 0, y: 0, w: 6 / GRID_COLS, h: 4 / GRID_ROWS });
  });

  it("places to the right of a tile that fills the left half", () => {
    const existing = [tile("a", 0, 0, 0.5, 1)];
    const slot = findNextFreeSlot(existing, 6, 4);
    expect(slot.x).toBeGreaterThanOrEqual(0.5 - 1e-9);
  });

  it("does not overlap a sub-cell tile sitting between cell-corner sample points", () => {
    // This tile lives entirely inside grid cell (1,1): x∈[1/24,2/24],
    // y∈[1/16,2/16], but inset so NO grid corner (cx/24, cy/16) falls inside
    // it. The old point-in-rect occupancy sampled cell corners and so reported
    // the whole canvas free → placed a new tile at (0,0) right on top of it.
    const cw = 1 / GRID_COLS;
    const ch = 1 / GRID_ROWS;
    const existing = [tile("sub", cw * 1 + cw * 0.2, ch * 1 + ch * 0.2, cw * 0.6, ch * 0.6)];
    const slot = findNextFreeSlot(existing, 6, 4);
    expect(intersects(slot, existing[0]!)).toBe(false);
  });

  it("does not overlap an existing tile whose edges fall between grid lines", () => {
    const existing = [tile("a", 0.01, 0.01, 0.49, 0.49)];
    const slot = findNextFreeSlot(existing, 6, 4);
    expect(intersects(slot, existing[0]!)).toBe(false);
  });
});
