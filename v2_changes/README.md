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
| 17 | Color edits in the config panel didn't reach the canvas | [17-config-color-not-applied.md](17-config-color-not-applied.md) |
| 18 | Loading screen + Helios brand wordmark | [18-loading-screen-and-brand.md](18-loading-screen-and-brand.md) |
| 19 | GPS basemap (CARTO dark / Esri satellite / custom) | [19-gps-basemap.md](19-gps-basemap.md) |
| 20 | MoTeC ADL int32-as-uint32 GPS micro-degrees decode | [20-motec-gps-int32-decode.md](20-motec-gps-int32-decode.md) |
| 21 | Steering Wheel widget | [21-steering-wheel-widget.md](21-steering-wheel-widget.md) |
| 22 | Playback controls (▶ / pause / 0.25–8× speed) | [22-playback-controls.md](22-playback-controls.md) |
| 23 | Per-channel Y axis on the strip chart + clip / legend / color-swatch fixes | [23-strip-chart-per-channel-axis.md](23-strip-chart-per-channel-axis.md) |
| 24 | Auto-labeled turns and straights on the GPS view | [24-track-labels.md](24-track-labels.md) |
| 25 | User-managed workspaces (CRUD, color, reorder, export/import) | [25-workspace-management.md](25-workspace-management.md) |
| 26 | Workspace UX polish — tab-strip horizontal scroll + .helios launch handler | [26-workspace-ux-polish.md](26-workspace-ux-polish.md) |
| 27 | XY analysis plot — overlay system (scatter / fit / formula / bins / stats / quadrant-fit) + filter / group-by / zoom integration | [27-xy-analysis-plot.md](27-xy-analysis-plot.md) |
| 28 | 2.4.0 polish bundle — global datums/zoom, custom tab scrollbar, edit-mode header focus, FpsCounter, panther app icon, real steering wheel art, version-pill fix, macOS overscroll fix | [28-2.4.0-polish-bundle.md](28-2.4.0-polish-bundle.md) |
| 29 | 2.4.1 — histogram split-at + zoom integration; math palette `[id]` auto-wrap; per-session math errors | [29-2.4.1-histogram-and-math.md](29-2.4.1-histogram-and-math.md) |
| 30 | 2.5.0 i2-parity pass — laps as first-class, distance-axis strip chart, channel/time/zone reports, FFT, CSV + KML export | [30-i2-parity-laps-distance-reports-fft-export.md](30-i2-parity-laps-distance-reports-fft-export.md) |
| 31 | 2.5.1 — add / remove / drag-drop user-loaded CSV sessions; Link ECU CSV preamble | [31-add-remove-drag-drop-sessions.md](31-add-remove-drag-drop-sessions.md) |
| 32 | 2.5.2 — smart channel resolver with semantic matching gated by source units; six new canonical channels | [32-smart-channel-resolver-motec-link.md](32-smart-channel-resolver-motec-link.md) |
| 33 | 2.5.3 — split `engine.tps` / `engine.aps` (+ `_sub` variants); loader collision protection | [33-tps-aps-split-and-collision-protection.md](33-tps-aps-split-and-collision-protection.md) |
| 34 | 3.2.2 — full user + developer wiki under `docs/wiki/` and in-app Help & Wiki modal (F1, ⌘K, header) | [34-wiki-and-in-app-help.md](34-wiki-and-in-app-help.md) |
| 35 | CFD tab Phases 1+2 — engine-sim Rust port + tab scaffold + 27 new parity fixtures + full SDM26 config editor (save/save-as, validation, Cd-table + pipe-array editors, topology switch, templates, side-by-side diff) | [35-cfd-tab-phases-1-2.md](35-cfd-tab-phases-1-2.md) |

> **Wiki:** see [`docs/wiki/`](../docs/wiki/) for the consolidated user + developer guide.

## New behaviors introduced

- **Click + drag scrubbing** is now a feature on every data-point-bearing plot:
  - **Strip chart** — click/drag anywhere on the plot to set time (uPlot-coord-aware, so the yellow line lands exactly under the pointer).
  - **GPS track** — click/drag to jump to the nearest GPS sample by Euclidean distance in canvas pixels.
  - **XY plot** — click/drag to jump to the nearest sample in xy-space.
- The **global mouse-move cursor** has been removed. The cursor only updates when the user clicks/drags on a scrubbable plot.
