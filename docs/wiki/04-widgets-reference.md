# Widgets reference

Helios ships **18 widget types**. Every widget implements the `Widget<Config>` interface from [`packages/widgets/src/types.ts`](../../packages/widgets/src/types.ts) and registers itself in [`packages/widgets/src/registry.ts`](../../packages/widgets/src/registry.ts).

Each widget receives:

- `config` — its per-tile configuration object
- `slice` — primary-session data over the visible window (`time: BigInt64Array` in µs + per-channel `Float64Array`)
- `cursorEmitter` — the global cursor (subscribe to get scrub events)
- `timeRange` — the session's full time range
- `overlays?` — every visible session in palette-color order (primary first)
- `viewState?` — global zoom range + datum markers
- `lapSelectionEmitter? / lapSelection?` — Main/Ref/Overlay laps
- `laps?` — `LapSet` for the primary session
- `gpsPickerEmitter?` — for the GPS-line lap-detection picker

The shared canvas helpers in [`packages/widgets/src/lib/`](../../packages/widgets/src/lib/) provide `sampleAt(slice, channelId, tUs)`, `setupCanvas(canvas)`, `thresholdColor(value, warn, alarm)`, and the `ChannelPicker` dropdown.

## Cross-cutting capabilities

| Capability | Widgets that support it |
| --- | --- |
| **Multi-session overlay** (one trace per visible session in palette colors) | Strip Chart, GPS Track, XY Plot, Histogram, FFT, Lap Delta, Lap Panel, Channel Report, Time Report |
| **Distance mode** (lap-relative distance instead of elapsed time) | Strip Chart, Lap Delta (distance-only), Sector Table (distance-only) |
| **Cursor scrub** (live readout at cursor position) | Numeric Readout, Round Gauge, Bar Gauge, Engine Bar, Tire Grid, Steering Wheel, Strip Chart (hover), XY Plot, Lap Delta |
| **Click-to-scrub** (click anywhere on the plot to move the cursor) | Strip Chart, GPS Track, XY Plot, Lap Delta |
| **Datum markers / global zoom** (shift+click to drop, shift+drag to zoom) | Strip Chart, XY Plot, Histogram, FFT, Zone Stats |
| **Warn / alarm thresholds** (color escalation at configurable values) | Numeric Readout, Round Gauge, Bar Gauge, Engine Bar, Tire Grid |

---

## Strip Chart

**Type id:** `strip_chart` · **Default size:** 12×5 · **Purpose:** plot time-series traces of multiple channels with independent Y ranges per channel.

Powered by uPlot, scrubbable on click and drag.

**Config:**
- `channels[]` — list of `{ id, color, yMin?, yMax? }`. Each channel gets its own optional Y range; blank falls back to the chart-level min/max.
- `yMin / yMax` — chart-level fallback Y range.
- `xMode` — `"time"` (elapsed seconds, default) or `"distance"` (per-lap meters, draws only Main / Ref / Overlay laps).

Same-range channels share an axis; the chart caps at two axes total. Each axis's tick color matches the channel color. Bottom-edge legend renders as in-canvas pills (no clipping). Date-formatted X labels are forced off (`scales.x.time = false`); the formatter is `formatElapsed`.

---

## Numeric Readout

**Type id:** `numeric_readout` · **Default size:** 4×3 · **Purpose:** show one channel's current value as a big number.

**Config:** `channelId`, `units`, `decimals`, `warn?`, `alarm?`. Color escalates: alarm (≥) → red #EF5350, warn (≥) → yellow #FFB800, else gray #D8DCE2. Renders `—` if the channel is missing.

---

## Round Gauge

**Type id:** `round_gauge` · **Default size:** 4×5 · **Purpose:** arc-style dial with a needle.

**Config:** `channelId`, `units`, `decimals`, `min`, `max`, `warn?`, `alarm?`, `sweepAngle?` (radians; default 3π/2). DPI-aware canvas; warn/alarm zones drawn on the arc.

---

## Bar Gauge

**Type id:** `bar_gauge` · **Default size:** 3×5 · **Purpose:** vertical or horizontal bar with peak-hold marker.

**Config:** `channelId`, `units`, `decimals`, `min`, `max`, `orientation` (`"vertical"` | `"horizontal"`), `warn?`, `alarm?`. Peak-hold marker resets when the channel, range, or session changes.

---

## Engine Bar

**Type id:** `engine_bar` · **Default size:** 24×2 · **Purpose:** RPM bar with shift-light segments and gear readout.

**Config:** `rpmChannelId`, `gearChannelId?`, `redline`, `shiftLightStart`, `segments` (default 30). Segments glow blue (safe), yellow (shift light), red (over redline). Left-pane gear display shows the current gear or `N` for neutral. Peak-hold RPM number resets on session/zoom change.

---

## GPS Track

**Type id:** `gps_track` · **Default size:** 8×6 · **Purpose:** map view of the lap path.

**Config:** `latChannelId`, `lonChannelId`, `color?`, `colorByChannelId?` (gradient by channel value), `basemap` (`"none"` | `"dark"` | `"satellite"` | `"custom"`), `customTileUrl?`, `trackLabels` (`"none"` | `"turns"` | `"turns_and_straights"`), `labelSensitivity` (`"low"` | `"medium"` | `"high"`).

Basemap layers (when not `"none"`):

| Mode | Tile source |
| --- | --- |
| `dark` | CARTO Dark Matter |
| `satellite` | Esri World Imagery |
| `custom` | user `{z}/{x}/{y}` URL template |

MapLibre is `interactive: false`; the canvas overlay handles all click/drag. **Null-island guard**: any session whose every sample sits inside the 1°×1° box around (0, 0) is excluded from the unified bbox so a no-fix session doesn't collapse real tracks. **GPS micro-degree decode**: values past ±1000 are treated as int32-as-uint32 micro-degrees and rescaled — fixes MoTeC ADL exports where −111.93° comes through as `3175683584`.

Turn/straight labels (`T1, T2, …, S1, S2, …`) prefer `imu.lat_g` for noise resistance; fall back to GPS-derived yaw rate. Cached per `${session.id}:${n}:${mode}:${sensitivity}` so frames don't recompute.

---

## XY Plot

**Type id:** `xy_plot` · **Default size:** 8×6 · **Purpose:** 2D scatter / regression plot. The most configurable widget.

**Config:** `xChannelId`, `yChannelId`, optional bounds, `filter?` (math-expr; falsy rows excluded), `groupByChannelId?` (distinct values become palette groups), and a versioned `overlays[]` array.

Each overlay has a `kind` and a `config`:

| Kind | Options |
| --- | --- |
| `scatter` | color, pointSize, alpha, trail (gradient from trailFromColor to trailToColor) |
| `fit` | linear or polynomial degree 1–6; or exp / log / power. ±σ band, extrapolation. |
| `formula` | any math-expr `y = f(x)`. |
| `bins` | mean / median / p25 / p75 lookup curve. |
| `stats` | corner-anchored count, μ, σ, r, R² + equation text. |
| `quadrant-fit` | 4 regressions split at axis zero (the killer feature for damper bump-vs-rebound). |
| `friction-circle` | circular constraint envelope. |

Simple ↔ Advanced toggle swaps the editor UI. Legacy v1 configs auto-migrate to v2 with a default scatter overlay. Click-to-scrub finds the closest sample in xy-space.

---

## Histogram

**Type id:** `histogram` · **Default size:** 8×5 · **Purpose:** value distribution.

**Config:** `channelId`, `bins` (default 30), `min?`, `max?`, `color`, `splitAt?` (vertical marker with per-side `n=…, μ=…` annotations), `splitSymmetric?` (mirror range around split).

Bin edges realign so one sits exactly on `splitAt` — no bin straddles compression/rebound when `splitAt = 0` on a shock pot. Subscribes to the global zoom; recomputes bins when zoom range changes. Multi-session uses stepped outlines + light fill; single-session uses filled bars.

---

## Tire Grid

**Type id:** `tire_grid` · **Default size:** 8×6 · **Purpose:** four-corner tire temp + pressure + optional wear.

**Config:** `tempChannels.{lf,rf,lr,rr}`, `pressureChannels.{lf,rf,lr,rr}`, `wearChannels?.{lf,rf,lr,rr}`, `tempMin`, `tempMax`, `tempCool`, `tempHot`.

Color gradient: <tempCool blue, optimal range green→yellow, >tempHot red. Wear shows as a horizontal bar 0–100% under the pressure readout. Updates at 60 Hz via the cursor emitter.

---

## Lap Panel

**Type id:** `lap_panel` · **Default size:** 6×5 · **Purpose:** sortable lap list with click-to-select.

**Config:** `perSession` (one block per visible session vs primary only), `hideUntrusted` (filter out-laps and in-laps).

Click row → set Main; ⌘/Ctrl-click → Ref; Shift-click → toggle Overlay. Best lap shown in gold. Delta-to-best displayed per row.

---

## Alarm Panel

**Type id:** `alarm_panel` · **Default size:** 6×5 · **Purpose:** event table.

**Config:** `alarms[]` array of `{ severity, channel, value, message, timestamp }`. Severity color: info blue, warn yellow, critical red. Read-only — alarms are populated externally (a Plan-5 rules feed in a future release).

---

## Steering Wheel

**Type id:** `steering_wheel` · **Default size:** 4×5 · **Purpose:** animated steering angle.

**Config:** `channelId`, `units` (default `"°"`), `maxAngle` (default 90), `invert`. Bitmap rim/spokes from a real photo of the Helios wheel rotate by the channel value. Numeric readout turns red when `|angle| > maxAngle`.

---

## Channel Report

**Type id:** `channel_report` · **Default size:** 12×6 · **Purpose:** per-lap × per-channel statistics table.

**Config:** `channelIds[]`, `stats[]` (any combo of `avg / min / max / abs_max / start / end / change / stddev`), `hideUntrusted`, `perSession`. Sticky lap-number column, striped by channel.

---

## Time Report

**Type id:** `time_report` · **Default size:** 8×6 · **Purpose:** lap-time summary.

**Config:** `perSession`, `hideUntrusted`, `rollingWindow` (default 3 — MoTeC i2 parity). Computes best, mean, median, std-dev, consistency % (`100 × (1 − σ/best)`), and a rolling-window best (highlights the fastest N consecutive laps). Per-lap rows with delta vs best.

---

## Zone Stats

**Type id:** `zone_stats` · **Default size:** 10×5 · **Purpose:** stats inside a user-defined time zone.

**Config:** `channelIds[]`. Zone is defined by datum markers: two datums → between them; one datum → datum-to-cursor; none → "no zone" message. Per channel: min, max, mean, stddev, start, end, duration.

---

## FFT / Spectrum

**Type id:** `fft` · **Default size:** 10×6 · **Purpose:** frequency-domain analysis.

**Config:** `channelId`, `useZoomRange` (restrict FFT to current global zoom), `windowed` (apply Hanning), `scale` (`"linear"` | `"db"`), `freqScale` (`"linear"` | `"log"`), `fmaxHz` (display max; 0 = auto Nyquist).

Cooley–Tukey FFT, power-of-2 window aligned via `pow2Floor`. Sample rate inferred from first/last timestamp in the window. Multi-session renders each visible session as a separate trace.

---

## Lap Delta

**Type id:** `lap_delta` · **Default size:** ad-hoc · **Purpose:** Δt(distance) between Main and Ref laps.

**Config:** none — driven entirely by the global lap selection. Requires a speed channel (`gps.speed`, `vehicle.speed`, `wheel.speed_avg`, or `engine.wheel_speed_avg`) and lap detection on both sessions. Renders green when Main is faster, red when slower, gray when tied (within ±5 ms).

---

## Sector Table

**Type id:** `sector_table` · **Default size:** ad-hoc · **Purpose:** equal-distance sector splits per lap.

**Config:** `sectorCount` (default 3), `maxRows` (default 8), `hideUntrusted`. Divides each lap into N equal-distance sectors using cumulative speed integration; gold-highlights fastest sector time per sector; purple-highlights fastest overall lap.

---

## Widget contract (for developers)

To add a new widget:

1. Create `packages/widgets/src/<your-widget>/{index,render,config-editor}.tsx`.
2. Implement `Widget<Config>` with `type`, `defaultConfig`, `ConfigEditor`, `Render`, `requiredChannels(config)`.
3. Re-export from [`packages/widgets/src/index.ts`](../../packages/widgets/src/index.ts).
4. Add the entry to the `widgets` map in [`apps/desktop/src/components/Tile.tsx`](../../apps/desktop/src/components/Tile.tsx) and to the palette in [`AddTileModal.tsx`](../../apps/desktop/src/components/AddTileModal.tsx).
5. Add at least one render test in `packages/widgets/tests/`.

Use the standard patterns:

- **rAF-coalesced cursor subscription** when bridging the emitter to React state (any widget that calls `setState` on every emit).
- **`drawRef.current` pattern** for canvas widgets — refs mutate during render, so `useResizeObserver` always gets the latest `draw` function.
- **`round-at-emit-site`** for any code that emits cursor times in seconds (`Math.round(tS * 1_000_000)`).
