# 14 — Snap-to-grid (replacing destructive auto-arrange) + change widget type

Two follow-ups to [13](13-layout-editor.md).

## 1. Auto-arrange was destructive

### Symptom

The "Auto-arrange" button rebuilt every tile to the same uniform size. With the default Overview workspace this turned a full-width engine bar (`24×2` cells) into a small square (`6×4`), and the GPS track and other carefully sized tiles "exploded" into wrong shapes. Visually broke layouts the user had worked on.

### Root cause

`autoArrange()` computed `cols = ceil(sqrt(n))` and assigned every tile a uniform `1/cols × 1/rows` rectangle in source order. This is what MoTeC calls "tile uniformly", but it isn't what you want as a one-click cleanup — it nukes intentional sizing.

### Fix

`autoArrange()` was replaced with `snapAllToGrid()` ([apps/desktop/src/lib/grid.ts](../apps/desktop/src/lib/grid.ts)) — it just runs `snapTile` on every tile, preserving each tile's own size and only rounding `x/y/w/h` to grid lines. The header button is now labelled **"Snap to grid"** and only fixes off-grid drifts; it never resizes.

The destructive uniform-tile behavior is kept in code as `tileUniformly()` for future use (e.g. if we add an explicit "Tile uniformly" command later) but no UI exposes it.

## 2. No way to change a tile's widget type

### Symptom

If a tile was a Histogram and you wanted to make it a Strip Chart, the only path was: delete the tile, then add a new one of the right type (and re-set its position/size). No in-place "change type" command.

### Fix

ConfigPanel header now has a **type selector** ([apps/desktop/src/components/ConfigPanel.tsx](../apps/desktop/src/components/ConfigPanel.tsx)) listing all 11 widget types. Picking a new type:

- Confirms first (the existing config will be reset to the new widget's defaults — different widgets have incompatible config schemas).
- Keeps `id`, `x`, `y`, `w`, `h` intact.
- Replaces `widgetType` and resets `config` to the new widget's `defaultConfig`.

Existing position/size are preserved so the user can swap visualizations of the same data slot without re-laying-out.

## Files changed

- [apps/desktop/src/lib/grid.ts](../apps/desktop/src/lib/grid.ts)
- [apps/desktop/src/App.tsx](../apps/desktop/src/App.tsx)
- [apps/desktop/src/components/ConfigPanel.tsx](../apps/desktop/src/components/ConfigPanel.tsx)
