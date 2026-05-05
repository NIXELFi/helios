import type { TileSpec, Workspace } from "../workspaces/types";

export const GRID_COLS = 24;
export const GRID_ROWS = 16;
export const MIN_CELLS_W = 2;
export const MIN_CELLS_H = 2;

/** Snap a [0,1] coordinate to the nearest grid line. */
export function snapX(v: number): number {
  return clamp01(Math.round(v * GRID_COLS) / GRID_COLS);
}
export function snapY(v: number): number {
  return clamp01(Math.round(v * GRID_ROWS) / GRID_ROWS);
}

/** Snap a tile's position+size to the grid, enforcing min-size and bounds. */
export function snapTile(spec: TileSpec): TileSpec {
  let x = snapX(spec.x);
  let y = snapY(spec.y);
  let w = snapX(spec.w);
  let h = snapY(spec.h);
  // Enforce min size in cells.
  w = Math.max(MIN_CELLS_W / GRID_COLS, w);
  h = Math.max(MIN_CELLS_H / GRID_ROWS, h);
  // Keep on-canvas: if the tile would extend past the right/bottom edge, push
  // its origin back; if THAT would push origin negative, clamp width/height.
  if (x + w > 1) x = Math.max(0, 1 - w);
  if (y + h > 1) y = Math.max(0, 1 - h);
  if (x + w > 1) w = 1 - x;
  if (y + h > 1) h = 1 - y;
  return { ...spec, x: snapX(x), y: snapY(y), w: snapX(w), h: snapY(h) };
}

/** Find the next free top-left cell for a new tile. Tries left-to-right,
 *  top-to-bottom; falls back to (0,0) if the canvas is fully tiled. */
export function findNextFreeSlot(
  tiles: TileSpec[],
  cellsW = 6,
  cellsH = 4,
): { x: number; y: number; w: number; h: number } {
  const occupied = (cx: number, cy: number) => {
    const px = cx / GRID_COLS;
    const py = cy / GRID_ROWS;
    for (const t of tiles) {
      if (px >= t.x && px < t.x + t.w && py >= t.y && py < t.y + t.h) return true;
    }
    return false;
  };
  for (let cy = 0; cy <= GRID_ROWS - cellsH; cy++) {
    for (let cx = 0; cx <= GRID_COLS - cellsW; cx++) {
      let clear = true;
      outer:
      for (let dy = 0; dy < cellsH; dy++) {
        for (let dx = 0; dx < cellsW; dx++) {
          if (occupied(cx + dx, cy + dy)) { clear = false; break outer; }
        }
      }
      if (clear) {
        return {
          x: cx / GRID_COLS,
          y: cy / GRID_ROWS,
          w: cellsW / GRID_COLS,
          h: cellsH / GRID_ROWS,
        };
      }
    }
  }
  return {
    x: 0, y: 0,
    w: cellsW / GRID_COLS,
    h: cellsH / GRID_ROWS,
  };
}

/** Snap every tile in the workspace to the grid without changing relative
 *  size. Useful for cleaning up after freeform drags so everything aligns to
 *  cell boundaries. Sizes are preserved (modulo the snap rounding). */
export function snapAllToGrid(workspace: Workspace): Workspace {
  return { ...workspace, tiles: workspace.tiles.map(snapTile) };
}

/** Distribute every tile in the workspace evenly across the grid in a roughly
 *  square layout. **Destructive** — every tile becomes the same size. Kept
 *  here for future use; the UI no longer exposes it directly because it tends
 *  to break carefully sized layouts (e.g. a full-width engine bar becomes a
 *  square). */
export function tileUniformly(workspace: Workspace): Workspace {
  const n = workspace.tiles.length;
  if (n === 0) return workspace;
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const cellW = 1 / cols;
  const cellH = 1 / rows;
  const tiles = workspace.tiles.map((t, i): TileSpec => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    return snapTile({ ...t, x: c * cellW, y: r * cellH, w: cellW, h: cellH });
  });
  return { ...workspace, tiles };
}

function clamp01(v: number): number { return Math.max(0, Math.min(1, v)); }
