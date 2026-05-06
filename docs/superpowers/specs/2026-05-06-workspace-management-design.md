# Workspace Management — Design Spec

**Date:** 2026-05-06
**Owner:** Sun Devil Motorsports (ASU FSAE)
**Status:** Draft for review
**Target version:** 2.3.2 (do **not** tag/release as part of this work — `v*` tags trigger the GitHub Actions release pipeline)

## Summary

Make workspaces first-class user-managed objects. Today the workspace tab strip is a hardcoded array of two built-ins; users can edit tile contents but cannot create, rename, color, reorder, duplicate, delete, or share a workspace. This spec lifts those operations into the UI and adds an export/import bundle format so workspaces can be shared between teammates over email.

This is **Phase 1 of two**. Phase 2 (separate spec, not in this work) covers user-imported CSV sessions. The bundle format defined here is intended as a template that Phase 2 (and later math-channel sharing) will extend.

## Goals

- A user can create a new empty workspace by clicking a `+` button in the header.
- A user can rename, recolor, duplicate, reorder (drag), and delete any workspace.
- Tab colors come from the existing 8-swatch session palette and render as a small swatch dot on every tab; the active-tab highlight stays yellow.
- A user can right-click a tab to export it as a JSON file, and import any previously-exported workspace JSON via an `Import…` button. An `Export all…` button exports every current workspace in one bundle.
- Workspace state continues to persist via the existing `localStorage` mechanism, with a versioned migration from the current v1 blob to a v2 blob that includes color.
- All confirmation prompts use a custom in-app modal — no native `window.confirm()` anywhere in the desktop app after this change.

## Non-Goals (this phase)

- CSV / session import (Phase 2 — separate spec).
- Math-channel export / import (future, will reuse the bundle pattern).
- Per-tab icons or emoji.
- Keyboard shortcuts for tab switching.
- Workspace search or quick-switcher.
- Undo for delete (the confirmation dialog is the safety net).
- Reorder via menu entries (drag covers it).
- Freeform color picker.
- Per-workspace default session (workspaces stay session-agnostic).
- Smart merge / overwrite on re-import (every import appends; ids are regenerated; labels deduped).
- Sync / cloud / multi-device.
- Renaming the existing `Reset all` button.
- Toast / notification infrastructure.

## Tech additions

- `@tauri-apps/plugin-dialog` — native file save/open dialogs for export/import. Will also be needed in Phase 2 for CSV import; adding now amortizes the setup.
- Tauri-side capability entry to permit `dialog:default`.

No new JS dependencies (no DnD library, no UI primitive library). Drag-reorder uses HTML5 native drag-and-drop. The context menu is hand-rolled to match the codebase's existing style of hand-rolled modals.

---

## Data model

`Workspace` gains a required `color` field:

```ts
// apps/desktop/src/workspaces/types.ts
export interface Workspace {
  id: string;
  label: string;
  color: string;  // hex string from SESSION_PALETTE
  tiles: TileSpec[];
}
```

The on-screen tab order **is** the array order in `workspaces[]`. Reorder mutates the array; persistence uses the existing `saveWorkspaces` path.

### IDs

- New workspaces get a `crypto.randomUUID()`-based id.
- Built-in workspaces keep their semantic ids (`overview`, `engine-focus`) so existing v1 storage survives migration cleanly.
- **Imported workspaces always get fresh ids.** Source ids are never preserved on import — this avoids collisions with the importer's existing workspaces (including built-ins) and means importing your own export back creates a clone, not an overwrite.

### Built-ins

`apps/desktop/src/workspaces/index.ts` records the colors used at first launch:

| Workspace | Color |
|---|---|
| Overview | `#FFC627` (brand yellow) |
| Engine focus | `#EF5350` (red) |

These are deletable like any other workspace. `Reset all` reseeds them.

### Storage migration

`apps/desktop/src/lib/workspace-storage.ts` bumps the in-blob `version` field to `2`. The `localStorage` **key stays `helios.workspaces.v1`** — only the blob shape changes. (The `v1` in the key is historical; bumping the key to `v2` would orphan the existing user data unless we still read from the old key, so it's simpler to keep the key and discriminate on the in-blob version field.)

- v2 blob → loaded as-is.
- v1 blob → for each workspace, fill in `color` from `SESSION_PALETTE[i % 8]` indexed by array position; rewrite the blob (same key) as v2.
- Missing or corrupt blob → seed from built-ins (current behavior).

---

## UI affordances

### Tab strip

In [apps/desktop/src/App.tsx:218-236](apps/desktop/src/App.tsx#L218-L236), today's inline tab map is extracted into a new `<WorkspaceTabBar>` component. Each tab renders:

- An 8×8 px swatch dot in `workspace.color`, on the left.
- The label, editable inline. **Double-click** to enter edit mode (`<input>` replaces the label); Enter or blur commits, Esc cancels. Empty / whitespace-only commit is treated as cancel.
- Active-tab styling (yellow background + border) unchanged from today.
- `draggable` for reorder (disabled while inline-rename is open).
- Right-click → opens `<TabContextMenu>` anchored at the cursor coords.

### Header buttons (always visible)

To the right of the tab list, three small buttons styled to match today's `+ Add tile` button:

```
[ tabs… ]   + New workspace    Import…    Export all…
```

- `+ New workspace` — creates `{ id: uuid, label, color, tiles: [] }`, appends, switches to it. Auto-naming uses the next free `Workspace N` where N is the lowest positive integer such that no current workspace has that label.
- `Import…` — opens Tauri save/open dialog filtered to `*.json`; on file pick, validates and merges (see Import flow below).
- `Export all…` — opens Tauri save dialog with default filename `helios-workspaces.json`; writes a bundle containing every current workspace.

### `<TabContextMenu>` items

1. **Rename** — same effect as double-click.
2. **Color ▸** — submenu with the 8 palette swatches; click sets `workspace.color` and persists. Submenu opens to the right of the parent menu by default; if it would overflow the viewport horizontally, it flips to open on the left. Same vertical-overflow handling for the parent menu (flips above the click point if too close to the bottom).
3. **Duplicate** — deep-clones the workspace (new uuid, label `<source> copy`, same color, tiles deep-cloned), inserts immediately after the source, switches to the duplicate.
4. **Export…** — opens Tauri save dialog with default filename `helios-workspace-<slug>.json`; writes a single-workspace bundle.
5. **Delete** — opens `<ConfirmDialog>`. **Disabled (greyed)** when only one workspace remains.

The menu closes on item-click, Esc, outside-click, or right-click on a different tab (which opens a fresh menu at the new coords).

### `<ConfirmDialog>` component

A new reusable hand-rolled modal at `apps/desktop/src/components/ConfirmDialog.tsx`, styled to match existing modals (`ChannelsModal`, `MathChannelsModal`, `UpdateModal`, `AddTileModal`).

Props:

```ts
interface ConfirmDialogProps {
  title: string;
  body: string | ReactNode;
  confirmLabel: string;
  confirmTone: "default" | "danger";  // danger = red button
  cancelLabel?: string;               // omit to render as alert (single button)
  onConfirm: () => void;
  onClose: () => void;                // also fired by alert button when cancel is omitted
}
```

When `cancelLabel` is omitted, the dialog renders in **alert mode**: only the confirm button is shown, and clicking it (or pressing Enter / Esc) fires both `onConfirm` and `onClose`. This is the variant used for import-failure errors — one component, two visual modes, no separate `AlertDialog` needed.

Behavior:

- Esc closes (calls `onClose`).
- Backdrop click closes.
- Enter on the focused confirm button fires `onConfirm`.
- Focus traps on the confirm button on open.
- `App.tsx` holds `confirmState: ConfirmRequest | null` and renders one `<ConfirmDialog>` slot. Setters open/close it.

This component **also replaces** the existing `window.confirm()` call in `handleResetWorkspaces` ([App.tsx:181](apps/desktop/src/App.tsx#L181)) so the app has one consistent confirmation pattern after this change.

### Drag-reorder mechanics

HTML5 native drag-and-drop:

- `dragstart` on a tab → set drag data (workspace id), apply `opacity-50`.
- `dragover` on the tab strip → compute insertion gap by mouse-x against tab midpoints; render a 2 px yellow vertical bar at that gap.
- `drop` → splice the dragged workspace out of its current index, insert at the computed index; persist.
- `dragend` → clear all drag styling and gap indicator.
- Drop in the same gap or onto the dragged tab itself is a no-op.
- Tabs are not draggable while inline-rename is active.

---

## Component structure & state flow

### New files

```
apps/desktop/src/
  components/
    WorkspaceTabBar.tsx       ← tab strip + + New / Import / Export all + drag-reorder
    TabContextMenu.tsx        ← positioned right-click menu (incl. Color submenu)
    ConfirmDialog.tsx         ← reusable confirmation modal
  lib/
    workspace-bundle.ts       ← serializeBundle / parseBundle / mergeImported (pure)
    workspace-storage.ts      ← (modified) bump to v2, add migration
  workspaces/
    types.ts                  ← (modified) +color field
    index.ts                  ← (modified) +color on built-ins
```

### State stays in App.tsx

Workspaces are already lifted to `App.tsx`. No new global stores; no `zustand` additions. New callbacks added there and threaded into `<WorkspaceTabBar>`:

```ts
onCreateWorkspace()
onRenameWorkspace(id, label)
onRecolorWorkspace(id, color)
onDuplicateWorkspace(id)
onDeleteWorkspace(id)                    // funnels through ConfirmDialog
onReorderWorkspaces(fromIndex, toIndex)
onExportWorkspace(id)                    // single-workspace bundle
onExportAllWorkspaces()                  // multi-workspace bundle
onImportWorkspaces()                     // open file dialog, validate, append
```

Every mutator funnels through the existing `commitWorkspaces(updater)` helper at [App.tsx:118-124](apps/desktop/src/App.tsx#L118-L124) so persistence + functional-state-update behavior matches the existing `updateTile` / `deleteTile` paths.

### Local component state

`<WorkspaceTabBar>` owns:

- which tab (if any) is being inline-renamed
- current context-menu anchor (`{ workspaceId, x, y }` or null)
- in-flight drag state

`<TabContextMenu>` is a positioned `<div>` (no portal) that closes on Esc / outside-click / item-click.

---

## Export / import bundle

### File format

```json
{
  "kind": "helios-workspace-bundle",
  "version": 1,
  "exportedAt": "2026-05-06T18:30:00.000Z",
  "exportedFrom": "Helios 2.3.2",
  "workspaces": [
    {
      "id": "...",
      "label": "Driver tryout",
      "color": "#FFC627",
      "tiles": [ /* TileSpec[] as in workspaces */ ]
    }
  ]
}
```

A wrapper object with a `workspaces` **array** so the importer doesn't care whether the file was exported from a single tab or from `Export all…`. `version: 1` lets future formats migrate cleanly. `kind` lets the importer reject non-Helios JSON files with a friendly error.

`exportedFrom` is sourced from the running app's version (the same `package.json` version surfaced via Vite's `__APP_VERSION__` define or `@tauri-apps/api`'s `getVersion()`); never hardcoded, so the field stays accurate as the app's version drifts.

### Pure functions in `workspace-bundle.ts`

```ts
serializeBundle(workspaces: Workspace[]): string
parseBundle(json: string): { ok: true; bundle: Bundle } | { ok: false; reason: string }
mergeImported(existing: Workspace[], imported: Workspace[]): Workspace[]
  // For each imported: assign new uuid; if label collides, suffix " (imported)"
  // (then "(imported 2)", etc.); append to existing.
```

These are unit-testable without the UI.

### Tauri dialog wiring

`apps/desktop/src-tauri/capabilities/default.json` adds `dialog:default` to its permissions. (Note path: `src-tauri/`, not `src/src-tauri/`.) New TS helper in `lib/workspace-bundle.ts` (or a sibling) wraps `@tauri-apps/plugin-dialog`'s `save()` and `open()` with the right filters and default filenames.

### Filename conventions

- Single workspace: `helios-workspace-<slug>.json` where `<slug>` is `workspace.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")` (with a fallback to `workspace` if the slug is empty).
- All workspaces: `helios-workspaces.json`.

### Import flow

1. User clicks `Import…` → Tauri open dialog (filter: `JSON files (*.json)`).
2. Read file as text. Parse via `parseBundle`. On `ok: false` → render an error variant of `<ConfirmDialog>` (or a small alert-style modal) with the reason; nothing else happens.
3. On `ok: true` → call `mergeImported(existing, bundle.workspaces)`, persist, switch to the first imported workspace.

### Validation rules

`parseBundle` rejects any of:

- File doesn't parse as JSON.
- `kind !== "helios-workspace-bundle"`.
- `version !== 1`.
- `workspaces` is missing, not an array, or empty.
- Any workspace in the array is missing required fields (`id`, `label`, `color`, `tiles`) or has `tiles` of the wrong shape (basic shape check — does not deep-validate widget configs).

---

## Edge cases (summary)

| Case | Behavior |
|---|---|
| Delete only remaining workspace | Delete menu item disabled; confirm dialog never shown |
| Inline-rename committed empty / whitespace-only | Treat as cancel — restore prior label |
| Active workspace is deleted | Switch to neighbor (next, then prev, then first) before splicing |
| Drag tab onto itself / drop in same gap | No-op; nothing persisted |
| Drag during inline-rename | `draggable={false}` while renaming |
| Context menu open + click another tab | Existing menu closes, new one opens |
| Context menu open + Esc / outside-click | Closes |
| Import file lacks `kind` / wrong `version` | Friendly error modal; nothing mutated |
| Import file with zero workspaces in array | Treated as malformed (same path) |
| Imported label collides | Suffix ` (imported)`, `(imported 2)`, etc. |
| Imported id collides | Always regenerated on import |
| Storage write fails (quota) | Caught in `saveWorkspaces`; out of scope to surface differently |
| v1 storage blob loaded on v2 build | Migration fills colors per `SESSION_PALETTE`; rewrites as v2 |

---

## Testing

### Unit tests (vitest)

- **`workspace-storage.test.ts`** — v1→v2 migration assigns colors by palette index; v2 round-trip preserves shape; corrupt blob falls back to built-ins.
- **`workspace-bundle.test.ts`** — `serializeBundle` produces the documented shape; `parseBundle` rejects each malformed-input class with a useful reason; `mergeImported` regenerates ids and de-duplicates labels (including chained `(imported 2)`).
- **`WorkspaceTabBar.test.tsx`** — renders tabs, click selects, double-click enters rename, Enter commits, Esc cancels, `+ New workspace` appends-and-switches, drag from one index to another reorders correctly, right-click opens context menu and Esc closes it.
- **`ConfirmDialog.test.tsx`** — renders title/body, confirm fires `onConfirm`, cancel/Esc fires `onClose`, `confirmTone="danger"` applies the red styling class.

### Manual smoke test plan

To be logged in `v2_changes/NN-workspace-management.md` per the project's logging convention. Steps:

1. Open app fresh → built-ins show with their assigned colors (yellow Overview, red Engine focus).
2. Click `+ New workspace` → "Workspace 1" appears, switched-to, empty (the auto-namer picks the lowest free `Workspace N` — built-in labels don't match that pattern, so N=1 on first click).
3. Double-click new tab, type "Test", Enter → label persists across reload.
4. Right-click new tab → Color → green → swatch turns green; reload → still green.
5. Drag "Test" between Overview and Engine focus → order persists across reload.
6. Right-click "Test" → Duplicate → "Test copy" appears next to it.
7. Right-click "Test copy" → Export… → save to disk; open the JSON, verify `kind`, `version: 1`, single workspace.
8. Right-click "Test copy" → Delete → custom dialog confirms; on confirm, gone.
9. Click `Import…` → load step-7 file → "Test" reappears (no id collision); reload → still there.
10. Click `Export all…` → bundle contains every current workspace.
11. Try to delete the last remaining workspace → Delete menu entry is greyed out.
12. Click `Reset all` → uses the new `<ConfirmDialog>` (not browser `confirm()`); on confirm, reseeds built-ins with their colors.

---

## Out-of-scope reminders

CSV / session import is Phase 2 and will reuse the dialog plumbing and bundle pattern landed here. Math-channel sharing is later still. The `helios-workspace-bundle` `kind` discriminator leaves room for a future `helios-bundle` super-format that nests multiple artifact arrays (workspaces + sessions + math) once all three pieces are export-capable.
