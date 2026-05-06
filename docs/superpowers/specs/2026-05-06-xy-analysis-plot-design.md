# XY Analysis Plot — Design Spec

**Date:** 2026-05-06
**Owner:** Sun Devil Motorsports (ASU FSAE)
**Status:** Draft for review
**Target version:** 2.4.0 (feature-level bump — semantic for "user-visible new analytical capability")

## Summary

Upgrade the existing `xy_plot` widget from a fixed scatter into a fully composable analysis tool, in the spirit of MoTeC i2's analysis screens. The widget gets a **simple ↔ advanced** mode toggle: simple keeps today's behaviour and config (no migration headaches), advanced unlocks an ordered list of typed *overlays* — best-fit lines, free-form `y = f(x)` curves, binned-mean prediction tracks, statistics panels, per-quadrant fits — composed on top of a single shared scatter base. Data feeding the plot is gated by an optional **filter** expression (math-expr) and an optional **group-by** channel; the global zoom range is automatically respected.

Architecturally the widget moves from one render file with branching into a small **plugin/overlay** system: each overlay kind is a self-contained module exposing `{ defaultConfig, compute, draw, Editor }`, registered in a map keyed by `kind`. Adding a future overlay (density heatmap, residual plot, parametric curve) is one new file plus one registry entry — no edits to existing modules.

Configs are plain JSON (discriminated unions only); the new `XyPlotConfig` round-trips cleanly through the existing workspace bundle save/load path. A one-shot migration in `xy-plot/index.tsx` rewrites legacy configs into the new shape on read so every saved tile keeps working.

## Goals

- Existing simple XY plots in saved workspaces keep rendering identically without user action.
- Power users can configure: filter (`where` expression), group-by (e.g. by `gear`), one or more overlays in a chosen order.
- Best-fit overlays support **linear, polynomial (degree N), exponential, logarithmic, power**, with an optional ±σ confidence band and an optional extrapolate-beyond-data toggle.
- Free-form formula overlays draw any `y = f(x)` expression using the existing math-expr engine.
- Binned overlay groups data into N bins along X, computes the mean (or median) Y per bin, draws as a connected curve — the empirical "lookup table" prediction model.
- Per-quadrant fit overlay reports four independent fits (one per axis-zero quadrant), each with its own coefficients + R². Killer feature for damper analysis.
- Statistics overlay shows count, mean X/Y, stddev X/Y, correlation r, R² of selected fit, and the fit equation, in a corner-anchored panel.
- All overlay configs serialize as plain JSON; saved workspaces, exported workspace bundles, and `.helios` files all preserve the full configuration.
- Each overlay kind is independently testable; the shared math (regression, statistics) lives in `@helios/lib` and has unit tests with known-input/known-output cases.

## Non-Goals (this phase)

- Multivariate / ML regression. No neural nets, no train-on-A-predict-on-B. Single-X-single-Y only. Captured as future work.
- Density heatmap / 2D-histogram overlay. The plugin architecture makes adding it later a one-file change; deferred to keep v1 tractable.
- Residual plot (separate axes for fit residuals). Same reasoning as heatmap.
- Auto-promoting a fit equation into a global math-channel ("save as channel"). Nice future workflow, but adds a UX surface that's better designed once users have lived with the basic feature for a release.
- Track-map XY plots (color-by-channel mapped over a GPS trace). Different widget territory entirely.
- Live re-fitting during playback. Fits are computed on the visible data set when it changes; they don't recompute every cursor frame.

## Architecture

### Module map

```
packages/lib/src/
  regression.ts              ← NEW — fitLinear, fitPolynomial, fitExponential,
                                fitLogarithmic, fitPower; each returns
                                coefficients + R² + residual stddev (for σ bands)
  statistics.ts              ← NEW — mean, stddev, correlation, percentile, linspace
  math-expr.ts                ← unchanged

packages/widgets/src/xy-plot/
  index.tsx                   ← unchanged barrel; runs migration on incoming config
  render.tsx                  ← orchestrator — builds OverlayContext, iterates overlays,
                                hands the marker layer to the existing useEffect
                                (target ≤ 300 LOC, was ~200)
  config-editor.tsx           ← orchestrator — base fields + filter/group-by + overlay
                                list with reorder & "+ Add overlay" picker
  types.ts                    ← NEW — XyPlotConfig, Overlay union, OverlayContext,
                                SessionGroup, OverlayModule<C, A>, registry helpers
  data-pipeline.ts            ← NEW — applies filter + group-by + zoom-clamp once,
                                returns SessionGroup[] consumed by every overlay
  migrations.ts               ← NEW — legacy XyPlotConfig → new shape, version-tagged
  overlays/
    scatter.ts                ← OverlayModule<ScatterConfig, ScatterArtifact>
    fit.ts                    ← OverlayModule<FitConfig, FitArtifact>
    formula.ts                ← OverlayModule<FormulaConfig, FormulaArtifact>
    bins.ts                   ← OverlayModule<BinsConfig, BinsArtifact>
    stats.ts                  ← OverlayModule<StatsConfig, StatsArtifact>
    quadrant-fit.ts           ← OverlayModule<QuadrantFitConfig, QuadrantFitArtifact>
    registry.ts               ← Map<kind, OverlayModule>; keeps render.tsx
                                & config-editor.tsx agnostic to the overlay set

packages/widgets/tests/xy-plot/
  data-pipeline.test.ts       ← filter, group-by, zoom-clamp, combinations
  migrations.test.ts          ← legacy config → new schema
  overlays/                   ← one test per overlay module
packages/lib/tests/
  regression.test.ts          ← per fit type, known input → known coefficients & R²
  statistics.test.ts          ← mean/stddev/correlation/percentile vs hand-checked values
```

### Overlay contract

Every overlay kind implements one shape, parameterised by its own config and artifact types:

```ts
export interface OverlayModule<C, A> {
  /** Discriminator stored in saved configs. Keep stable forever. */
  readonly kind: string;
  /** Used when the user clicks "+ Add overlay" of this kind. */
  defaultConfig(): C;
  /** Pure: derives drawable artifacts (fit coeffs, binned curve, stats text…)
   *  from the filtered/grouped data. Memoizable on (groups identity, config). */
  compute(groups: SessionGroup[], cfg: C, ctx: OverlayContext): A;
  /** Paints to the data canvas. Optional — a DOM-only overlay (e.g. stats
   *  panel) leaves this off and uses Component below instead. */
  draw?(ctx: CanvasRenderingContext2D, layout: PlotLayout, artifacts: A, cfg: C): void;
  /** Optional DOM overlay (rendered into a wrapper above the marker canvas
   *  with pointer-events:none on the wrapper, pointer-events:auto on the
   *  panel itself). Used by overlays whose output is selectable text or
   *  HTML controls — anything that doesn't belong inside a <canvas>. */
  Component?: FC<{ artifacts: A; cfg: C; layout: PlotLayout }>;
  /** React component for the per-overlay config editor row. */
  Editor: FC<OverlayEditorProps<C>>;
  /** Optional: short text fragments shown in the in-canvas legend. */
  legendEntries?(cfg: C, artifacts: A): LegendEntry[];
  /** Fields for the simple/advanced gating: "simple" hides overlays that
   *  don't list "simple" in their availability set. */
  availability: ReadonlyArray<"simple" | "advanced">;
}
```

Render orchestration calls `draw` (if defined) on the data canvas and renders `Component` (if defined) into the DOM overlay wrapper. An overlay defines exactly one of the two; the registry asserts this at module-load time. The contract is intentionally permissive on this so future overlays (e.g. a click-through interactive cursor inspector) can use either rendering path.

`SessionGroup`, `OverlayContext`, `PlotLayout`, `LegendEntry` and the `Overlay` discriminated union live in `xy-plot/types.ts` and are the only types overlays need to import. The registry in `overlays/registry.ts` is a `Record<string, OverlayModule<unknown, unknown>>` populated at module load.

`OverlayContext` exposes the read-only state an overlay needs beyond the data:

```ts
interface OverlayContext {
  /** Plot bounds (after config / data resolution). */
  bounds: { xmin: number; xmax: number; ymin: number; ymax: number };
  /** Artifacts produced by previously-computed overlays in this render
   *  pass, keyed by overlay id. Used by the stats overlay to read a
   *  fit's R² and equation by id. Earlier-in-array overlays compute
   *  first, so the iteration order in `config.overlays` is also the
   *  dependency order. */
  priorArtifacts: ReadonlyMap<string, unknown>;
  /** All channels in the primary session, for any overlay that needs to
   *  resolve a channel reference (e.g. group-by). */
  availableChannels: ChannelMeta[];
}
```

The stats overlay's `fitOverlayId` is a soft reference: if the targeted overlay was deleted or reordered after the stats overlay (so its artifact isn't yet in `priorArtifacts`), the stats panel renders `R² = —` and the equation slot is hidden. No errors, no crashes — the editor surfaces a one-line warning.

### Data flow per render

```
config (with overlays[]) + visible sessions + viewState (zoom) + cursorEmitter
        ↓
data-pipeline.ts:
   1. clamp each session's [time, xs, ys] to viewState.zoomRange (if set)
   2. evaluate filter expression per-sample, drop rows where it's false
   3. partition surviving rows by group-by channel value (or "all")
        ↓
SessionGroup[]:    [{ session, groupKey, time, xs, ys, n, color }, ...]
        ↓
render.tsx draw():
   1. setupCanvas → compute bounds → draw axes
   2. for overlay of config.overlays:
         module = registry[overlay.kind]
         artifacts = module.compute(SessionGroup[], overlay.config, ctx)
         module.draw(ctx, layout, artifacts, overlay.config)
   3. compose legend from each overlay's legendEntries()
        ↓
marker layer (unchanged): cursor ring + datum dots, on the overlay canvas
```

The two-canvas layering already in place (data canvas + marker canvas) is preserved — the data canvas now also paints overlays, and only re-renders when the data, config, or session set changes. The marker canvas continues to redraw on cursor moves and view-state changes only.

## Overlay specifications

### `scatter` — the base point cloud

```ts
interface ScatterConfig {
  color: string;                  // overridden when group-by is active
  pointSize: number;              // px, default 2
  alpha: number;                  // 0..1, default 1; useful for dense scatter
  trail: boolean;                 // existing time-color gradient option
}
```

Compute is the existing scatter logic; draw is the existing point-rendering loop. Available in **simple** and **advanced**. Default tile that didn't exist? — auto-added when migrating a legacy config.

### `fit` — regression curve with optional band & extrapolation

```ts
type FitKind =
  | { type: "linear" }
  | { type: "polynomial"; degree: number }    // 2..6
  | { type: "exponential" }                   // y = a * e^(b*x)
  | { type: "logarithmic" }                   // y = a + b*ln(x)
  | { type: "power" };                        // y = a * x^b

interface FitConfig {
  kind: FitKind;
  color: string;
  lineWidth: number;                          // px, default 1.5
  showBand: boolean;                          // ±1σ residual envelope
  extrapolate: boolean;                       // draw beyond observed X range
  perGroup: boolean;                          // when true, fit each group-by group
                                              // separately; otherwise one fit on
                                              // pooled data
}

interface FitArtifact {
  fits: Array<{
    groupKey: string | null;
    coefficients: number[];
    rSquared: number;
    residualStd: number;
    sampleX: Float64Array;                    // dense X for curve sampling
    sampleY: Float64Array;
  }>;
}
```

Compute calls into `@helios/lib/regression`. Polynomial uses the normal equations (closed-form, O(n·deg²)); exponential/logarithmic/power are linearised (log-transform on the appropriate axis), then re-projected. R² is computed on the original (non-linearised) scale. Available in **advanced**.

### `formula` — user-typed `y = f(x)` curve

```ts
interface FormulaConfig {
  expression: string;              // e.g. "0.8 + 1.2 * x - 0.05 * x^2"
  color: string;
  lineWidth: number;
  dashed: boolean;
}
```

Compile the expression with the existing math-expr parser at compute time; sample at ~200 evenly-spaced X positions across the visible X range and draw a polyline. The expression's free identifier is `x`. Compile errors render as a red error banner inside the plot (small, dismissable, doesn't break the rest of the widget). Available in **advanced**.

### `bins` — empirical lookup curve / "predict given X"

```ts
interface BinsConfig {
  binCount: number;                // 5..200, default 20
  statistic: "mean" | "median" | "p25-p75";
  color: string;
  showCount: boolean;              // tooltip-style sample-count per bin
}

interface BinsArtifact {
  bins: Array<{ xCenter: number; yStat: number; yLow?: number; yHigh?: number; n: number }>;
}
```

Equally-spaced bins along X. `mean`/`median` draw a single connected line; `p25-p75` draws a shaded band between the 25th and 75th percentile. This is the prediction-from-history model the user asked for in Q3-C. Available in **advanced**.

### `stats` — corner-anchored statistics panel

```ts
interface StatsConfig {
  position: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  show: {
    count: boolean;
    meanXY: boolean;
    stdXY: boolean;
    correlation: boolean;
    fitRSquared: boolean;          // requires a fit overlay; reads its R²
    fitEquation: boolean;          // ditto
  };
  fitOverlayId?: string;           // which fit overlay to read R² / equation from
}
```

Compute reads the same `SessionGroup[]` and (when configured) cross-reads the most recent `FitArtifact` whose overlay id matches `fitOverlayId`. Renders as an HTML `<div>` overlay (not on the canvas) so it's selectable / copy-pasteable. Available in **advanced**.

Overlay ids: when an overlay is added, `crypto.randomUUID()` assigns it an `id` stored in the discriminated-union element. Stats overlay references fits by id, surviving reorder/rename.

### `quadrant-fit` — four independent fits split at axis zero

```ts
interface QuadrantFitConfig {
  kind: FitKind;                   // applied to each quadrant
  color: string;
  lineWidth: number;
  showBand: boolean;
  showStatsOverlay: boolean;       // mini stats per quadrant in the plot corners
}
```

Splits points into four quadrants by sign of (x, y), runs the same regression machinery on each, draws four separate curves clipped to their quadrant. Stats per quadrant rendered in micro-panels in each quadrant corner of the plot. Available in **advanced**.

## Filter & group-by

Both live on `XyPlotConfig` (top level), not on individual overlays — they gate the data once, every overlay sees the same `SessionGroup[]`.

```ts
interface XyPlotConfig {
  version: 2;                      // schema version; 1 = legacy
  mode: "simple" | "advanced";

  xChannelId: string;
  yChannelId: string;
  xMin?: number; xMax?: number;
  yMin?: number; yMax?: number;

  /** Optional math-expr formula. Samples where the result is falsy are
   *  excluded from every overlay. Identifiers resolve against the session's
   *  channels; built-ins and constants per the math-expr docs. */
  filter?: string;

  /** Optional channel id. When set, distinct values become groups, each with
   *  its own scatter color (palette cycled) and its own fit if `perGroup`. */
  groupByChannelId?: string;

  overlays: Overlay[];             // ordered; drawn in array order
}

type Overlay =
  | { id: string; kind: "scatter";       config: ScatterConfig }
  | { id: string; kind: "fit";           config: FitConfig }
  | { id: string; kind: "formula";       config: FormulaConfig }
  | { id: string; kind: "bins";          config: BinsConfig }
  | { id: string; kind: "stats";         config: StatsConfig }
  | { id: string; kind: "quadrant-fit";  config: QuadrantFitConfig };
```

Filter compilation: parse the formula once when `filter` changes, cache the AST in a `Map<string, ParsedExpr>` keyed by formula text. Per-sample evaluation is the existing `evalAst` function; truthy = include.

Group-by: distinct values become string keys. For continuous channels (high-cardinality numeric channels — e.g. RPM as group-by) the editor warns "this channel has 1,200+ distinct values; consider binning first via a math channel". No automatic binning — the user can define a `gear_band = floor(rpm / 1000)` math channel if they want one.

Zoom: integration with the existing `viewState.zoomRange` is automatic in `data-pipeline.ts`. When zoomed, samples whose timestamp falls outside the zoom range are dropped before filter evaluation. Resetting the zoom restores everything.

## UI / config editor

### Mode toggle

A single segmented control at the top of the editor: `Simple | Advanced`. Defaults to whatever the saved config has (legacy → `simple`). Switching simple → advanced reveals the additional sections; switching advanced → simple keeps the advanced-only fields in the config (so toggling back doesn't lose work) but hides them and disables all non-simple overlays in the rendered output.

### Layout

```
┌─────────────────────────────────────────────────────────┐
│  [Simple ▍ Advanced]                                    │
├─────────────────────────────────────────────────────────┤
│  X channel: [ throttle             ▾]                   │
│  Y channel: [ rpm                  ▾]                   │
│  X range:   [    0  ] – [   100  ]                      │
│  Y range:   [    0  ] – [ 14000  ]                      │
├──── advanced ──────────────────────────────────────────┤
│  Filter:    [ throttle > 50            ] (math-expr)    │
│  Group by:  [ gear            ▾] (or none)              │
├──── overlays ──────────────────────────────────────────┤
│  ☰ ▾ Scatter        (color, alpha, trail)        ✕     │
│  ☰ ▾ Fit: linear    (color, ±σ, extrapolate)     ✕     │
│  ☰ ▾ Stats panel    (top-right, R², eq.)          ✕     │
│                                                         │
│  + Add overlay ▾   [Scatter, Fit, Formula,             │
│                     Bins, Stats, Quadrant-fit]          │
└─────────────────────────────────────────────────────────┘
```

Each overlay row shows a drag handle (`☰`), a collapse arrow, the kind name, a one-line summary, and a delete button. The picker only lists overlay kinds whose `availability` includes the current mode.

### Render output

Plot canvas is unchanged in size and position within the tile. Stats panel(s) overlay as DOM elements pinned to the chosen corner with `pointer-events: none` on the wrapper and `pointer-events: auto` on the panel itself (so text is selectable). Per-overlay legend entries flow into the existing top-right legend strip; if the strip overflows it wraps below.

## Math library additions

### `packages/lib/src/regression.ts`

```ts
export interface FitResult {
  coefficients: number[];          // [b0, b1, b2, ...] semantics depend on kind
  rSquared: number;                // computed on original scale, not linearised
  residualStd: number;             // for ±σ band rendering
  predict(x: number): number;
}

export function fitLinear(xs: ArrayLike<number>, ys: ArrayLike<number>): FitResult;
export function fitPolynomial(xs: ArrayLike<number>, ys: ArrayLike<number>, degree: number): FitResult;
export function fitExponential(xs: ArrayLike<number>, ys: ArrayLike<number>): FitResult;
export function fitLogarithmic(xs: ArrayLike<number>, ys: ArrayLike<number>): FitResult;
export function fitPower(xs: ArrayLike<number>, ys: ArrayLike<number>): FitResult;
```

Polynomial uses the normal equations (Gaussian elimination on the symmetric Vandermonde-derived matrix). Exp/log/power linearise: exp → fit `ln(y) = ln(a) + b·x`; log → fit `y = a + b·ln(x)`; power → fit `ln(y) = ln(a) + b·ln(x)`. Each guards against the domain it can't handle (negative y for exp/power, non-positive x for log/power) by skipping invalid samples and surfacing a `validSamples` count.

### `packages/lib/src/statistics.ts`

```ts
export function mean(xs: ArrayLike<number>): number;
export function stddev(xs: ArrayLike<number>): number;       // sample stddev (n-1)
export function correlation(xs: ArrayLike<number>, ys: ArrayLike<number>): number;
export function percentile(xs: ArrayLike<number>, p: number): number;  // p in [0,100]
export function linspace(lo: number, hi: number, n: number): Float64Array;
```

All operate on aligned ArrayLike inputs; NaN values are skipped (the only sane behaviour for sensor data with sparse channels).

### `math-expr.ts`

No changes needed for the formula overlay — it already supports identifiers as free variables, and `x` works fine. A single-line addition of `mean`, `stddev`, `clamp`, `lerp` to the built-in functions list would be useful for math channels in general but is **out of scope** for this spec; tracked separately.

## Persistence & migration

### Schema versioning

`XyPlotConfig` carries a `version: 2` field. Legacy configs (no `version`) are detected at the top of `xy-plot/index.tsx` and rewritten by `migrations.ts` before being passed to render or to the editor. The migration is pure and deterministic:

```ts
// Legacy v1
{ xChannelId, yChannelId, xMin?, xMax?, yMin?, yMax?, color, trail }

// Migrated v2
{
  version: 2,
  mode: "simple",
  xChannelId, yChannelId, xMin, xMax, yMin, yMax,
  overlays: [{
    id: "migrated-scatter",         // fixed sentinel — there is exactly one
                                    // overlay produced by migration, so a
                                    // deterministic id is fine and avoids
                                    // churning the saved config on each load
    kind: "scatter",
    config: { color, pointSize: 2, alpha: 1, trail },
  }],
}
```

Migration is one-way: once a config is saved as v2 it stays v2. Saved workspaces, exported `.helios` bundles, and built-in workspace defaults all flow through the migration on load.

### Workspace bundle compatibility

Workspace bundles serialize tile configs as JSON. The new schema is JSON-clean (discriminated unions, no functions, no class instances) so the existing bundle import/export needs no changes. A bundle exported on a 2.4.0 install and imported on an older 2.3.x install would crash the older renderer (it doesn't know how to handle `overlays`). Mitigation: bump the workspace bundle's `schemaVersion` field on export; older Helios versions already check this and refuse to import newer-schema bundles with a friendly modal.

## Performance

- **Filter eval** is the dominant cost — a math-expr per sample × tens of thousands of samples per session. Compile the AST once per (filter text, channel set), not per sample. Cache the compiled AST in a `Map<string, ParsedExpr>` scoped to the widget instance.
- **Group-by** is a single O(n) bucketing pass per session.
- **Regression** is fast: linear is O(n), polynomial degree d is O(n·d²) for the matrix build + O(d³) for the solve, exp/log/power are O(n) post-linearisation.
- **Bins** are O(n) for assignment + O(n) for the per-bin reductions.
- **Memoization**: every overlay's `compute()` is pure; cache by `(SessionGroup[] identity, config identity)` so cursor scrubs and UI changes that don't touch the data don't re-fit. Use simple `useMemo` keyed off React-stable refs.
- **Two-canvas layering** (data + marker) already in place — preserved. The marker canvas (cursor ring + datums) keeps repainting at rAF for smooth scrub; the data canvas with overlays only repaints when the dataset or config changes.
- **Stats panel** is a DOM element, not canvas — re-renders via React state when the underlying artifacts change. Cheap; DOM diff handles it.

A "big ass" plot at 1080p with 50k samples + linear fit + ±σ band + stats panel should hit < 16ms data-canvas redraw on a modern laptop. We'll verify by reading the existing footer FPS counter while interacting with a real session.

## Error handling

- **Unknown overlay kind in saved config** (forward-compat scenario): skip it with a single `console.warn`, render the rest. Don't crash the widget.
- **Filter compile error**: render a small red error banner inside the plot (`"Filter: <message>"`), continue rendering with no filter applied. The editor inline-validates and shows the same message under the input.
- **Regression failure** (e.g. all samples NaN, fewer than 2 samples for linear, fewer than degree+1 for polynomial): skip the fit, log it once per render, continue. The fit overlay's legend entry shows `(no fit — N samples)`.
- **Group-by with too many buckets**: the editor warns at >50 distinct values; the renderer caps at the first 100 alphabetically and shows `(n more groups hidden)` in the legend.
- **Formula identifier resolves to a non-finite value**: standard math-expr behaviour — the curve has gaps where evaluation fails. No special handling.

## Testing strategy

### Unit (lib package)

- `regression.test.ts`: known input → expected coefficients & R² for each fit kind. Edge cases: collinear data → R² = 1; constant Y → R² = 0; degree > samples → fit returns no-fit sentinel.
- `statistics.test.ts`: mean/stddev/correlation/percentile vs hand-computed values; NaN handling.

### Unit (widget package)

- `data-pipeline.test.ts`: filter alone, group-by alone, zoom alone, all three combined. Verify ordering and that no overlay sees pre-filter samples.
- `migrations.test.ts`: legacy config → v2 with default scatter; round-trip stability (migrating an already-v2 config is a no-op).
- `overlays/*.test.ts`: each overlay's `compute()` against a fixed `SessionGroup[]` returns the expected `Artifact` shape.

### Integration

- Existing `xy-plot.test.tsx`: assert legacy configs still render a canvas (back-compat smoke test).
- New: render the widget with `mode: "advanced"` and a multi-overlay config; assert that `<canvas>` plus the stats DOM overlay both exist. Visual correctness is manual — jsdom won't validate canvas pixels.

### Manual smoke checklist (in `v2_changes/27-xy-analysis-plot.md` once we ship)

- Open a session, add an XY tile, verify simple mode behaves identically to today.
- Switch to advanced; add a Fit (linear), verify the line shows + R² in stats.
- Add a Formula overlay `0.5 * x`, verify dashed line draws.
- Set filter `throttle > 50`, verify scatter/fit drop the low-throttle samples.
- Set group-by `gear`, verify per-gear color + per-gear fit.
- Zoom to a sub-section in any strip-chart, verify the XY plot's data shrinks accordingly.
- Save the workspace, restart Helios, verify everything restores including filter, group-by, all overlays.
- Export `.helios`, import on a clean instance, verify same.

## Out of scope / deferred (tracked for future spec)

- Multivariate / ML regression overlay
- 2D density / heatmap overlay
- Residual plot overlay (separate-axes companion)
- "Save as math channel" workflow for fit equations
- Live re-fit during playback
- Track-map XY (color over GPS trace)
- Adding `mean / stddev / clamp / lerp` to the math-expr engine globally (separate small spec)
