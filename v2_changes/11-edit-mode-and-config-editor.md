# 11 — Edit mode + tile config editor (phase 2.1 + 2.2 of view editing)

## Symptom / motivation

Phase 1 ([07](07-workspace-switcher.md)) added a workspace switcher but every workspace was read-only. The team needs to be able to change which channels a tile shows, tweak ranges/colors, and have those edits stick across reload — without rebuilding the app.

This commit lands the foundation (edit mode + persistence) and the first user-visible capability (tile config editor) in one pass. Layout drag/resize, tile add/remove, and workspace CRUD are still in [07](07-workspace-switcher.md)'s phase-2 backlog.

## Phase plan progress

| | Phase | Status |
| - | - | - |
| 2.1 | Foundation (edit-mode toggle + localStorage persistence) | ✅ this commit |
| 2.2 | Tile config editor | ✅ this commit |
| 2.3 | Layout drag/resize | future |
| 2.4 | Tile CRUD (add / duplicate / delete) | future |
| 2.5 | Workspace CRUD (new / duplicate / delete / rename) | future |

## What this commit ships

### Persistence — [apps/desktop/src/lib/workspace-storage.ts](../apps/desktop/src/lib/workspace-storage.ts)

```ts
export function loadWorkspaces(): Workspace[];
export function saveWorkspaces(workspaces: Workspace[]): void;
export function resetToBuiltins(): Workspace[];
```

- Backed by `localStorage` under key `helios.workspaces.v1`.
- On first ever load (or unreadable blob), the bundled built-ins ([apps/desktop/src/workspaces/index.ts](../apps/desktop/src/workspaces/index.ts)) are deep-cloned and seeded into storage.
- `saveWorkspaces` runs after every edit so changes survive reload immediately — no explicit save button.
- `resetToBuiltins` re-seeds from source, used by the header "Reset all" button.

The `version: 1` envelope leaves room to migrate the schema later (e.g. when 2.4 introduces tile add/remove and 2.5 introduces user-named workspaces).

### Edit mode — [apps/desktop/src/App.tsx](../apps/desktop/src/App.tsx)

A new `editMode` boolean drives the experience:

- **Header gets an "Edit" button** (right side, next to the cursor clock). Toggles to "Done editing" when active. While active, a small "Reset all" button appears next to it for nuking edits back to defaults.
- **Tiles outline themselves** with a subtle ring; the selected tile rings in brand yellow.
- **A footer hint** (`· editing` in yellow) makes it obvious you're in edit mode.

### Tile selection — [apps/desktop/src/components/Tile.tsx](../apps/desktop/src/components/Tile.tsx)

In edit mode, each tile body gets a transparent `<button>` overlay that intercepts clicks and forwards them to `onSelect`. This deliberately blocks the underlying widget's pointer events — clicking a tile to configure it should not also scrub the cursor. Outside edit mode, the overlay is not rendered, so all the existing scrubbing/interactions work unchanged.

### ConfigPanel — [apps/desktop/src/components/ConfigPanel.tsx](../apps/desktop/src/components/ConfigPanel.tsx)

A right-side panel mirroring the [SessionPanel](../apps/desktop/src/components/SessionPanel.tsx) on the left. When a tile is selected in edit mode, this panel mounts the widget's own `ConfigEditor` — every widget already exports one (e.g. [bar-gauge/config-editor.tsx](../packages/widgets/src/bar-gauge/config-editor.tsx)), so the editor is essentially free.

Edits flow:

```
ConfigEditor.onChange(nextConfig)
  -> ConfigPanel.onChange({...tile, config: nextConfig})
  -> App.updateTile(workspaceId, nextTile)
  -> setWorkspaces(...)  // immutable update
  -> saveWorkspaces(next) // localStorage write
```

Auto-save: there is no commit/discard step. Every keystroke in the panel persists, which is the expected MoTeC-ish ergonomic and keeps the state model simple.

## What's intentionally NOT in this commit

- **Drag-to-reposition / resize tiles.** Tile geometry is still typed/edited via the position fields in workspace source. Phase 2.3.
- **Add / duplicate / delete tiles.** No "new tile" button yet. Phase 2.4.
- **Workspace CRUD.** You can edit existing workspaces but can't create new ones from the UI. Phase 2.5.
- **Per-user channel pickers.** `ConfigEditor`s currently use plain text inputs for channel ids. A proper picker that suggests channels from `store.list()` would be nicer; punted to keep this commit small.

## Files changed

- [apps/desktop/src/lib/workspace-storage.ts](../apps/desktop/src/lib/workspace-storage.ts) — new
- [apps/desktop/src/components/ConfigPanel.tsx](../apps/desktop/src/components/ConfigPanel.tsx) — new
- [apps/desktop/src/components/Tile.tsx](../apps/desktop/src/components/Tile.tsx) — added editMode/selected/onSelect props + click overlay
- [apps/desktop/src/App.tsx](../apps/desktop/src/App.tsx) — edit-mode state, tile selection, panel mount, persistence wiring, reset button
