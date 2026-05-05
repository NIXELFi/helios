# 13 — Layout editor: drag, resize, add, duplicate, delete, auto-arrange

## Symptom / motivation

Phase 11 / 12 ([11](11-edit-mode-and-config-editor.md), [12](12-channel-pickers-and-inspector.md)) made tile *configuration* editable but the layout was still hard-coded — you couldn't move, resize, add, or remove tiles from the UI. This commit lands the layout half of the editor, MoTeC-i2 style: a coarse snap grid, drag handles, a tile palette, per-tile duplicate/delete, and a one-click "auto-arrange" command.

## What this commit ships

### Grid + snapping — [apps/desktop/src/lib/grid.ts](../apps/desktop/src/lib/grid.ts)

- `GRID_COLS = 24`, `GRID_ROWS = 16`. Tile coordinates remain `[0,1]` floats; we just snap them to the nearest grid line on every commit. No data migration needed for existing workspaces.
- `snapTile(spec)` rounds `x/y/w/h`, enforces `MIN_CELLS_W=2 × MIN_CELLS_H=2`, and clamps the tile to the canvas.
- `findNextFreeSlot(tiles, w, h)` does a left-to-right, top-to-bottom search for the first empty `w×h` rectangle. Used by **+ Add tile** and **Duplicate**.
- `autoArrange(workspace)` distributes every tile evenly into a roughly square grid, preserving order.

### Drag-to-move + resize — [apps/desktop/src/components/Tile.tsx](../apps/desktop/src/components/Tile.tsx)

In edit mode, every tile gets:

- A **title bar** that's a drag-handle for moving (`cursor-grab` / `grabbing`). Press → record start; movement past 4 px → enter `move` state; release → snap and commit. A pure click without movement still selects the tile, opening the config panel.
- A **body click-shield** with the same handlers so the entire tile (not just the title) can be grabbed.
- A **bottom-right resize handle** (small yellow chevron) that drags out the tile's `w/h` against the parent's bounding rect; release → snap, enforce min size + canvas bounds, commit.

The **live drag** updates only local state (`useState` on the tile) so the parent doesn't re-render mid-drag — keeps frame-rate smooth even with overlay-heavy workspaces. The committed `onChange` only fires once at pointer-up.

The title bar shows a live size readout in cells (e.g. `· 12×5`) while editing.

### Visual grid overlay — `GridOverlay` in [App.tsx](../apps/desktop/src/App.tsx)

A pointer-events-none div behind the tiles renders a 1-pixel dot at every grid intersection (CSS radial gradient, no extra DOM). Only mounted in edit mode; off when you're done editing.

### + Add tile palette — [apps/desktop/src/components/AddTileModal.tsx](../apps/desktop/src/components/AddTileModal.tsx)

Modal with one tile per widget type (label, description, default cell footprint). Click → calls back into App with the widget's `defaultConfig`, App finds the next free slot via `findNextFreeSlot`, appends, persists, and selects the new tile so its config panel opens.

Tile id generation is deterministic — first instance is `widget-type-as-kebab`, subsequent ones get a numeric suffix.

### Duplicate / Delete — [apps/desktop/src/components/ConfigPanel.tsx](../apps/desktop/src/components/ConfigPanel.tsx)

Two new buttons in the panel header (`duplicate`, `delete`). Duplicate clones the selected tile with a `-copy` suffix and drops it in the next free slot at the same size. Delete removes the tile and clears the selection.

### Auto-arrange — header button

Calls `autoArrange(workspace)` — every tile is re-laid into a roughly square grid in source order. Useful as a "tidy up" command after a few add/duplicate/move operations.

### Other small touches

- Footer now shows `· N tiles` for the active workspace.
- Existing scrub interactions are unaffected outside edit mode — the click-shield and grid overlay are conditionally rendered.

## Decisions to flag

- **Snap on commit, not during drag.** Live drag is freeform; the snap happens once on pointer-up. This feels less laggy than continuous snapping, especially on fine motions, and it matches MoTeC i2's behavior. If you'd prefer continuous snapping (so the tile never visually mismatches the grid), one line in `Tile.tsx` flips it.
- **Minimum tile size: 2×2 cells.** Smaller and most widgets become illegible.
- **No collision detection.** Tiles can be dragged on top of each other. The grid is a snap reference, not a constraint solver. Auto-arrange is the cleanup tool.
- **Title-bar hold doubles as drag-to-move surface.** That means the existing tile id label is still visible in edit mode but can no longer be selected as text — fine for now; if anyone needs to copy the id, they can read it from the config panel.

## What's NOT in this commit (still backlog)

- **Workspace CRUD** — new / duplicate / delete / rename workspaces. Phase 2.5.
- **Style options on individual gauges** beyond what's already in the config editors. Add specifically as requested.
- **Tile snap with collision avoidance** (i.e. shift other tiles out of the way on drop). Not in MoTeC-style flow either.

## Files changed

- [apps/desktop/src/lib/grid.ts](../apps/desktop/src/lib/grid.ts) — new
- [apps/desktop/src/components/Tile.tsx](../apps/desktop/src/components/Tile.tsx)
- [apps/desktop/src/components/AddTileModal.tsx](../apps/desktop/src/components/AddTileModal.tsx) — new
- [apps/desktop/src/components/ConfigPanel.tsx](../apps/desktop/src/components/ConfigPanel.tsx) — duplicate/delete buttons
- [apps/desktop/src/App.tsx](../apps/desktop/src/App.tsx) — grid overlay, header buttons, add/duplicate/delete/auto-arrange wiring
