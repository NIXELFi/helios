# v2 Changes

Running log of issues found in the running UI and the fixes applied. One file per issue.

## Index

| # | Issue | File |
| - | - | - |
| 01 | Cursor follows mouse everywhere instead of being click-driven (MoTeC-style) | [01-cursor-auto-scroll.md](01-cursor-auto-scroll.md) |
| 02 | Yellow cursor line doesn't align with the mouse pointer | [02-cursor-misalignment.md](02-cursor-misalignment.md) |
| 03 | UI lags and glitches when scrubbing | [03-scrub-performance.md](03-scrub-performance.md) |
| 04 | Scrubbing the strip chart didn't update other widgets | [04-strip-chart-fractional-microseconds.md](04-strip-chart-fractional-microseconds.md) |
| 05 | Loading real MoTeC CSV exports (alias map + metadata-block preprocessor) | [05-real-motec-data.md](05-real-motec-data.md) |
| 06 | In-app sample switcher for bundled CSVs | [06-sample-switcher.md](06-sample-switcher.md) |
| 07 | Workspace switcher (phase 1 of view editing) | [07-workspace-switcher.md](07-workspace-switcher.md) |
| 08 | Multi-session overlay (phase A: panel + strip-chart overlay) | [08-multi-session-overlay-phase-a.md](08-multi-session-overlay-phase-a.md) |
| 09 | Widgets didn't resize when their tile changed size | [09-widget-resize-observer.md](09-widget-resize-observer.md) |
| 10 | Multi-session overlay phase B (GPS, XY, histogram) | [10-multi-session-overlay-phase-b.md](10-multi-session-overlay-phase-b.md) |
| 11 | Edit mode + tile config editor (phase 2.1 + 2.2 of view editing) | [11-edit-mode-and-config-editor.md](11-edit-mode-and-config-editor.md) |
| 12 | Channel pickers + Channels inspector modal | [12-channel-pickers-and-inspector.md](12-channel-pickers-and-inspector.md) |
| 13 | Layout editor: drag, resize, add, duplicate, delete, auto-arrange | [13-layout-editor.md](13-layout-editor.md) |
| 14 | Snap-to-grid (replacing destructive auto-arrange) + change widget type | [14-snap-to-grid-and-type-swap.md](14-snap-to-grid-and-type-swap.md) |
| 15 | Math channels (phase A: engine + storage + apply + UI) | [15-math-channels-phase-a.md](15-math-channels-phase-a.md) |
| 16 | Math channels phase B: time ops + drag-and-drop palette | [16-math-channels-phase-b.md](16-math-channels-phase-b.md) |

## New behaviors introduced

- **Click + drag scrubbing** is now a feature on every data-point-bearing plot:
  - **Strip chart** — click/drag anywhere on the plot to set time (uPlot-coord-aware, so the yellow line lands exactly under the pointer).
  - **GPS track** — click/drag to jump to the nearest GPS sample by Euclidean distance in canvas pixels.
  - **XY plot** — click/drag to jump to the nearest sample in xy-space.
- The **global mouse-move cursor** has been removed. The cursor only updates when the user clicks/drags on a scrubbable plot.
