# 27 — XY Analysis Plot

**Version:** 2.4.0
**Date:** 2026-05-06

## What

Upgraded the `xy_plot` widget from a fixed scatter into a fully composable analysis tool inspired by MoTeC i2's analysis screens. Added:

- **Simple ↔ Advanced** mode toggle. Simple keeps the existing behaviour (just channels + bounds + color + trail). Advanced unlocks everything below.
- **Six overlay kinds** combinable in any order:
  - `scatter` — the base point cloud (always present after migration of legacy configs).
  - `fit` — best-fit overlays: linear, polynomial degree 1–6, exponential, logarithmic, power. Optional ±σ confidence band; optional extrapolation past the observed X range.
  - `formula` — free-form `y = f(x)` curve typed by the user; uses the existing math-expr engine.
  - `bins` — empirical lookup curve. Equally-spaced bins along X; pick mean / median / p25–p75 band.
  - `stats` — corner-anchored selectable HTML panel with count, mean X/Y, stddev X/Y, correlation r, plus R² + equation read from a referenced fit overlay.
  - `quadrant-fit` — runs four independent regressions split at axis zero; killer feature for damper analysis (bump vs rebound have very different shapes).
- **Filter expression** — math-expr formula evaluated per-sample; samples where the result is falsy are excluded from every overlay.
- **Group-by channel** — distinct values become separate scatter colors and (optionally) per-group fits.
- **Zoom integration** — when the global zoom range is set, only samples whose timestamp falls inside the window enter the plot.

## Why

The simple XY plot covered "see two channels against each other" but nothing past it. Real motorsport analysis (suspension damper curves, tire grip studies, engine maps, driver consistency) all want regression overlays, statistics, and per-condition filtering on top of the same raw scatter. Building this as a plugin-style overlay system means future analysis features (density heatmap, residual plot, multivariate regression) are one new module each — no edits to existing ones.

## Migration

Existing saved tiles, exported `.helios` bundles, and built-in workspace defaults all keep rendering. A one-shot migration in `xy-plot/index.tsx` rewrites legacy v1 configs (`{xChannelId, yChannelId, xMin, …, color, trail}`) into the v2 shape on read, wrapping the scatter into a single `scatter` overlay with id `migrated-scatter`.

## Tests added

- `packages/lib/tests/regression.test.ts` — 10 tests covering all five fit kinds with known-input/known-output cases.
- `packages/lib/tests/statistics.test.ts` — 7 tests for mean/stddev/correlation/percentile/linspace.
- `packages/widgets/tests/xy-plot/migrations.test.ts` — legacy → v2 migration; v2 no-op; defaults.
- `packages/widgets/tests/xy-plot/data-pipeline.test.ts` — filter, group-by, zoom, all combined.
- `packages/widgets/tests/xy-plot/overlays/*.test.ts` — one suite per overlay module (scatter, fit, formula, bins, stats, quadrant-fit).

## Files of note

- `packages/lib/src/regression.ts` — pure math, no React. Reusable.
- `packages/lib/src/statistics.ts` — same.
- `packages/widgets/src/xy-plot/types.ts` — single source of truth for the schema and overlay contract.
- `packages/widgets/src/xy-plot/data-pipeline.ts` — filter/group-by/zoom in one place; every overlay sees the same `SessionGroup[]`.
- `packages/widgets/src/xy-plot/overlays/registry.ts` — adding a new overlay = one new file + one side-effect import in `render.tsx`.

## Manual smoke checklist

Performed before tagging the release:

- [ ] Open a session with at least throttle, RPM, gear channels.
- [ ] Add an XY tile with default config (simple mode); confirm it renders identically to a 2.3.x install.
- [ ] Switch to advanced; add a `fit` overlay (linear); confirm the line shows.
- [ ] Add a `formula` overlay `0.5 * x`; confirm the dashed line draws.
- [ ] Set filter `throttle > 50`; confirm scatter + fit drop the low-throttle samples.
- [ ] Set group-by `gear`; confirm per-gear color + per-gear fit (with `perGroup` toggled on the fit).
- [ ] Add a `stats` overlay top-right with `fitRSquared` enabled and `fitOverlayId` pointing at the fit's id; confirm R² shows.
- [ ] Zoom into a sub-section in any strip-chart; confirm the XY plot's data shrinks accordingly.
- [ ] Drop a few datums (shift+click on a strip-chart); confirm red-orange dots appear at the matching (x, y) on the XY plot.
- [ ] Save the workspace, restart Helios, confirm everything restores including filter, group-by, all overlays.
- [ ] Export `.helios`, import on a clean instance, confirm same.
