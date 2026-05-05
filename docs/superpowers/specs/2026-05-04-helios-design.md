# Helios — Design Spec

**Date:** 2026-05-04
**Owner:** Sun Devil Motorsports (ASU FSAE)
**Status:** Draft for review

## Summary

Helios is the Sun Devil Motorsports ground-station telemetry suite. It is the engineering-stand application used by the team during and after track sessions to monitor, analyze, and debrief vehicle data. The product target is feature-and-polish parity with Motec Telemetry Monitor T2: dense engineering visualizations, multi-workspace layouts, math channels, lap analysis, and datum-cursor measurement workflows.

This spec covers the **ground-station UI in its entirety**. Live cellular data ingest, in-car displays, and the radio/data-acquisition firmware stack are explicitly out of scope. Helios consumes data via file load (CSV today, Motec `.ld` later) and is designed so a future cellular ingest sidecar can push samples through the same `ChannelStore` interface without UI changes.

The application ships as a desktop app (Tauri shell + React frontend) for macOS, Linux, and Windows.

## Goals

- T2-class visual quality and information density on day one.
- A channel/data layer general enough to absorb new sensors as the SDM26 (and successor) cars evolve, with no code changes for new channels.
- A workspace system that supports per-role layouts (driver, engine, chassis, aero) with instant switching and shareable presets.
- Math channels expressed as formulas, registered as first-class channels indistinguishable from source channels.
- Datum-cursor measurement workflow comparable to Motec i2/T2.
- Multi-year maintainability under rotating FSAE student contributors — narrow interfaces between layers, comprehensive tests, evergreen documentation.

## Non-Goals (this phase)

- In-car driver display.
- Radio/cellular link firmware or transport.
- Data acquisition firmware on the car.
- Cloud sync, multi-user collaboration, web hosting.
- Post-session analysis features beyond what T2 itself ships (deeper i2-Pro-style overlays are a future phase).

---

## Architecture — Three Layers

```
┌──────────────────────────────────────────────────────────────┐
│  Widgets  (React)                                            │
│  StripChart · Gauges · NumericReadout · EngineBar · GpsTrack │
│  LapPanel · AlarmPanel · TireGrid · Histogram · XYPlot       │
├──────────────────────────────────────────────────────────────┤
│  Session  (TypeScript)                                       │
│  Workspaces · Tile layouts · Math channels · Alarms          │
│  Cursor · Datums · Playback · Laps · Persistence             │
├──────────────────────────────────────────────────────────────┤
│  Channel Store  (Rust core + TS bridge, Apache Arrow)        │
│  Sources (CSV / .ld / future live) → rate-grouped tables     │
│  list() · get() · slice() · subscribeRange() · push()        │
└──────────────────────────────────────────────────────────────┘
```

Each layer has a narrow public interface. Lower layers do not know about upper layers. Layers are independently testable.

---

## Layer 1 — Channel Store (data layer)

**Purpose.** The only place samples live. Sources push samples in; consumers (widgets via Session) slice them out. Knows nothing about widgets, workspaces, or UI.

### Channel model

Every channel has metadata:

- `id` — stable string, e.g. `engine.rpm`, `gps.lat`, `susp.lf_travel_mm`.
- `display_name`, `units`, `group`, `color`, `decimals`, `data_type` (`f32`/`f64`/`u16`/`bool`/`enum`).
- `min`, `max`, `warn`, `alarm` thresholds.
- `source` — e.g. `link_g4x`, `gps_module`, `math:tire_load_lf`.
- `sample_rate_hz` — nominal; actual sample times are stored.

### Storage layout — rate groups

Channels at the same nominal sample rate share an Arrow Table with one shared `time_us` column. A typical session has multiple rate-group tables (e.g. 100 Hz, 25 Hz, 10 Hz, 1 Hz). Each table is columnar Arrow, allocated once per session load.

**Why:** O(1) channel lookup by name, contiguous memory for fast slicing, multi-rate handling without a NaN swamp.

Math channels are stored in their own rate-group table at their evaluation rate; from the consumer's perspective, source and math channels are interchangeable.

### Public API (TypeScript)

```ts
channelStore.list(): ChannelMeta[]
channelStore.get(id: string): ChannelMeta
channelStore.slice(ids: string[], range: TimeRange): ChannelSlice
channelStore.subscribeRange(range, ids, cb): Unsubscribe   // no-op for static
channelStore.loadFromCsv(path | bytes): Promise<LoadResult>
channelStore.loadFromMotec(path): Promise<LoadResult>      // Phase 2
channelStore.push(rateGroupId, samples): void              // future live ingest
```

`slice()` is the hot path for every widget. It must be a single pointer-arithmetic operation against contiguous Arrow buffers — not an object walk.

The `subscribeRange` and `push` APIs exist from day one so future cellular ingest is a new source, not a UI change.

### Loader split

CSV and `.ld` parsing run **Rust-side** via Tauri commands. The frontend never sees raw text — it receives Arrow IPC bytes back, zero-copy into the store. Multi-MB log loads stay off the UI thread.

### Channel registry — `channels.yaml`

A curated YAML file ships in the app, listing the expected SDM26 sensor inventory with all channel metadata. The CSV loader matches columns by alias against the registry; unknown columns are auto-registered with sane defaults and surface a warning. This is how Helios produces a polished look on first load — channel metadata is curated, not derived from raw CSV header strings.

---

## Layer 2 — Session (config layer)

**Purpose.** Everything that is *about* the data but is not the data itself.

### Session object

```ts
Session {
  id, name, created_at, source_files: [...]
  workspaces: Workspace[]
  active_workspace_id
  math_channels: MathChannelDef[]
  alarms: AlarmRule[]
  cursor: { time_us, locked_to_lap?: number }
  playback: { state: 'paused'|'playing', speed: 0.25..16, loop_range? }
  laps: Lap[]
  datums: DatumCursor[]
  driver?, run?, notes?
}
```

### Workspaces

A workspace is a saved tile layout: name, grid definition, and per-tile widget configs. Helios ships with five default workspaces — **Overview**, **Engine**, **Chassis**, **Driver**, **Aero/GPS** — that load when a session opens with no saved layout.

Workspace switching is instant: state is held; only the visible tile tree changes.

### Tile system

Built on **react-grid-layout**. Each tile is `{id, widget_type, widget_config, x, y, w, h}`. Tiles are addressable; cursor sync and channel-slice subscriptions are scoped per tile. Tile config is whatever the widget needs (channel ids, scale, color, thresholds).

### Math channels

Expression-based:

```ts
MathChannelDef {
  id, name, units, group, expr,
  eval_rate_hz, dependencies: [channel_ids]
}
```

The math engine compiles `expr` once via `mathjs` `parse → compile`, runs against rate-group buffers in batches (not per sample). Built-in helpers: `derivative(ch)`, `integral(ch)`, `lowpass(ch, hz)`, `lap_delta(ch)`. Math channels register into the channel store identically to source channels.

### Alarms

```ts
AlarmRule {
  channel_id, condition: '>'|'<'|'in_range'|'out_of_range',
  threshold, hysteresis_pct, severity, message
}
```

Evaluated in a Web Worker against new samples (live mode, future) or against the cursor position (replay). Triggered alarms feed the AlarmPanel widget and optionally a desktop notification.

### Cursor and playback

Cursor is a **pub/sub event** (custom emitter), not React state. Moving the cursor at 100 Hz must not re-render the widget tree. Each widget subscribes via ref and imperatively updates the cursor line on its canvas.

Playback is a `requestAnimationFrame` loop in a top-level controller that bumps the cursor by `wall_dt × speed` each frame.

### Datum cursors

Pinned reference markers used for measurement and lap callouts.

```ts
DatumCursor { id, label, t_us, color, locked_to_lap?: number }
session.datums: DatumCursor[]
```

- **Drop:** hotkey `D` drops a datum at the current cursor position; auto-named "A", "B", "C". Right-click on any chart drops one at the chart-x position.
- **Render:** every time-series widget draws each datum as a vertical line in its assigned color, using the same imperative-canvas update path as the live cursor.
- **Readouts:** numeric and gauge widgets gain a "datum table" mode — one row per datum showing channel value at that time, plus Δ vs the live cursor. Strip charts get an inline Δt label when two datums are present.
- **Lap-locked datums:** a datum can be pinned relative to lap start. When the visible lap changes, lap-locked datums move with it so cross-lap comparisons stay aligned.
- **Persistence:** datums save with the workspace and travel inside `.helios` bundles.
- **Stats banner:** when 2+ datums exist, a top-of-window strip shows Δt between adjacent datums; selecting a channel toggles per-datum value + Δ in the same banner.

### Laps

Detected three ways, in priority order:

1. **GPS-line crossing** of a configured start/finish line.
2. **Beam-trigger channel** rising edge.
3. **Manual** user-marked.

Each lap stores `{number, t_start, t_end, time_ms, sectors[]}`. Lap-relative comparisons (overlay lap N vs lap M) are first-class — widgets can be configured to plot one channel for two laps.

### Persistence

- **SQLite (app-local):** sessions, workspaces, recent files, app preferences. Auto-saves on every change.
- **`.helios` bundle (portable):** JSON of one session's config (no sample data — just refs to source files + everything in Session except `cursor`/`playback`). Engineers email these around.

---

## Layer 3 — Widgets (view layer)

**Purpose.** Pure components. Take a `ChannelSlice` + widget config + cursor-emitter ref → render. No data fetching, no business logic.

### Common widget contract

```ts
interface Widget<Config> {
  type: string
  defaultConfig: Config
  ConfigEditor: React.FC<{config, onChange}>
  Render: React.FC<{config, slice, cursorEmitter, datums, timeRange, lap?}>
  requiredChannels(config): string[]
  exportSnapshot(config, slice): Blob
}
```

A central `WidgetRegistry` maps `type` → impl. Tiles instantiate by type. Workspaces serialize tile configs as plain JSON.

### v1 widget set

| Widget | Notes |
|---|---|
| **StripChart** | uPlot. Multi-channel overlay, multi-Y-axis, log/linear, sync'd cursor + datums, Δt label, channel legend with hide toggles, right-click → "add channel," click-drag zoom, double-click reset. Hot path; must hit 100 Hz cursor moves with no jank. |
| **RoundGauge** | Canvas. Min/max arc, warn/alarm bands, needle, digital readout. Smooth needle interp at 60 fps. |
| **BarGauge** | H or V. Min/max ticks, peak-hold tick, color bands. |
| **NumericReadout** | Big number + units, color thresholds, optional sparkline, datum-table mode. |
| **EngineBar** | Wide horizontal RPM bar with shift-light segments, peak RPM marker, gear inset. |
| **GpsTrack** | MapLibre. Track outline auto-fitted to GPS bounds; car dot at cursor; trail colored by selected channel. Lap-overlay mode draws N laps stacked with offset hue. |
| **LapPanel** | Table: lap #, time, delta vs best, sectors. Click to set as cursor lap. Best-of column highlights. |
| **AlarmPanel** | Live list of triggered alarms (channel, value, time, severity) with ack button + history scroll. |
| **TireGrid** | 4-corner tire display: temp (color), pressure (number), wear (bar). Configurable channel mapping. |
| **Histogram** | Bin distribution of one channel over the visible time window. |
| **XYPlot** | One channel vs another. Used for G-G diagrams (lat-G vs long-G), throttle-vs-steer, etc. Optional time-color trail. |

### Performance budget

- Strip charts and gauges: **100 Hz cursor updates** with no jank.
- Map: **30 Hz** car-dot updates.
- Histogram and XY: recompute on cursor settle (debounce 50 ms) — whole-window aggregates.
- Worker threads for any aggregation taking > 5 ms.

### Visual language ("ship like T2")

- **Palette (dark engineering):** base `#0E0E10`, panel `#16171B`, lines `#2A2C32`, text `#D8DCE2`, dim text `#7B8088`. Channel colors from a 24-step ColorBrewer-derived palette tuned for line traces on dark.
- **Type:** Inter for UI, **JetBrains Mono** for all numeric readouts (tabular figures, no jitter). Numeric readouts use `font-variant-numeric: tabular-nums`.
- **Density:** tight. 4 px base spacing. Square panels, 1 px borders, hairlines. Helios looks like an engineering instrument.
- **No animations on data.** Animations are for chrome only (panel open, modal). Data updates are instantaneous.
- **Maroon + gold accent restraint:** Sun Devils colors as accent only — selection highlight, primary button, active workspace tab. Never on data traces.
- **Status bar (bottom):** session name • source file • time range • cursor time • cursor lap • playback state • channel count • alarms count.

### Tile chrome

Each tile: 24 px header (title + channel chips + ⋯ menu), grab handle, resize handles only on hover. No tile borders by default — tiles are separated by 1 px gridlines on the workspace background. Edit mode toggles a 2 px dashed selection ring.

---

## File formats and I/O

### Inputs (Phase 1)

**Generic CSV.** First row = headers. First column = timestamp (auto-detect: `time`, `t`, `time_s`, `time_ms`, `time_us`, ISO datetime). Other columns = channels. Loader steps (Rust-side):

1. Detect delimiter (`,` / `;` / `\t`).
2. Detect time unit and epoch from first column.
3. For each column: match name against `channels.yaml` aliases → resolve metadata. Unknown columns get a default `ChannelMeta` with units derived from header suffix (`_psi`, `_C`, `_rpm`, `_pct`) where present, else dimensionless. Warning surfaced in load result.
4. Group columns by detected sample rate into rate-group Arrow tables.
5. Return `LoadResult { channels, warnings, rate_groups, duration_us }`.

**Multi-file load.** Drag a folder or multi-select: Link ECU CSV + GPS NMEA + sensor box CSV. Each file is a Source; loader time-aligns by an explicit reference clock (UTC if available, else "earliest sample = t0" with manual offsets in a small dialog).

**Sample data.** Helios ships a `samples/` directory containing a synthetic 90-second SDM26 lap with the full channel inventory (engine + chassis + GPS + IMU). First-launch experience opens this so the app is never empty.

### Inputs (Phase 2 hooks, designed-in but not built)

- **Motec `.ld` reader** — Rust crate boundary defined now (`pub fn read_ld(path) -> Result<Vec<RateGroup>>`); implementation deferred.
- **Live ingest** — `ChannelStore::push(rate_group_id, samples)` is part of the day-1 store API; cellular receiver becomes a Tauri sidecar process that pushes through this interface.

### Outputs

**`.helios` session bundle (JSON).**

```json
{ "format_version": 1,
  "session": { ... },                                              // full Session minus cursor/playback
  "source_refs": [{ "path": "...", "sha256": "...", "loader": "csv" }],
  "channels_overrides": { "engine.rpm": { "color": "#FFB800" } },  // per-session deltas vs. channels.yaml
  "notes": "..." }
```

Math channels, datums, workspaces, and alarms all live inside `session` — they are not duplicated at the top level. `channels_overrides` is the only sibling because it is a per-session delta against the canonical `channels.yaml` registry rather than session state.

Opening a `.helios` re-resolves source files by sha256, prompting if missing. No raw samples ship in the bundle — keeps it small and avoids data ownership ambiguity.

**`.helios-snapshot` (sealed).** Optional "send-with-data" variant — bundles compressed Arrow IPC of all rate groups inside the JSON. Same schema with a `data: { ... }` block.

**PNG / SVG widget exports.** Right-click any tile → "Export as PNG/SVG" via each widget's `exportSnapshot` hook. Includes overlay: session name, channel labels, time range. For driver debriefs and engineering reports.

**Channel CSV export.** "Export visible time range as CSV" — picks channels, range, target sample rate (resampled with linear interp); writes a tidy CSV downstream tools can consume.

### File layout on disk

```
~/Library/Application Support/Helios/      # macOS; equivalents on Win/Linux
  helios.sqlite              # app state
  recent/                    # references to recent source files
  workspaces/                # exported workspace presets
  samples/                   # bundled sample sessions
```

---

## Tech stack

- **Tauri** (Rust shell) + **React + TypeScript** + **Vite**
- **uPlot** — strip charts (sub-millisecond render of 100k+ points)
- **MapLibre GL** — GPS track view (open source, no token, vector tiles)
- **Zustand** — state management
- **Tailwind CSS** + custom dark engineering theme
- **Apache Arrow (arquero)** — in-memory channel storage; columnar slicing
- **mathjs** — math channel expressions
- **SQLite** (via Tauri SQL plugin) — app state persistence
- **Rust-side CSV parser** — `csv` + `arrow-rs`; future `.ld` parser as a separate crate

---

## Project structure

```
helios/
├── apps/
│   └── desktop/                # Tauri shell + React entry
│       ├── src/                # frontend
│       ├── src-tauri/          # Rust shell + commands
│       └── index.html
├── crates/
│   ├── helios-core/            # core Rust types (ChannelMeta, RateGroup)
│   ├── helios-csv/             # CSV loader
│   ├── helios-ld/              # Motec .ld loader (Phase 2 stub)
│   └── helios-arrow/           # Arrow IPC helpers
├── packages/
│   ├── store/                  # ChannelStore (TS bridge to Rust)
│   ├── session/                # Session reducer + persistence
│   ├── math/                   # math channel engine
│   ├── widgets/                # widget registry + impls
│   ├── ui/                     # shared design primitives
│   └── lib/                    # cursor emitter, time utils, etc.
├── samples/                    # bundled sample sessions
├── fixtures/                   # test fixtures
├── docs/
│   ├── architecture.md
│   ├── widgets.md
│   ├── channels.yaml           # the curated channel registry
│   └── superpowers/specs/      # design docs
├── scripts/
└── README.md
```

Workspace tools: **pnpm** (workspaces) + **cargo** (workspaces) + **Turbo** for cached builds.

---

## Testing strategy

| Layer | Stack | What we test |
|---|---|---|
| **Channel Store (Rust)** | `cargo test` | CSV parser correctness on golden inputs, multi-rate detection, time-unit detection edge cases, Arrow IPC round-trip, malformed-input handling. |
| **Channel Store (TS bridge)** | Vitest | `slice()` boundary correctness, subscribe/unsubscribe lifecycle, math-channel registration. |
| **Session reducer** | Vitest | Pure-function tests for every state transition (workspace add/remove, datum drop/move, lap selection, math-channel CRUD). |
| **Math engine** | Vitest | Golden expressions (`derivative`, `integral`, `lowpass`, `lap_delta`) against known synthetic signals; numerical accuracy assertions. |
| **Widgets** | Vitest + Testing Library + Playwright | Render tests with fake slices; snapshot tests for default configs; cursor-sync verifies subscriber registration. **Visual regression** via Playwright with per-widget screenshot baselines (committed PNGs, diff threshold). |
| **End-to-end** | Playwright on built Tauri app | "Open sample CSV → switch to Engine workspace → drop datum at t=12s → export PNG" type flows. |

**Golden-file fixtures.** A `fixtures/` directory with: synthetic SDM26 lap CSV, malformed CSVs (missing header, non-monotonic time, mixed delimiters), a sparse multi-rate CSV, and a slot for real CSVs as the user supplies them. Fixtures are the contract — any loader change must keep them green.

**Performance regression tests.** Headless benchmarks on cursor-update latency, strip-chart render time at 100k points, slice() throughput. Fail CI if regressed > 15%.

**Coverage targets.** Rust loader 90%+, Session reducer 95%+, math engine 95%+, widget render paths 70%+. Visual regression baselines must exist for every widget type.

---

## Dev workflow

- `pnpm dev` — Tauri dev with hot reload, opens with sample session loaded.
- `pnpm test` — all TypeScript tests; `cargo test` — Rust tests.
- `pnpm test:visual` — Playwright visual baselines; CI uploads diffs as artifacts.
- `pnpm bench` — performance budget gates.
- `pnpm build` — signed Tauri DMG/MSI/AppImage.

**CI.** GitHub Actions matrix (macOS + Linux + Windows) runs `cargo test`, `pnpm test`, `pnpm test:visual`, `pnpm bench`, then build. Visual diffs post as PR comments.

---

## Documentation outputs

- `docs/architecture.md` — this design doc, kept evergreen.
- `docs/widgets.md` — widget API and "how to add a new widget" with worked example.
- `docs/channels.yaml` — the canonical SDM26 channel inventory, commented.
- Per-package `README.md` with public API and "to add X, edit Y."
- TSDoc on every exported symbol; rustdoc on every public Rust item. Both published to a `docs/` site via `cargo doc` + `typedoc`.

---

## Phasing

**Phase 1 — this spec.** Ground-station UI, file-load only (CSV), full v1 widget set, all visual polish, math channels, datums, laps, alarms, workspaces, persistence, export.

**Phase 2 (out of scope here, designed-in).**
- Motec `.ld` loader implementation behind the existing crate boundary.
- Live cellular ingest via Tauri sidecar pushing through `ChannelStore::push`.
- Deeper post-session analysis features (multi-session overlay, channel math beyond per-sample expressions).

---

## Open questions / future considerations

- **`channels.yaml` ownership.** Spec assumes one shared registry committed to the repo. If multiple cars (SDM26 vs. successor) diverge, may need a per-car registry layer.
- **GPS source.** Spec assumes GPS arrives in the same CSV(s) being loaded. Standalone NMEA/GPX import path is sketched (multi-file load) but not deeply specified — confirm the actual GPS pipeline before building this loader.
- **Lap detection start/finish line.** First-time setup UX for picking the start/finish line on the GPS map is not detailed in this spec; will be designed during widget implementation.
- **Real CSV schema.** When the user supplies a real SDM26 CSV, the channel registry and CSV loader heuristics will be revisited against it — that's the "real test" of the loader's robustness.
