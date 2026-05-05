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

## New behaviors introduced

- **Click + drag scrubbing** is now a feature on every data-point-bearing plot:
  - **Strip chart** — click/drag anywhere on the plot to set time (uPlot-coord-aware, so the yellow line lands exactly under the pointer).
  - **GPS track** — click/drag to jump to the nearest GPS sample by Euclidean distance in canvas pixels.
  - **XY plot** — click/drag to jump to the nearest sample in xy-space.
- The **global mouse-move cursor** has been removed. The cursor only updates when the user clicks/drags on a scrubbable plot.
