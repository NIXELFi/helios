# Keyboard & commands

## Command palette

The fastest way to drive Helios: **⌘K** (Mac) or **Ctrl+K** (Windows / Linux) — or click the **⌘K** pill in the header.

The palette filters across **workspace**, **session**, **lap**, and **system** actions with a fuzzy-rank score:

- 100 — exact match
- 80 — prefix
- 50 — substring
- 25 — subsequence

Up to 30 results show; longer lists display the total count at the bottom.

Navigation: **↑↓** select, **Enter** run, **Esc** close. Each result row shows the kind (color-coded badge), a primary label, optional sublabel, and a keyboard hint where one exists (e.g. **⌘1**).

### Built-in actions

| Kind | Examples |
| --- | --- |
| **Workspace** (gold) | `Switch to Overview` · `Switch to Lap Analysis` (with `⌘1`, `⌘2`, … hints) |
| **Session** (cyan) | `Set primary: <session name>` (one entry per loaded CSV) |
| **System** (dim) | `Open Channels` · `Open Math channels` · `Add tile…` · `Enter/Exit edit mode` (`⌘E`) · `Keyboard shortcuts` (`?`) · `Reset zoom` · `Clear datums` · `Drop datum at current cursor` · `Zoom to current lap` |
| **Lap** (orange) | `Set best lap as Main` · `Set 2nd-best lap as Ref` · `Swap Main and Ref` · `Clear Ref lap (hide Δt)` · `Set lap 5 as Main` (one per lap, capped at 30) |

The action list is rebuilt from current app state on every render, so it always reflects what's actually loaded.

## Hotkeys

All single-key bindings ignore form inputs (`INPUT`, `TEXTAREA`, `SELECT`) so typing isn't intercepted.

### Global

| Key | Action |
| --- | --- |
| **⌘K** / **Ctrl+K** | Toggle command palette |
| **⌘1 … ⌘9** | Switch to workspace N by index |
| **⌘E** | Toggle edit mode |
| **⌘O** | Open file dialog (add CSV sessions) |
| **?** | Show keyboard-shortcuts overlay |
| **Esc** | Close any open modal |

### Playback & cursor

| Key | Action |
| --- | --- |
| **Space** | Play / pause cursor animation |
| **`[`** | Jump cursor to start of previous lap (primary session) |
| **`]`** | Jump cursor to start of next lap (primary session) |
| **M** | Set lap containing cursor as Main |
| **R** | Set lap containing cursor as Ref |

### Strip chart & XY plot

| Action | Result |
| --- | --- |
| Click | Scrub cursor to that time / point |
| Shift+Click | Drop a datum marker |
| Shift+Drag | Zoom to drawn range |
| Double-click | Reset zoom |

### Sessions panel — lap rows

| Action | Result |
| --- | --- |
| Plain click on row | Set as Main |
| ⌘/Ctrl-click on row | Set as Ref |
| Shift-click on row | Toggle Overlay |
| **M** / **R** / **O** buttons | Same three actions, explicit |

## Shortcuts overlay

Press **`?`** anywhere to open the keyboard-shortcuts reference modal. It's a static cheat sheet of every binding above, organized by group (Workspace, Cursor & laps, Strip chart). Escape closes.

## Accessibility

Helios's accessibility passes (commit `5e1ac5a` + ongoing):

- **WCAG AA text contrast** on body and dim text (4.5:1 minimum).
- `role="dialog"` + `aria-modal="true"` on every modal:
  Command Palette, Shortcuts Overlay, Update Modal, Add Tile, Channels, Math Channels, Lap Config, Confirm Dialog.
- `aria-label` (or `aria-labelledby`) provided on every modal outer div.
- `aria-pressed` on toggle buttons (M / R / O).
- `aria-current="page"` on the active module rail tab.
- `prefers-reduced-motion: reduce`:
  - Loading-screen shimmer animation → off (bar still fills).
  - UpdatesPill pulse → off (visibility unchanged).
- Confirm dialog auto-focuses its confirm button.
- Command palette auto-focuses its search input.
- Esc closes any focused modal.

### Known gap

A focus trap inside modals is on the [UI follow-ups](../ui-audit-followups.md) list (task T1.10a). Tab can currently still escape from a modal into the dimmed background. Planned fix: a shared `<Modal>` primitive with `useFocusTrap`.

## Tauri title-bar overlay

Helios renders its own header instead of the native OS title bar (`tauri.conf.json`: `titleBarStyle: "Overlay"`, `hiddenTitle: true`, `trafficLightPosition: { x: 14, y: 14 }`).

- **macOS** — native traffic lights (red / yellow / green) inset 14 px from the top-left. The 56-px module rail leaves them clear room.
- **Windows** — custom min/max/close buttons drawn in the same area.

The 40-px header is a Tauri drag region everywhere except interactive controls — drag anywhere to move the window.

## Settings / preferences

The Logs module has no dedicated Settings screen. Configuration is per-area:

- **Layouts** — workspace tabs & the edit-mode toolbar.
- **Channel mapping** — Channel inspector → Source override popover.
- **Lap detection** — per-session Lap Config dialog.
- **Math channels** — ƒ Math editor.
- **Recent files & view state** — implicit, persisted to `localStorage`.

The **Vault** module has its own Settings screen (`SettingsScreen.tsx`):

- Display signed-in email & role (read-only).
- Pick the local vault folder.
- Sign out.

Keyboard bindings are not remappable from the UI — they're hard-coded in [`apps/desktop/src/App.tsx`](../../apps/desktop/src/App.tsx) lines 210-304. Adding a Settings modal with binding overrides is on the future-enhancements list.

## FPS counter

Always on, in the footer-right:

```
55fps / 18ms
```

Color-coded: green ≥ 55 fps, gold 30–54, red < 30. The ms number is the worst frame in the last 500 ms. No toggle.

## Reference files

| File | Role |
| --- | --- |
| [`apps/desktop/src/App.tsx`](../../apps/desktop/src/App.tsx) ~210-304 | Global key handler. |
| [`apps/desktop/src/App.tsx`](../../apps/desktop/src/App.tsx) ~397-532 | Palette action registry (rebuilt per render). |
| [`apps/desktop/src/components/CommandPalette.tsx`](../../apps/desktop/src/components/CommandPalette.tsx) | Palette UI + ranking. |
| [`apps/desktop/src/components/ShortcutsOverlay.tsx`](../../apps/desktop/src/components/ShortcutsOverlay.tsx) | Cheat sheet. |
| [`apps/desktop/src/styles.css`](../../apps/desktop/src/styles.css) | `prefers-reduced-motion` rules. |
| [`apps/desktop/src-tauri/tauri.conf.json`](../../apps/desktop/src-tauri/tauri.conf.json) | Title-bar overlay config. |
