# App tour

Helios is a single window divided into six regions: module rail, sessions sidebar, header, main canvas, optional right config panel (only in edit mode), and footer.

## Module rail

The 56-px-wide rail on the far left switches between Helios's two top-level modules:

- **Logs** — data-log analysis. The default and what most users live in.
- **Vault** — cloud-backed file storage (Supabase). Marked **NEW** with an ASU-maroon pill.

Modules are mount-once: the first time you click a tab, the module loads and stays mounted; the rail just toggles visibility. So switching tabs is instant and you never lose session state.

See [Modules: Vault & Logs](09-modules-vault-logs.md) for what each module contains.

## Sessions sidebar

Lives on the left at 240 px wide. Collapsible via the `‹` chevron in the header. One row per loaded CSV:

- **Checkbox** — toggles visibility. Hidden sessions stay loaded in memory but drop out of multi-session overlays.
- **Color swatch** — drawn from `SESSION_PALETTE` (8 colors: #FFC627, #4FC3F7, #66BB6A, #EF5350, #BA68C8, #FFB800, #9CCC65, #26A69A). Used as the trace color in every multi-session widget.
- **Label** — the file's name without extension.
- **"PRIMARY" badge** — gold pill marking the active primary session. Click any visible row to promote it. There is always exactly one primary.
- **×** (on hover) — remove. Opens a confirm modal. For user-loaded files, "the file stays on disk; it just leaves this Helios session." For bundled samples, "it will reappear on next launch."
- **▶ / ▼ expander** — opens lap detection details: mode, lap count, best lap time, and a **Configure lap detection…** button.

Below an expanded session: the **lap list table**. Each row shows lap #, duration, delta vs best, and three buttons:

- **M (Main)** — gold #FFC627. The primary lap of interest.
- **R (Ref)** — cyan #4FC3F7. The lap to compare against.
- **O (Overlay)** — green #9CCC65. Add to a multi-lap overlay (can be many).

You can also use modifier-clicks on the row itself: plain click → Main, **⌘/Ctrl-click** → Ref, **Shift-click** → toggle Overlay.

Sidebar footer: *"Drag CSVs anywhere to add. + to browse."*

## Header

40 px tall, custom-drawn (Tauri title-bar overlay; no native OS chrome). Drag-region across the whole header — drag anywhere to move the window.

Left to right:

| Element | What it does |
| --- | --- |
| **HELIOS** wordmark | Orbitron 900, gold #FFC627. Branding. Drag region only. |
| Primary session label | Trimmed to 160 px. Hidden in edit mode. |
| Workspace tabs | Click to switch; double-click to rename inline; right-click for the context menu (rename, recolor, duplicate, export, delete). Drag tabs to reorder. Long lists scroll horizontally with a thin yellow scrollbar; `+ New` and `⋯` (overflow) buttons stay pinned right. |
| **⌘K** pill | Opens the [command palette](08-keyboard-and-commands.md#command-palette). |
| **Channels** | Opens the Channel inspector modal. Search/filter every resolved channel; click "Source" to remap to a different CSV column. |
| **ƒ Math (N)** | Opens the [math channels editor](06-math-channels.md). Count in parens. Red border if any math channel failed to compile. |
| **Export ▾** | Dropdown: CSV (primary, full), CSV (primary, zoom range), KML (GPS path). |
| **Edit / Done editing** | Toggles workspace edit mode (also **⌘E**). |
| **＋ Add tile** | *(edit mode only)* Opens the widget palette. |
| **⋯** | *(edit mode only)* Snap to grid, Reset all workspaces. |
| **Reset zoom** pill | *(when zoomed)* Restores full data extent. Or double-click any strip chart. |
| **Clear datums (N)** pill | *(when datum markers exist)* Removes all of them. |
| **Playback ▶ / ❚❚** | Toggle play/pause. Also **Space**. |
| Speed selector | 0.25× / 0.5× / 1× / 2× / 4× / 8×. |
| Updates pill | "Up to date", "Available", "Downloading…", or "Offline". Click for the [updater modal](#updater). |
| Cursor clock | Current cursor time, monospace, `H:MM:SS.cs`. |

## Main canvas

The active workspace's tiles. In view mode they're statically positioned; in edit mode they show a grid overlay, a drag handle, a resize chevron, and a yellow selection ring. See [Workspaces & tiles](03-workspaces-and-tiles.md).

## Right config panel (edit mode only)

When you click a tile in edit mode, the right side of the canvas grows a 288-px panel showing that tile's `ConfigEditor` plus **Duplicate** / **Delete** / **Close** buttons in the header. Each widget defines its own config editor; see the [widgets reference](04-widgets-reference.md).

## Footer

24-px status strip. Format:

```text
X session(s) visible · primary: Y channels · range Zs · N tile(s)
  [· Main M:MM.cc · Ref M:MM.cc · Δ ±S.cc]   [editing]   AAA fps / XX ms
```

Lap-compare segment only appears when both Main and Ref laps are set. Δ is colored green if Main is faster, red if slower, gray if within ±5 ms. FPS pill is color-coded: green ≥55, gold 30–54, red <30.

## Modals

All modals share these traits: 60 %-black backdrop with 2 px blur, `role="dialog"`, `aria-modal="true"`, Escape to close. **No browser `alert`/`confirm`/`prompt` is ever used** — everything is a custom React component.

| Modal | Opens via |
| --- | --- |
| Command palette | ⌘K |
| Channel inspector | header **Channels** button |
| Math channels editor | header **ƒ Math** button |
| Add tile | header **＋ Add tile** (edit mode) or palette → "Add tile…" |
| Lap config | sidebar → expand session → "Configure lap detection…" |
| Shortcuts overlay | **`?`** from anywhere |
| Update modal | Updates pill in header |
| Confirm dialog | delete / reset / replace flows (reusable component) |

## Updater

Helios ships with `tauri-plugin-updater`. On launch, it fetches `https://github.com/NIXELFi/helios/releases/latest/download/latest.json` and compares versions. If newer:

- The Updates pill flips from gray ("up to date") to orange ("Available").
- Clicking opens the **Update modal**: new version, release date, release notes (monospaced, scrollable), and **Install and restart** / **Remind me later** buttons.
- If playback is running it'll prompt you to pause first.
- After confirm, the updater downloads + verifies the minisign signature + relaunches.

If offline, the pill turns blue and just says "Offline."

## Loading screen

Shown on every launch while sessions are loaded — both bundled samples (on first run) and any of your own files in the recent-sessions list:

- Large **HELIOS** wordmark (Orbitron 900, gold).
- Subtitle "Sun Devil Motorsports · Ground Station".
- 520 × 1.5 px progress bar with a sliding shimmer overlay (`prefers-reduced-motion: reduce` disables the shimmer).
- Stage label: "Loading [Session Name] X/Y…"
- Footer: "v{version} · ground-station".

Sessions load sequentially so progress is observable; if one fails the loader shows a red banner and continues. Missing user files (paths that no longer exist) are silently dropped from the recent list rather than blocking startup.

## Theme & accessibility

Helios is dark-theme-only. The palette lives in [`apps/desktop/tailwind.config.ts`](../../apps/desktop/tailwind.config.ts):

| Token | Hex | Use |
| --- | --- | --- |
| `helios-base` | #0E0E10 | window background |
| `helios-panel` | #16171B | cards, panels |
| `helios-line` | #2A2C32 | borders |
| `helios-text` | #D8DCE2 | body text |
| `helios-dim` | #9097A0 | muted / secondary |
| `asu-gold` | #FFC627 | accent, active state, brand |
| `asu-maroon` | #8C1D40 | NEW badges, secondary accent |

Accessibility passes already shipped:

- WCAG AA text contrast on body and dim text.
- `aria-modal="true"` + `aria-label` (or `aria-labelledby`) on every modal.
- `aria-pressed` on toggle buttons (M/R/O).
- `aria-current="page"` on the active module rail tab.
- `prefers-reduced-motion: reduce` disables the loading-screen shimmer and the UpdatesPill pulse.

A focus trap inside modals is on the [UI follow-ups](../ui-audit-followups.md) list and not yet implemented — Tab can still escape into the dimmed background.
