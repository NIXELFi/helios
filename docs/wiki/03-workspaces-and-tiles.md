# Workspaces & tiles

A **workspace** is a named tile layout on a 24×16 grid. Each tile renders one widget. Helios ships with three workspaces and lets you create, rename, recolor, duplicate, delete, reorder, export, and import as many more as you want.

## Built-in workspaces

| ID | Label | Color | Focus |
| --- | --- | --- | --- |
| `overview` | Overview | gold #FFC627 | speed/RPM strip chart, lap panel, key gauges |
| `lap-analysis` | Lap Analysis | cyan #4FC3F7 | lap delta, sector table, distance-mode charts, lap & channel reports |
| `engine-focus` | Engine Focus | red #EF5350 | engine bar, RPM/throttle/temps/pressures |

The Lap Analysis layout updates itself on storage migration so new lap-analysis widgets (lap_delta in v2.4, sector_table in v2.5) appear automatically when you launch a newer build.

## The grid

24 columns × 16 rows = 384 cells. Positions and sizes are stored normalized to [0,1] internally and snapped to grid lines on save. Minimum tile size is 2×2 cells.

## Creating, renaming, recoloring

- **Create:** `＋ New` button at the right end of the tab strip. Auto-named "Workspace N", colored with the next unused palette color, dropped immediately into rename mode.
- **Rename:** double-click any tab to enter inline-edit mode. Enter commits, Escape cancels.
- **Recolor:** right-click a tab → **Color ▸**. Picks from the 8-color session palette.
- **Duplicate:** right-click → **Duplicate**. Deep-clones every tile (fresh UUIDs); inserts the copy immediately after the source.
- **Delete:** right-click → **Delete**. Confirm modal (the **Delete** button is danger-red). Disabled if only one workspace remains.
- **Reorder:** drag a tab horizontally. A yellow drop-indicator dot shows where it'll land.
- **Reset all:** edit mode → **⋯** → **Reset all workspaces**. Replaces every workspace with the built-in defaults (confirm modal).

## Tab strip overflow

Long lists scroll horizontally with a thin yellow custom scrollbar (50% opacity, hover 100%). The native scrollbar is hidden. `＋ New` and `⋯` stay pinned to the right and never scroll. The header height is fixed regardless of content — only the tab row scrolls.

## Switching workspaces

- Click a tab.
- **⌘1 … ⌘9** to jump by index.
- **⌘K** then type the workspace label.

## Edit mode

Toggle with **⌘E**, the header **Edit** button, or the palette ("Enter edit mode"). What changes:

- Grid overlay appears under the tiles.
- Each tile gets a drag handle (title bar) and a bottom-right resize chevron.
- Clicking a tile selects it (gold ring) and opens the right-side config panel.
- Header switches: Edit → **Done editing** (gold filled), and **＋ Add tile** / **⋯** menu appear.
- Workspace tabs, primary-session label, and most chrome hide so the toolbar focuses on editing.

### Adding a tile

**＋ Add tile** opens the widget palette — a 2-column grid of all widget types with the widget name, description, and default grid size. Click any to drop it into the next free slot. You can drag and resize it once placed.

### Editing a tile

Click a tile in edit mode to open its config in the right panel. The panel header has:

- A **widget-type dropdown** (lets you change a tile's type in place — keeping its position and size but resetting its config to the new widget's defaults).
- **Duplicate** — clones the tile next to itself.
- **Delete** — removes the tile (confirm).
- **×** — close the panel.

Each widget defines its own `ConfigEditor`. Strip Chart's editor lets you add/remove channels with per-channel color and Y-range. Round Gauge has min/max, decimals, warn/alarm thresholds. See the [widgets reference](04-widgets-reference.md) for every option.

### Snap to grid

Edit mode → **⋯** → **Snap to grid**. Rounds every tile's position and size to grid cells without changing the layout's logical structure. (This replaced an old "Auto-arrange" that destructively redistributed all tiles uniformly.)

## Share bundles — the `.helios` format

Workspaces are portable. Export one or all as a `.helios` file (a JSON blob with a stable schema):

```json
{
  "kind": "helios-workspace-bundle",
  "version": 1,
  "exportedAt": "2026-05-18T...",
  "exportedFrom": "Helios 3.2.1",
  "workspaces": [ { "id": "...", "label": "...", "color": "#...", "tiles": [...] } ]
}
```

- **Export one:** right-click tab → **Export…** → file picker. Default name `helios-workspace-<slug>.helios`.
- **Export all:** header **⋯** → **Export all workspaces…**. Default name `helios-workspaces.helios`.
- **Import:** header **⋯** → **Import workspaces…**, or drag a `.helios` file onto the window, or double-click a `.helios` file in Finder / Explorer.

### Import behavior

- Each imported workspace gets a fresh UUID (never reuse source IDs).
- Label collisions get suffixed with `" (imported)"`, `" (imported 2)"`, etc.
- The import is non-destructive: existing workspaces stay; the imported set is appended.
- After import, Helios jumps to the first imported workspace.

### Double-clicking `.helios` files

The Tauri shell registers `.helios` as a file type on macOS and Windows. When you double-click one:

1. If Helios isn't running, the OS launches it with the path as a CLI arg.
2. If Helios is already running, `tauri-plugin-single-instance` forwards the path to the existing window.
3. The frontend reads the file, validates it as a bundle, and shows a confirm modal: *"Import N workspaces from filename?"* with the list of labels inline (up to 8; more get a "...and N more" suffix).
4. Click **Import** to merge; **Cancel** to skip.

The share-bundle pattern is also the template for future CSV / math-channel sharing.

## Persistence

Workspaces save to `localStorage` under `helios.workspaces.v1` on every mutation. The current schema is **v5**, with auto-migrations from v1 through v4 (color field added, lap_analysis tile injection, sector_table addition). Old bundles work on new builds because of these migrations.

The active workspace ID, recent sessions, view state (cursor + zoom + datums per primary session), and lap selection live separately in `helios.app-state.v1`. Per-session lap config and channel overrides have their own per-session keys.

## Common workflows

### "I want a fresh blank workspace"

1. Click **＋ New** at the right of the tab strip.
2. Type a name, press Enter.
3. **⌘E** to enter edit mode.
4. **＋ Add tile** → click a widget type → repeat.

### "I want to share my layout with a teammate"

1. Right-click the tab → **Export…** → save the `.helios`.
2. Send it (Slack, email, attach to a PR).
3. They double-click it (or drag it onto Helios) → **Import**.

### "I broke a workspace; reset it"

Edit mode → **⋯** → **Reset all workspaces** rebuilds every workspace from the built-in defaults. (No per-workspace reset yet — you can delete and re-add via a built-in seed if you've duplicated one.)
