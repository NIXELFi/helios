# 07 — Workspace switcher (phase 1 of view editing)

## Symptom / motivation

The dashboard layout was a single hardcoded `overviewDefault` array imported into `App.tsx`. To try a different layout — say, a screen focused on engine channels — you had to edit source and rebuild. The team will eventually want to add and edit views, change what they represent, and switch between several workspaces.

This commit lays the foundation: a small registry of named workspaces and a header dropdown to switch between them. **Editing tiles is not in scope for this commit** — see *next steps* below.

## Approach

We split the eventual feature into two phases so the data-model work happens first and the editor can be built on top of it.

| Phase | Scope |
| - | - |
| **1 (this commit)** | Multiple built-in workspaces + a switcher in the header. No persistence, no editing. |
| **2 (future)** | Tile editor, drag/resize, user-created workspaces, persistence to localStorage or Tauri app data. |

This order forces the data model (`Workspace = { id, label, tiles[] }`) to be locked down before the editor opinionates on it, and keeps phase 1 small enough to land in one pass.

## Changes

### New shared types — [apps/desktop/src/workspaces/types.ts](../apps/desktop/src/workspaces/types.ts)

`TileSpec` and `WidgetType` were defined inside `overview-default.ts`. They moved to a sibling `types.ts`, joined by a new `Workspace` type:

```ts
export interface Workspace {
  id: string;
  label: string;
  tiles: TileSpec[];
}
```

[components/Tile.tsx](../apps/desktop/src/components/Tile.tsx) now imports `TileSpec` from `workspaces/types` instead of `workspaces/overview-default`.

### New built-in workspace — [apps/desktop/src/workspaces/engine-focus.ts](../apps/desktop/src/workspaces/engine-focus.ts)

A second workspace that emphasizes engine channels (RPM strip, throttle strip, RPM gauge + readouts, water/oil bars, RPM histogram, RPM-vs-throttle xy plot). Deliberately omits tire and GPS tiles since the current sample CSVs either don't carry that data or carry it in an unscaled form.

### Workspace registry — [apps/desktop/src/workspaces/index.ts](../apps/desktop/src/workspaces/index.ts)

```ts
export const WORKSPACES: Workspace[] = [
  { id: "overview",     label: "Overview",     tiles: overviewDefault },
  { id: "engine-focus", label: "Engine focus", tiles: engineFocus },
];
```

Adding a third built-in is now one entry in this array.

### Header switcher — [apps/desktop/src/App.tsx](../apps/desktop/src/App.tsx)

A row of tab-style buttons was added to the header (separated from the sample dropdown by a small `·`). Tabs are horizontal so all workspaces are visible at a glance — one click to switch, no menu open. The active tab is highlighted in the brand yellow (`#FFC627`); inactive tabs match the existing dropdown styling.

The buttons bind to a new `workspaceId` state; the rendered tile list comes from `WORKSPACES.find(w => w.id === workspaceId).tiles`. Switching workspaces is instant — no remount of the store or cursor emitter, only the tile array changes.

## Next steps (phase 2)

Roughly in priority order, none of which are in this commit:

1. Persistence — write user-modified workspaces to localStorage or `appDataDir`/workspaces.json.
2. Tile property editor — pick widget type, channel ids, ranges, colors. Probably a side panel that opens on click.
3. Drag-to-reposition / resize on the tile grid.
4. New workspace command — duplicate-from-existing or blank.
5. Workspace import/export — JSON files the team can share.

## Files changed

- [apps/desktop/src/workspaces/types.ts](../apps/desktop/src/workspaces/types.ts) — new
- [apps/desktop/src/workspaces/engine-focus.ts](../apps/desktop/src/workspaces/engine-focus.ts) — new
- [apps/desktop/src/workspaces/index.ts](../apps/desktop/src/workspaces/index.ts) — new
- [apps/desktop/src/workspaces/overview-default.ts](../apps/desktop/src/workspaces/overview-default.ts) — types extracted out, data unchanged
- [apps/desktop/src/components/Tile.tsx](../apps/desktop/src/components/Tile.tsx) — type import updated
- [apps/desktop/src/App.tsx](../apps/desktop/src/App.tsx) — workspace selector + state
