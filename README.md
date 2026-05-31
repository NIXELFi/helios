# Helios

**Sun Devil Motorsports ground-station suite.** Tauri (Rust + React) desktop app for ingesting CSV data-log exports, overlaying multiple sessions, scrubbing through laps, defining math channels, and laying out a custom workspace of plots and gauges — MoTeC i2 in spirit, with editing built in.

> **Status:** `v2.2` — see [`v2_changes/`](v2_changes/) for the running log of every issue and fix landed since the v1 baseline.

## Highlights

- **Multi-session overlay.** A collapsible left rail lists every loaded CSV; tick more than one to overlay them on every plot. Strip charts, GPS tracks, XY scatters, and histograms all draw a trace per visible session in distinct palette colors. Click any track / chart to scrub the cursor — emits the closest sample's time across sessions.
- **MoTeC CSV ingest.** Out of the box the loader handles plain time-series CSVs *and* MoTeC i2 exports (the metadata-block-prefixed format with quoted values and a units row). The channel registry in [`docs/channels.yaml`](docs/channels.yaml) maps human-readable MoTeC column names to canonical channel ids via aliases. The GPS widget also decodes MoTeC ADL's int32-as-uint32 micro-degree quirk so longitudes like "3175683584" round-trip back to "-111.93°" without a config change.
- **Workspace editor.** Drag tiles to move, drag the corner to resize, snap to a 24×16 grid. **+ Add tile** drops any of 12 widget types (incl. Steering Wheel) into the next free slot. Per-tile config editor changes channels, ranges, colors, and even widget type (in-place swap). Workspaces persist to localStorage.
- **Math channels.** Define computed channels by formula — `derivative(engine.rpm)`, `lowpass(imu.lat_g, 5)`, `engine.rpm * 0.1047` — with full operator precedence, ternary, comparison/logical ops, 17 scalar functions, and time-aware ops (`derivative integral shift smooth lowpass`). New channels appear in every channel picker and inspector instantly. Drag-and-drop palette of channels, operators, and functions in the editor.
- **GPS basemap.** Toggle the GPS widget between dark canvas, CARTO Dark Matter roads, Esri World Imagery satellite, or a custom tile-URL template. Track polyline + cursor dot project through the active basemap so they ride real lat/lon. Auto-detected turn/straight labels (T1, T2…, S1, S2…) overlay the track when enabled — uses `imu.lat_g` when available for noise-resistant detection, GPS curvature otherwise.
- **Playback.** ▶ / pause + 0.25–8× speed selector in the header drive the cursor at wall-clock rate, so every widget animates together. Spacebar toggles. Click anywhere on a scrubbable plot to re-anchor while playing.
- **Channel inspector.** Header `Channels` button opens a searchable, grouped table of every channel resolved in the primary session.
- **Real loading screen.** Branded splash with a real progress bar driven by per-session load events.

## Quick start

```bash
pnpm install
pnpm dev
```

The dev command runs Vite + the Tauri shell, opens a window, and seeds three bundled CSVs into the Sessions panel.

## Installing a release build

If you don't need to develop — you just want to use Helios — see [`docs/INSTALL.md`](docs/INSTALL.md). It covers downloading the latest installer for macOS / Windows / Linux and the one-time first-run instructions for our (currently un-OS-signed) installers.

## Building from source

The Tauri shell is Rust + React, so you need:

| | Tool | Notes |
| - | - | - |
| 1 | **Node 20+ and pnpm 9** | `npm install -g pnpm@9` if needed |
| 2 | **Rust stable** | Install via [rustup](https://rustup.rs). |
| 3 | **A C/C++ toolchain Rust can link against** | On Windows, the smoothest path is **Visual Studio 2022 Build Tools** with the *Desktop development with C++* workload. If admin install isn't an option, the GNU toolchain via [Scoop](https://scoop.sh) works too — see [`.cargo/config.toml`](.cargo/config.toml) and the build-workarounds note in commit history. |
| 4 | **WebView2** | Pre-installed on Windows 11; the Tauri runtime uses it. |

Then:

```bash
pnpm install
pnpm dev          # development build with HMR
pnpm build        # release build via tauri build
```

## Repo layout

```text
apps/desktop/        Tauri shell + React frontend (the app)
crates/              Rust crates
  helios-core/         channel store core types
  helios-csv/          CSV loader (incl. MoTeC preprocessor)
  helios-arrow/        Arrow IPC helpers
packages/            TypeScript packages
  lib/                 cursor emitter, time helpers, math-expression engine
  store/               JS-side channel store + slice
  widgets/             12 widgets (strip chart, GPS, gauges, steering wheel, math-channel-aware)
  ui/                  primitives
docs/                architecture, channel registry, design spec
samples/             bundled sample sessions
fixtures/            CSV test fixtures (good / malformed / multi-rate / motec)
v2_changes/          per-issue write-ups for everything landed since v1
```

## Tests

```bash
pnpm test          # 62 TypeScript tests across @helios/lib, store, widgets, desktop
cargo test         # all Rust tests in crates/
pnpm typecheck     # tsc --noEmit across every workspace package
```

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — top-down tour of the four layers (widgets → session → channel store → CSV loader)
- [`docs/channels.yaml`](docs/channels.yaml) — canonical channel registry with display names, units, ranges, and CSV-header aliases
- [`v2_changes/README.md`](v2_changes/README.md) — chronological index of every v2 issue + fix, with links into the source

## Adding a new channel

1. Add an entry to [`docs/channels.yaml`](docs/channels.yaml) with `id`, `display_name`, `units`, `group`, `color`, `data_type`, `sample_rate_hz`, plus any CSV-header aliases.
2. The next CSV load picks it up automatically. No code change required.

## Adding a new widget

1. Create `packages/widgets/src/<your-widget>/{index,render,config-editor}.tsx`.
2. Implement the `Widget<Config>` contract.
3. Re-export from `packages/widgets/src/index.ts`.
4. Add it to the `widgets` map in `apps/desktop/src/components/Tile.tsx` and to the palette in [`AddTileModal.tsx`](apps/desktop/src/components/AddTileModal.tsx).
5. Add at least one render test in `packages/widgets/tests/`.

## License

MIT (per `Cargo.toml`'s `workspace.package.license`).
