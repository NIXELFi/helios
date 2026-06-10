# Helios

**Sun Devil Motorsports ground-station suite.** Tauri 2 (Rust + React) desktop app that brings telemetry analysis, file vault, CFD simulation, project management, and team tooling into a single authenticated workspace.

> **Current release:** `v4.2.0` — see [Releases](https://github.com/NIXELFi/helios/releases) and [`v2_changes/`](v2_changes/) for the full changelog.

---

## Modules

| Tab | Auth required | Description |
|-----|:---:|-------------|
| **Logs** | — | Load CSV/MoTeC telemetry sessions, overlay laps, scrub/play back, define math channels, build a custom tile workspace |
| **Vault** | ✓ | PDM file vault — check in/out, version history, who-has-what, folder management, drag-and-drop import, recycle bin |
| **CFD** | — | Quasi-1D engine cycle simulator — parametric sweeps, PV loops, performance trends, live optimization podium |
| **PM** | ✓ | Project management — task table, Kanban board, Gantt, dependency graph, calendar, activity feed, season scoping |
| **Games** | ✓ | Arcade lobby — Breakout, Flappy Bird, Snake, 2048 — with global leaderboards |

---

## Highlights

### Logs
- **Multi-session overlay** — load any number of CSVs; tick sessions in the left rail to overlay them on every chart in distinct palette colors.
- **MoTeC CSV ingest** — handles plain time-series CSVs and MoTeC i2 exports (metadata-block prefix, quoted values, units row). Channel registry in [`docs/channels.yaml`](docs/channels.yaml) maps display names to canonical IDs via aliases. Decodes MoTeC ADL's int32-as-uint32 micro-degree longitude quirk automatically.
- **Workspace editor** — 24×16 snap grid, drag-to-move, corner-resize, 12 widget types (strip chart, GPS track, XY scatter, histogram, lap panel, gauges, tire grid, steering wheel, FFT, and more). Workspaces persist to localStorage.
- **Math channels** — define computed channels by formula: `derivative(engine.rpm)`, `lowpass(imu.lat_g, 5)`, `engine.rpm * 0.1047`. Full operator precedence, ternary, comparison/logical ops, 17 scalar functions, time-aware ops (`derivative integral shift smooth lowpass`). New channels appear in every picker instantly.
- **GPS basemap** — dark canvas, CARTO Dark Matter, Esri World Imagery, or custom tile URL. Auto-detects turns/straights (T1/S1 labels) using `imu.lat_g` when available.
- **Playback** — ▶/pause + 0.25–8× speed; spacebar toggles; click any scrubbable chart to re-anchor.

### Vault
- Check in/out, get-latest, force-unlock, cancel-checkout for individual or bulk files.
- Version history, audit log, and a "who has what" view for the whole team.
- Folder soft-delete, local-deletion detection, batch restore, reveal-in-Finder/Explorer.
- Storage backend: Supabase `pdm` schema + `vault-objects` bucket (gzip blobs keyed by SHA-256). Per-vault season isolation via `useActiveVault`.
- **Windows Explorer shell extension** and **SolidWorks add-in** (see below) bring vault actions into the tools engineers already use.

### CFD
- Quasi-1D finite-volume engine cycle simulator (`engine-sim` Rust crate).
- Config editor for cylinder geometry, combustion params, valve timing, restrictor specs.
- Parametric sweep studies — results stored in `cfd/captures/`, visualized as cycle charts, PV loops, and RPM-sweep overlays.
- Live optimization podium, trends chart, universal CSV/JSON export.
- Per-season configs (`cfd/configs/sdm25.json`, `sdm26.json`, …).
- MCP server (`helios-mcp`) exposes the simulator over stdio JSON-RPC 2.0 for AI agent integration.

### Vault + PM — Supabase backend
Both modules share a single Supabase project (Postgres 17, `us-east-2`):
- `pdm` schema — Vault file objects, versions, locks, audit log, subteams, RLS policies.
- `pm` schema — tasks, milestones, build records, vendors, calendar events, comments, subteams, RLS policies. Season-scoped via `pm.projects` (`car_year` + `car_code`); `clone_project_as_template()` RPC.
- One auth session shared across all tabs (`@helios/auth`, `<AuthShell>` above the shell picker).

---

## Quick start

```bash
pnpm install
pnpm dev          # Vite + Tauri dev window with HMR
```

Seeds three bundled CSVs into the Sessions panel automatically.

## Installing a release build

Download the latest installer for macOS / Windows / Linux from the [Releases page](https://github.com/NIXELFi/helios/releases).  
First-run instructions for un-signed installers are in [`docs/INSTALL.md`](docs/INSTALL.md).

## Building from source

| # | Tool | Notes |
|---|------|-------|
| 1 | **Node 20+ and pnpm 9** | `npm install -g pnpm@9` |
| 2 | **Rust stable** | [rustup.rs](https://rustup.rs) |
| 3 | **C/C++ toolchain** | Windows: Visual Studio 2022 Build Tools with *Desktop development with C++*. GNU via Scoop also works — see [`.cargo/config.toml`](.cargo/config.toml). |
| 4 | **WebView2** | Pre-installed on Windows 11. |

```bash
pnpm install
pnpm dev          # development build with HMR
pnpm build        # release build (tauri build)
```

---

## Repo layout

```text
apps/
  desktop/           Tauri 2 shell + React frontend (the app)

packages/            TypeScript packages
  auth/              Supabase auth context + hooks (useUser, useSession)
  lib/               Cursor emitter, math-expression engine, lap tracker, FFT, GPS utils
  store/             Apache Arrow-based channel store + data slicing (Tauri-integrated)
  widgets/           12+ React visualization widgets (strip chart, GPS, gauges, FFT, …)
  ui/                Primitive components + theme tokens
  pm-ui/             PM task table, status badges, critical-path computation
  cfd-core/          CFD DTOs + state (no Tauri runtime dependency)
  engine-sim/        Quasi-1D finite-volume engine cycle simulator (Rust)
  pdm-core/          Vault PDM domain types (file, folder, lock, version, audit)
  pdm-client/        HTTP client for vault PDM operations
  pdm-sw-parser/     SolidWorks .sldasm/.sldprt parser (Compound File Binary)
  helios-mcp/        MCP server — exposes engine-sim/cfd-core over stdio JSON-RPC 2.0

crates/              Rust crates
  helios-core/       Core types: channel metadata, rate groups, time ranges
  helios-csv/        CSV loader + MoTeC preprocessor → Arrow
  helios-arrow/      Arrow IPC helpers for in-memory columnar telemetry
  helios-bench/      Physics sim CLI driver (engine-sim + cfd-core, batching)

cfd/                 Per-season CFD configs + timestamped simulation captures
infra/
  pdm-supabase/      Supabase project: migrations, RLS, RPCs, storage config

shell-ext/           Windows Explorer shell extension (C#) — vault context menu
solidworks-addin/    SolidWorks Task Pane add-in (C# / .NET 4.8) — in-app vault
sw-helper/           HeliosSwReadonly.exe — flips read-only state of SW docs via COM

scripts/             Version bump, sample data generators, CI helpers, physics orchestrator
docs/                Architecture guide, channel registry, install guide, design docs
fixtures/            CSV test fixtures (good / malformed / multi-rate / MoTeC)
samples/             Bundled sample telemetry sessions
v2_changes/          Per-issue write-ups for everything landed since v1
```

---

## Tests

```bash
pnpm test          # TypeScript tests across all workspace packages (818 tests)
cargo test         # Rust crate tests
pnpm typecheck     # tsc --noEmit across every workspace package
```

---

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — top-down tour of the four layers (widgets → session → channel store → CSV loader)
- [`docs/channels.yaml`](docs/channels.yaml) — canonical channel registry with display names, units, ranges, and CSV-header aliases
- [`docs/INSTALL.md`](docs/INSTALL.md) — end-user install guide for all platforms
- [`v2_changes/README.md`](v2_changes/README.md) — chronological index of every issue + fix since v1

---

## SolidWorks integration

The SolidWorks add-in (`solidworks-addin/`) and Windows Explorer shell extension (`shell-ext/`) both talk to the running Helios desktop app over a localhost bridge. They expose vault actions (Check Out, Check In, Get Latest, Revision History) directly in SolidWorks' Task Pane and Explorer's right-click menu, keeping both surfaces in sync with the vault state.

`sw-helper/` (HeliosSwReadonly.exe) flips the read-only attribute on SolidWorks files from outside the application — used by the desktop app to make checked-out files writable and re-protect them on check-in.

---

## Adding a new telemetry channel

1. Add an entry to [`docs/channels.yaml`](docs/channels.yaml) with `id`, `display_name`, `units`, `group`, `color`, `data_type`, `sample_rate_hz`, and any CSV-header aliases.
2. The next CSV load picks it up automatically — no code change required.

## Adding a new widget

1. Create `packages/widgets/src/<name>/{index,render,config-editor}.tsx`.
2. Implement the `Widget<Config>` contract.
3. Re-export from `packages/widgets/src/index.ts`.
4. Register in `apps/desktop/src/components/Tile.tsx` and `AddTileModal.tsx`.
5. Add at least one render test in `packages/widgets/tests/`.

---

## CI / Release

GitHub Actions workflows in `.github/workflows/`:
- `ci.yml` — runs `pnpm test`, `pnpm typecheck`, and `cargo test` on every push.
- `release.yml` — triggered on `v*` tags; builds and signs macOS (×2), Windows, and Linux installers; publishes a GitHub Release draft; triggers the auto-updater.

Bump versions with `scripts/bump-version.mjs` (synchronizes `package.json`, `tauri.conf.json`, and `Cargo.toml`).

---

## License

MIT — see `Cargo.toml` `workspace.package.license`.
