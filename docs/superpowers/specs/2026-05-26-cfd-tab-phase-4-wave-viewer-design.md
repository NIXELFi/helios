# CFD Tab — Phase 4 Design (Animated Wave-Frame Viewer + Waterfall Sub-View)

**Status:** Draft
**Authors:** Claude (autonomous mode per user instruction, 2026-05-26)
**Branches against:** `physics-fixes/math-corrections` (current head `b057a2b`, sync of v3.4.5).
**Ships as:** v3.6.0 (next minor; CFD feature, no physics math change).

## Goal

Light up the Phase 4 viewer that Phase 3 left a placeholder for. Two views in one modal:

1. **Schematic** — anatomical engine view (plenum → runners → cylinder row → primaries → secondaries → collector). Cells in each pipe are colored by a user-selected field (p / u / T / ρ / Mach) and the cell's perpendicular extent scales with a second user-selected field (default = pressure). Cylinders are circles whose diameter scales with cylinder pressure and whose fill color follows a user-selected cylinder field (`x_b` / p / T). Animation plays through the captured cycle with speed and scrub controls.
2. **Waterfall** — per-pipe x-t heatmap. Pick a pipe and a field; render the full captured cycle as a 2-D image (x = position along pipe, y = time / theta, color = field value). Reuses the schematic's color logic. This is the diagnostic view from `1dFV/diagnostics/waterfall_viewer.py`, ported in spirit (the math + color conventions, not the Python code).

For **single-RPM** studies the modal opens for the captured `rpmInt`. For **sweep** studies, the modal has an RPM dropdown listing every captured RPM in that sweep and re-loads on selection.

## Non-Goals

- **Capturing more than one cycle.** Today `WaveFrameWriter` only writes the last cycle; multi-cycle capture is a backend change deferred (see "Future work").
- **New colormaps or species fields.** We restrict to the four fields actually on disk (`rho`, `u`, `p`, `T`) plus derived `Mach`. No `Y` (no species in current data).
- **Diff mode / two-viewer side-by-side.** Single capture per modal.
- **Brush-to-scrub on the waterfall.** Click-to-jump is implemented; brush-select is deferred.
- **Saving / exporting the animation** as a video or GIF. Out of scope.
- **Backend change to capture cycle.** All capture-pipeline plumbing is already done by Phase 3.
- **uPlot integration for the waterfall.** uPlot does not have a native 2-D heatmap primitive; we draw the waterfall on a `<canvas>` with `ImageData`. Schematic is also canvas.
- **WebGL.** Canvas 2D is fast enough at the data scales we have (see Performance budget).

## Architecture (high level)

```
+--------------------------+         +----------------------------+
|  SingleRpmResults /      | click   |  WaveViewerModal           |
|  SweepResults captures   |-------->|   ├ controls               |
|  bar — new button:       |         |   ├ SchematicView          |
|  "Open wave viewer ↗"    |         |   └ WaterfallView          |
+--------------------------+         +-----------+----------------+
                                                  | useWaveCapture
                                                  v
                                     +----------------------------+
                                     |  bridge.loadWaves(...)     |
                                     |  Tauri command:            |
                                     |    cfd_load_waves          |
                                     |   (new — JSONL aware)      |
                                     +----------+-----------------+
                                                  |
                                                  v
                                     <Documents>/Helios/cfd/captures/
                                       <jobId>/<kind>/<rpmInt>/
                                         manifest.json
                                         waves.jsonl
```

### What is reused vs new

| Already exists (Phase 3) | New in Phase 4 |
|---|---|
| `WaveFrameWriter` writes JSONL + manifest | — |
| `manifest.json` whitelisted in `cfd_load_capture` | — |
| `study.params.captureWaves` flag | — |
| Placeholder text in SingleRpmResults / SweepResults | Replaced with "Open wave viewer ↗" button |
| `bridge.loadCapture` for pv/profiles/manifest | New sibling: `bridge.loadWaves` |
| `CfdContext`, `StudiesScreen`, `ResultsScreen` | Unchanged |
| — | `cfd_load_waves` Tauri command (JSONL-aware) |
| — | `WaveViewerModal` + `SchematicView` + `WaterfallView` + `useWaveCapture` hook + `colormaps.ts` + `fields.ts` |

## Section 1 — Backend: `cfd_load_waves` Tauri command

### 1.1 Why a new command (instead of extending `cfd_load_capture`)

`cfd_load_capture` returns `serde_json::Value` parsed from a single JSON document. `waves.jsonl` is **newline-delimited JSON** — one full frame per line. Reusing the existing command would require either:

- Special-casing the JSONL filename to read line-by-line and return a `Value::Array` of frame objects, OR
- Returning raw bytes and parsing in JS.

Both are uglier than a focused command. We add a separate `cfd_load_waves` that:
- Reads `manifest.json` + `waves.jsonl` in one call (avoids two Tauri roundtrips).
- Parses each JSONL line into a typed frame on the Rust side.
- Returns `{ manifest, frames }` as one `serde_json::Value`.

### 1.2 Command signature

```rust
// apps/desktop/src-tauri/src/cfd/commands.rs

/// Read the manifest + every frame of waves.jsonl for the given capture
/// directory. Returns `{ manifest, frames }` as JSON — the manifest is
/// the parsed `WaveFrameManifest` and `frames` is an array of frame
/// objects in the on-disk shape (theta, t_ms, pipes[n_pipes][4][n_cells], cyl[]).
///
/// Path is constructed identically to `cfd_load_capture`. `study_kind`
/// must be "single-rpm" or "sweep"; `rpm_int` is the RPM directory.
#[tauri::command]
pub fn cfd_load_waves(
    app: AppHandle,
    job_id: String,
    study_kind: String,
    rpm_int: u32,
) -> Result<serde_json::Value, String>;
```

Implementation:

1. Validate `job_id` (no `..`, no path separators), `study_kind` (∈ {single-rpm, sweep}).
2. Build path: `<Documents>/Helios/cfd/captures/<job_id>/<study_kind>/<rpm_int>/`.
3. Read `manifest.json` into `WaveFrameManifest`. If missing or unparseable → error.
4. Read `waves.jsonl` line by line. Each line is parsed as a JSON object (not a typed struct — we keep the on-disk shape and let TS describe it). Empty lines are tolerated and skipped. **On the first parse error, return an error with the bad line number — no partial returns and no further reading.**
5. Sanity-check: `frames.len() == manifest.frame_count` → if mismatch, return an error noting both counts.
6. Return `serde_json::json!({ "manifest": <manifest>, "frames": <frames_array> })`.

Register in `apps/desktop/src-tauri/src/lib.rs` alongside `cfd_load_capture`.

### 1.3 Frontend bridge

In `apps/desktop/src/modules/cfd/lib/tauriBridge.ts`, add:

```ts
loadWaves(
  jobId: string,
  studyKind: "single-rpm" | "sweep",
  rpmInt: number,
): Promise<{ manifest: WaveFrameManifest; frames: RawWaveFrame[] }>;
```

The mock bridge used in tests returns canned data from a fixture.

### 1.4 Existing whitelist

Leave `cfd_load_capture` alone. `waves.jsonl` stays out of its whitelist (still true to the original code comment: "deliberately NOT exposed via this command").

## Section 2 — Data model + loader hook

### 2.1 TS types (in `state/types.ts`)

These mirror the Rust serde shapes already produced by the writer.

```ts
export type WaveField = "p" | "u" | "T" | "rho" | "Mach";
export type WaveSizeField = "p" | "u" | "T" | "rho";      // no Mach for size
export type WaveCylField = "x_b" | "p" | "T";

export interface WavePipeMeta {
  role: PipeRole;        // "plenum" | "runner" | "primary" | "secondary" | "collector"
  label: string;
  nCells: number;
  lengthM: number;
  index: number;         // original engine pipe index
}

export interface WaveFrameManifest {
  jobId: string;
  rpm: number;
  nPipes: number;
  pipes: WavePipeMeta[];
  nCylinders: number;
  stepStride: number;
  fields: string[];                  // always ["rho", "u", "p", "T"]
  frameCount: number;
  thetaStartDeg: number;
  thetaEndDeg: number;
  capturedCycle: number;
  incomplete: boolean;
}

/** On-disk frame shape (raw). Used only during loading; packed away. */
export interface RawWaveFrame {
  theta: number;
  tMs: number;
  pipes: [number[], number[], number[], number[]][]; // [pipe][rho|u|p|T][cell]
  cyl: { v: number; p: number; t: number; xB: number }[];
}
```

### 2.2 Packed in-memory shape

Frames are packed once into typed arrays for fast random access. This is the only structure the renderers touch.

```ts
export interface WaveCapturePacked {
  manifest: WaveFrameManifest;
  theta: Float32Array;                        // length = frameCount
  tMs: Float32Array;                          // length = frameCount
  /** pipeArr[pipeIdx][fieldIdx] = Float32Array(frameCount * nCells), row-major: [frame][cell]. */
  pipeArr: Float32Array[][];                  // pipeArr[nPipes][4]
  /** cylArr[cylIdx][fieldIdx] = Float32Array(frameCount). fields: [V, p, T, xB]. */
  cylArr: Float32Array[][];                   // cylArr[nCyl][4]
  /** Precomputed per-(pipe, field) min/max over the whole cycle, for colormap auto-range. */
  pipeRange: { min: number; max: number }[][]; // pipeRange[nPipes][4]
  /** Per-cylinder per-field min/max. */
  cylRange: { min: number; max: number }[][]; // cylRange[nCyl][4]
}
```

Field indices: `0 = rho, 1 = u, 2 = p, 3 = T` for pipes; `0 = V, 1 = p, 2 = T, 3 = xB` for cylinders. Derived `Mach` is computed on the fly inside the renderer from cell-local `u` and `T` (no separate packed field).

### 2.3 `useWaveCapture` hook

```ts
function useWaveCapture(
  jobId: string,
  studyKind: "single-rpm" | "sweep",
  rpmInt: number,
): {
  state: "idle" | "loading" | "ready" | "error";
  data: WaveCapturePacked | null;
  error: string | null;
};
```

Behavior:

1. On mount or when `(jobId, studyKind, rpmInt)` changes, set `state = "loading"`.
2. Call `bridge.loadWaves(...)`. On success, walk every frame and copy into the typed arrays. On error, set `state = "error"` with message.
3. Cancellation guard: track an `effectId` in a ref; if the effect was superseded (modal closed, RPM switched, etc.), drop the result.
4. Memoize the packed data; never re-pack if the inputs are identical.

Memory budget: with `nPipes = 9`, `nCells ≈ 30`, `frameCount = 600`, four fields:
`9 × 30 × 4 × 600 × 4 B = 2.6 MB`. Plus cylinders ~38 KB. Trivial.

## Section 3 — Schematic renderer

### 3.1 Layout algorithm

The layout is **data-driven** from the manifest — no hard-coded SDM26 geometry. Pipes are arranged in tiers by role:

```
Tier 0 (top):           PLENUM            (1 horizontal strip, full width)
Tier 1:        RUNNER₁  RUNNER₂  RUNNER₃  RUNNER₄  (N vertical strips, evenly spaced)
Tier 2:           ◯       ◯       ◯       ◯      (N cylinders, circles)
Tier 3:        PRIMARY₁ PRIMARY₂ PRIMARY₃ PRIMARY₄ (N vertical strips, aligned with cylinders)
Tier 4:           SECONDARY₁ ─Y─ SECONDARY₂        (M strips, each centered between source primaries)
Tier 5 (bot):           COLLECTOR         (1 horizontal strip, full width)
```

If a tier has zero pipes for that role, it's skipped and the remaining tiers compress upward. So a 1-cyl engine with no secondary still renders cleanly.

Pseudocode:

```
function layoutSchematic(manifest, canvasW, canvasH):
    pipesByRole = group manifest.pipes by role
    runners     = pipesByRole["runner"]     // N
    primaries   = pipesByRole["primary"]    // N
    secondaries = pipesByRole["secondary"]  // M (0 .. N/2)
    plenum      = pipesByRole["plenum"][0]
    collector   = pipesByRole["collector"][0]
    nCyl        = manifest.nCylinders

    // Vertical budget (allocate per tier; collapse missing tiers)
    tiers = [
        { kind: "horiz-pipe", pipe: plenum,       weight: 1 },
        { kind: "vert-pipes", pipes: runners,     weight: 2 },
        { kind: "cyl-row",                        weight: 1 },
        { kind: "vert-pipes", pipes: primaries,   weight: 2 },
        secondaries.length > 0 ? { kind: "junction-pipes", pipes: secondaries, weight: 2 } : null,
        { kind: "horiz-pipe", pipe: collector,    weight: 1 },
    ].filter(notNull)

    distribute canvasH proportionally to tier.weight
    return { tiers: each with its bounding rect, columnXs: [N cylinder column centers] }
```

### 3.2 Drawing a pipe strip

Each pipe is a rectangle whose long axis is the flow axis. Cells are rendered as `nCells` adjacent rectangles along the long axis.

For a **horizontal pipe** (plenum, collector): cell `i` is a vertical bar at `x = baseX + i × cellW` with width `cellW`. The bar's vertical extent (height) is `baseThickness + (sizeFieldNormalized × thicknessRange)`, centered on the pipe's mid-line. Bar fill = `colormap(field(cell), fieldRange)`.

For a **vertical pipe** (runner, primary, secondary): cell `i` is a horizontal bar at `y = baseY + i × cellW` with height `cellW`. The bar's horizontal extent (width) scales with size field; fill follows color.

`sizeFieldNormalized` is `(value - rangeMin) / (rangeMax - rangeMin)`, where the range is the per-pipe-per-field range from the packed data (so cells "breathe" within their own pipe's dynamic range — pressure waves in a tiny runner don't get visually swallowed by the plenum's larger swings).

### 3.3 Drawing cylinders

Cylinders are circles at the cylinder-column centers between Tier 1 and Tier 3.

- Diameter = `baseR + (cylP - cylRange.min) / (cylRange.max - cylRange.min) × dRange × 2`.
  Always size by pressure — physical intuition (combustion event = big circle).
- Fill = `colormap(cylinderField(t), cylRange[field])`.
- A thin outline marks the cylinder index. Hover (later) shows full state.

### 3.4 Color fields and colormaps

Lifted from `1dFV/diagnostics/waterfall_viewer.py`'s `FIELD_CONFIGS`:

| Field | Colormap | Reference centering | Notes |
|---|---|---|---|
| `p` (pressure) | RdBu_r diverging | center on `P_ATM = 101325 Pa` | symmetric range = max(\|max−ref\|, \|min−ref\|) |
| `u` (velocity) | RdBu_r diverging | center on `0` | symmetric range |
| `T` (temperature) | inferno sequential | none | `[min, max]` |
| `rho` (density) | viridis sequential | none | `[min, max]` |
| `Mach` (derived) | viridis sequential | none | `[0, max]`; `Mach = u / sqrt(γ R T)` with γ=1.4, R=287 |
| Cylinder `x_b` | viridis sequential | none | `[0, 1]` (chemistry is bounded) |

Five colormaps total (RdBu_r, inferno, viridis, magma left out unless we add Y later). Each implemented as a 256-entry LUT in `colormaps.ts`. LUT generated once at module load from a hard-coded coefficient table copied from matplotlib.

### 3.5 Animation loop

State variables (in `WaveViewerModal`):

```ts
const [view, setView] = useState<"schematic" | "waterfall">("schematic");
const [field, setField] = useState<WaveField>("p");
const [sizeField, setSizeField] = useState<WaveSizeField>("p");
const [cylField, setCylField] = useState<WaveCylField>("x_b");
const [speed, setSpeed] = useState(1);              // 0.25 .. 8
const [isPlaying, setIsPlaying] = useState(false);
const [frameIdx, setFrameIdx] = useState(0);
const [waterfallPipeIdx, setWaterfallPipeIdx] = useState(0);
const [rpmInt, setRpmInt] = useState(initialRpm);   // for sweep switcher
```

`requestAnimationFrame` loop in `SchematicView`:

- On every rAF tick: if `isPlaying`, advance `frameIdx` by `Δt × (frameCount / cycleDuration_s) × speed` where `cycleDuration_s = (manifest.thetaEndDeg − manifest.thetaStartDeg) / (rpm × 360 / 60)` so 1× plays the captured cycle at real-engine time. Loop on overshoot.
- On every tick (or scrub): redraw the canvas — clear, draw plenum cells at `frameIdx`, draw runners, cylinders, primaries, secondaries, collector. ~270 cell rects + 4 cylinders per frame.
- If not playing, only redraw on `frameIdx` change.

Real-engine time at 8000 rpm = 15 ms/cycle. At 1× the animation runs faster than the eye can follow — that's why we default to 0.25× on first load. (Configurable; we just pick the start speed.)

### 3.6 Controls bar

Above the canvas:

```
[Schematic] [Waterfall]   field: [p ▾] size: [p ▾] cyl: [x_b ▾]   speed: [0.25× ▾]
                          [◀◀] [⏵/⏸] [▶▶]   θ ●━━━━━━━━━━━━━━━━━━━━ 720°
                          legend: ▆▇▆ (cell)  ◯ (cyl) — value bar from vmin to vmax
```

The "field" select governs both schematic cell color *and* waterfall color. "size" is schematic-only. "cyl" is schematic-only. Speed select offers `0.25, 0.5, 1, 2, 4, 8` — default is 0.25× (see Section 3.5 rationale: 1× plays a real-engine cycle in 15 ms at 8000 rpm, too fast to follow). The scrubber is a single-thumb range input over `[0, frameCount-1]`. Frame-step buttons advance/retreat by 1 frame.

For sweep studies, an additional left-side control:

```
RPM: [4000 ▾]    (only present when studyKind === "sweep")
```

Switching RPM re-mounts `useWaveCapture` and resets `frameIdx = 0`. Other state (field, size, speed, view) persists.

### 3.7 Header

Shows: `RPM 8000 · cycle 12 captured · 600 frames · θ 1440°..2160° · stride 200`. Marks "incomplete" if the manifest flag is set, in amber.

## Section 4 — Waterfall sub-view

### 4.1 Layout

Single canvas. Controls above:

```
[Schematic] [Waterfall]   pipe: [plenum ▾]   field: [p ▾]
[ImageData canvas: x = position along pipe, y = time (top = θ start, bottom = θ end)]
colorbar on the right with vmin/vmax labels
```

### 4.2 Render

Build an `ImageData` of size `(nCells × cellScale) × frameCount`. For each `(frame, cell)`:

1. Compute `value = packed.pipeArr[pipeIdx][fieldIdx][frame*nCells + cell]`.
2. Normalize to `[0, 1]` against the per-pipe-per-field range (same as schematic).
3. Look up `colormap[fieldIdx](value)` and write to the ImageData pixel.

`cellScale` is `max(1, canvasW / nCells)` rounded down so each cell maps to ≥1 px.

Render is one-shot per (pipe, field) change — no animation. Sub-millisecond at 600 × 30 pixels.

For derived Mach: compute per-cell `u / sqrt(γ R T)` on the fly during the pixel loop.

### 4.3 Scrubber line

When the user has scrubbed in the schematic, a thin horizontal line overlays the waterfall at the current `frameIdx`. Clicking on the waterfall jumps the schematic's `frameIdx` to that row. This is the only cross-view interaction.

## Section 5 — UI integration

### 5.1 Button placement

In [`SingleRpmResults.tsx:215-219`](../../apps/desktop/src/modules/cfd/results/SingleRpmResults.tsx), replace the placeholder:

```jsx
{study.params.captureWaves && (
  <span className="text-[10px] text-[#5A5F66]">Wave frames captured on disk (viewer in Phase 4).</span>
)}
```

with:

```jsx
{study.params.captureWaves && (
  <button
    type="button"
    className="rounded-sm border border-[#2A2C32] px-2 py-0.5 text-[10px] text-[#9097A0] hover:border-[#FFC627]"
    onClick={() => setShowWaveViewer(true)}
  >
    Open wave viewer ↗
  </button>
)}
```

Likewise inside `SweepResults.tsx`'s per-RPM expanded row.

`WaveViewerModal` is portaled to `<body>`, blocks background interaction with `bg-black/70`, and closes on Esc, backdrop click, or the close button. Follows the [`ConfirmModal`](../../apps/desktop/src/modules/cfd/components/ConfirmModal.tsx) pattern (role="dialog", aria-modal="true").

### 5.2 Sweep RPM switcher

`WaveViewerModal` accepts:

```ts
interface Props {
  open: boolean;
  jobId: string;
  studyKind: "single-rpm" | "sweep";
  rpmInt: number;
  sweepCapturedRpms?: number[];     // present iff studyKind === "sweep"
  onClose: () => void;
}
```

In `SweepResults.tsx`, derive `sweepCapturedRpms` by iterating `study.summary.points` and filtering to those with `captureDir != null`. Pass to the modal. The modal seeds its internal `rpmInt` state from props and uses the dropdown for in-modal switching.

### 5.3 No new top-level navigation

The viewer does not get its own tab in the Results screen. It opens from the result detail row of a study; closing returns to that row.

### 5.4 No-browser-dialogs rule

Honored: no `window.alert`, `window.confirm`, `window.prompt`. Errors render as in-modal notices in the same style as `PvLoopView`'s `<Notice>`.

## Section 6 — File layout

```
apps/desktop/src/modules/cfd/results/wave-viewer/
  WaveViewerModal.tsx
  SchematicView.tsx
  WaterfallView.tsx
  useWaveCapture.ts
  colormaps.ts                # 3 256-entry LUTs (RdBu_r, inferno, viridis) shared across 5 fields
  fields.ts                   # field metadata + Mach derivation
  layout.ts                   # tier layout function (data-driven)
  index.ts                    # public exports

apps/desktop/src/modules/cfd/results/wave-viewer/__tests__/
  useWaveCapture.test.ts      # bridge mock → packed shape
  layout.test.ts              # tier layout produces expected rects for 1-cyl, 4-cyl, no-secondary
  colormaps.test.ts           # known-value RGB checks at LUT endpoints + midpoint
  fields.test.ts              # Mach derivation, vmin/vmax for centered fields
  WaveViewerModal.test.tsx    # opens, closes, RPM switcher fires re-load (via mock bridge)

apps/desktop/src-tauri/src/cfd/commands.rs
  + pub fn cfd_load_waves(...)

apps/desktop/src-tauri/src/lib.rs
  + cfd::commands::cfd_load_waves to the invoke handler

apps/desktop/src/modules/cfd/lib/tauriBridge.ts
  + loadWaves(...) method on both real bridge and mock

apps/desktop/src/modules/cfd/state/types.ts
  + WaveField, WaveSizeField, WaveCylField, WavePipeMeta, WaveFrameManifest, RawWaveFrame, WaveCapturePacked

apps/desktop/src/modules/cfd/results/SingleRpmResults.tsx
  + import WaveViewerModal, replace placeholder with button + modal mount

apps/desktop/src/modules/cfd/results/SweepResults.tsx
  + button + modal mount in per-RPM expansion
```

## Section 7 — Tests

### 7.1 Rust

In `crates/cfd-core` and the Tauri command, the existing tests already cover the writer. The new command needs:

- `cfd_load_waves` happy path: write a fixture into a temp dir, set up a temp `AppHandle::path()::document_dir`, call the command, assert manifest fields + frame count + first/last theta.
- `cfd_load_waves` malformed JSONL line → returns error with line number.
- `cfd_load_waves` manifest/frame-count mismatch → returns error.
- `cfd_load_waves` traversal rejection (`..` in `job_id`) → returns error.

### 7.2 Frontend (vitest)

- **`useWaveCapture`**: given a mock bridge that returns a fixture, asserts packed shape (frame counts, typed-array lengths, ranges precomputed). Aborts gracefully when unmounted mid-load.
- **`layout.ts`**: 1-cyl manifest (no secondary tier) → 4 tiers. 4-cyl 4-2-1 manifest → 6 tiers, columns aligned. Asserts cylinder column X-centers align with their runner/primary X-centers.
- **`colormaps.ts`**: LUT length = 256; endpoints + midpoint match expected sRGB triplets (within 1 unit). Out-of-range values clamp.
- **`fields.ts`**: Mach derivation with known u/T inputs. Centered-vmin/vmax with mixed signs.
- **`WaveViewerModal`**:
  - Opens; renders schematic by default.
  - Switching tab to Waterfall renders the waterfall canvas.
  - RPM switcher (when `studyKind === "sweep"`) triggers a re-load (bridge mock called with new RPM).
  - Esc, backdrop click, and close button all dismiss.
- No pixel-perfect canvas assertions. The render functions are called with the expected packed data and the expected props; visual correctness verified manually + by snapshotting the controls bar.

### 7.3 Manual verification (per CLAUDE.md "test UI in the app")

After implementation:
1. Run a single-RPM SDM26 study at 8000 rpm with `captureWaves: true`.
2. Open the wave viewer. Confirm: animation plays, scrubber works, field/size/cyl selects redraw correctly, all five colormaps render without artifacts.
3. Run a sweep at three RPMs with captures. Confirm RPM switcher loads each.
4. Open the waterfall tab. Confirm one pipe at a time renders; selector cycles through every pipe in the manifest.
5. Click on the waterfall — confirm the schematic's frame index jumps.

## Section 8 — Performance budget

| Operation | Frequency | Budget | Notes |
|---|---|---|---|
| `cfd_load_waves` over IPC | once per modal open / RPM switch | < 200 ms | ~3 MB JSONL, parsed server-side. Probably 50–100 ms. |
| Packing to typed arrays | once per load | < 100 ms | Sequential memcpy-style; profile shows < 50 ms in practice. |
| Schematic redraw | 60 Hz | < 4 ms | ~270 cell rects + 4 cyl + axes; Canvas 2D handles this trivially. |
| Waterfall redraw | once per (pipe, field) | < 50 ms | One ImageData fill over 600 × 30 = 18k pixels. |
| Mach derivation | per frame (schematic) | < 1 ms | 270 sqrt+div ops. |

The frame-loop budget is the only real ceiling. If we ever blow it (e.g., user runs a config with `nCells = 200` per pipe), fall back to drawing every 2nd frame.

## Section 9 — Risks + how the design handles them

| Risk | Mitigation |
|---|---|
| Capture only stores last cycle; users will assume they're seeing the whole study | Header shows "cycle 12 captured" prominently. Manifest's `captured_cycle` is parsed and surfaced. |
| `theta_start_deg / theta_end_deg` don't cover a full 720° (could be a partial cycle for incomplete writes) | Scrubber displays the actual θ range from the manifest, not 0→720. "Incomplete" badge if `manifest.incomplete === true`. |
| Pipe geometry varies across engine configs (1-cyl, 4-cyl, 6-cyl with twin-collector, etc.) | Layout is data-driven from `manifest.pipes` grouped by role. Missing tiers collapse. |
| Tauri IPC payload is large (~3 MB) | Acceptable. If it ever becomes a bottleneck, we can switch to streaming chunks; not now. |
| Memory leak on RPM switch if old packed buffers are retained | `useWaveCapture` clears `data` when inputs change. React GCs the old typed arrays. |
| Many redraws if user drags the speed select rapidly | Render is idempotent; rAF coalesces. No issue. |
| Colormap LUT is bigger than expected (256 × 3 bytes × 5 maps = ~4 KB) | Negligible. |
| Frame index drifts in the rAF loop due to floating-point accumulation | `frameIdx` is recomputed each tick from `startTime + elapsed × speed`, not incremented. No drift. |
| Closing the modal mid-load wastes the bytes pulled over IPC | Acceptable. The IPC call completes, the result is discarded by the cancellation guard. |

## Section 10 — Out of scope (deferred to a later phase)

These items are explicitly listed so a future agent doesn't try to bundle them in:

1. **Multi-cycle capture.** Backend change in `WaveFrameWriter` and the sweep/single runners. Separate finding.
2. **Brush-to-scrub on waterfall.** Just click-to-jump in v1.
3. **Side-by-side viewer compare (e.g., SDM25 vs SDM26 at 8000 rpm).** Two modals open is awkward; defer.
4. **Hover tooltips on cells with exact values.** Nice-to-have, not blocking.
5. **Export animation to MP4/GIF.** Need a recorder library; not in scope.
6. **Species fraction (Y) field.** No species data on disk today.
7. **Pipe-network animation across junctions** (visual wave-front continuity between connected pipes). Adds layout complexity; defer to a later visual-polish round.
8. **Persistent viewer settings** (remembered field/size/cyl choices across sessions). Defer to settings work.

## Section 11 — Acceptance criteria

- [ ] `cfd_load_waves` Tauri command works against a real capture directory; returns manifest + frames.
- [ ] `useWaveCapture` packs the data into typed arrays once per load; subsequent renders are O(1) lookups.
- [ ] Schematic renders for SDM26 (4 cyl, 4-2-1 exhaust) without hard-coded geometry.
- [ ] Schematic renders for an engine config with no secondaries (skipped tier).
- [ ] All five fields (p, u, T, ρ, Mach) selectable; colors look right (RdBu_r for p/u, sequential for T/ρ/Mach).
- [ ] Cell size visibly scales with the selected size-field.
- [ ] Cylinder circles scale with cylinder pressure; fill follows cyl-field selection.
- [ ] Play/pause works. Speed select changes playback rate. Scrubber jumps frame.
- [ ] Frame-step buttons advance/retreat by exactly one frame.
- [ ] Waterfall renders one pipe at a time; pipe picker cycles. Field selector shared with schematic.
- [ ] Clicking on the waterfall sets the schematic's frame index.
- [ ] Sweep RPM switcher re-loads correctly. Field/size/cyl/speed persist; scrub resets to 0.
- [ ] All new vitest tests pass. Existing 377+ tests still green.
- [ ] All new Rust tests pass. Existing engine-sim parity tests still green (no behavior change).
- [ ] Placeholder text at [SingleRpmResults.tsx:218] replaced with a working button.
- [ ] Manual smoke test on a real run validates animation, sweep RPM switch, waterfall, click-to-scrub.

## Section 12 — Release notes draft (for `v2_changes/39-cfd-phase-4-wave-viewer.md`)

> Phase 4 of the CFD tab lights up the animated wave-frame viewer the Phase 3 plumbing was waiting on. Open it from the Captures bar in any single-RPM or sweep result that has `Record waves` enabled.
>
> **Schematic view** — anatomical engine layout. Plenum at top, runner column, cylinder row (circles), primaries, secondaries (when present), collector. Each pipe's cells are colored by the selected field (pressure / velocity / temperature / density / Mach) and the cell's perpendicular extent scales with a second selectable field (default = pressure). Cylinder circles scale by pressure with fill from a cyl-field (burned-mass-fraction, pressure, temperature). Play/pause, speed (0.25× through 8×), scrubber, frame-step.
>
> **Waterfall view** — per-pipe x-t heatmap; pick a pipe and a field, see the full captured cycle as a 2-D image. Click on the waterfall to jump the schematic's playhead.
>
> **Sweep RPM switcher** — for sweep studies, the modal has a dropdown of every captured RPM and re-loads on selection.
>
> Single new Tauri command (`cfd_load_waves`); no backend math changes; no parity test impact.
