# Developer guide

This page covers setting up a dev environment, running tests, building releases, and the CI workflow.

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| **Node** | 20+ | Use the version manager of your choice. |
| **pnpm** | 9 | `npm install -g pnpm@9`. Locked via the `packageManager` field. |
| **Rust** | stable | Install via [rustup](https://rustup.rs). Edition 2021, workspace-wide. |
| **C/C++ toolchain** | platform-specific | See below. |

Platform-specific:

- **Windows** — easiest path is **Visual Studio 2022 Build Tools** with the *Desktop development with C++* workload (provides MSVC linker). If admin install isn't available, GNU toolchain via [Scoop](https://scoop.sh) works — see [`.cargo/config.toml`](../../.cargo/config.toml) which configures `x86_64-pc-windows-gnu` with `x86_64-w64-mingw32-gcc` and `lld`.
- **Windows runtime** — **WebView2** is pre-installed on Windows 11; Tauri uses it as the rendering runtime.
- **macOS** — system headers (included in Xcode command-line tools).
- **Linux (Ubuntu 22.04+)** — `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libsoup-3.0-dev`.

## Setup

```bash
pnpm install
```

Locked via `pnpm-lock.yaml`. CI uses `--frozen-lockfile`; locally pnpm allows upgrades.

## Dev workflow

```bash
pnpm dev
```

`pnpm dev` → `turbo run dev --filter=@helios/desktop` → `tauri dev`, which:

1. Starts Vite on port 1420 (strict).
2. Opens a 1600×1000 Tauri window with the overlay title bar.
3. HMR is enabled for the React/TS frontend; Rust backend changes require restart.

Bundled CSV samples are seeded automatically on first launch.

## Tests

```bash
pnpm test          # all TS/JS tests (vitest, serial across packages)
cargo test --workspace --locked   # all Rust tests
pnpm typecheck     # tsc --noEmit across every workspace package
```

| Package | Runner | Notes |
| --- | --- | --- |
| `@helios/lib` | vitest | Math expressions, time helpers, regression, statistics, view-state, file-open summary. |
| `@helios/store` | vitest | ChannelStore + slice. |
| `@helios/widgets` | vitest | Widget render + integration. |
| `@helios/auth` | vitest | Auth provider. |
| `@helios/desktop` | vitest + jsdom | UI + integration (largest test surface). |
| `@helios/pdm-supabase` | vitest | Skipped in CI (no Supabase secrets); runs locally if `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are set. |
| `helios-core`, `helios-csv`, `helios-arrow`, `pdm-*` | cargo test | All under `crates/`. |

Visual tests (`test:visual`) were removed in commit `58a3bfe` — no widget had real visual coverage.

## Build & release

```bash
pnpm build    # → tauri build
```

Per-OS output:

| OS | Files |
| --- | --- |
| macOS | `Helios_<v>_aarch64.dmg`, `Helios_<v>_x64.dmg`, `Helios_<v>_aarch64.app.tar.gz` (+ `.sig`), `Helios_<v>_x64.app.tar.gz` (+ `.sig`) |
| Windows | `Helios_<v>_x64-setup.exe` (preferred for updater), `Helios_<v>_x64_en-US.msi`, `.sig` |
| Linux | `Helios_<v>_amd64.AppImage` (no updater wiring yet) |

Releases are not yet OS-signed (no Apple Developer ID / Authenticode cert), so first-run shows Gatekeeper / SmartScreen warnings. Subsequent in-app updates verify via Tauri's minisign and bypass OS warnings.

## Updater

`tauri-plugin-updater` is configured in [`tauri.conf.json`](../../apps/desktop/src-tauri/tauri.conf.json):

```json
"updater": {
  "active": true,
  "endpoints": ["https://github.com/NIXELFi/helios/releases/latest/download/latest.json"],
  "pubkey": "..."
}
```

The updater capability is isolated in [`capabilities/updates.json`](../../apps/desktop/src-tauri/capabilities/updates.json) (scoped to the `main` window) — separate from the default capability so it can be revoked independently.

## Versioning

Single source of truth across four files, kept in sync by [`scripts/bump-version.mjs`](../../scripts/bump-version.mjs):

```bash
node scripts/bump-version.mjs 3.2.1
```

Updates:

1. `package.json` (root)
2. `apps/desktop/package.json`
3. `apps/desktop/src-tauri/tauri.conf.json`
4. `Cargo.toml` `[workspace.package].version`

After a bump, regenerate the Cargo lockfile:

```bash
cargo update --workspace
```

Then commit both. CI runs `node scripts/check-versions.mjs` at release tag time and fails the build if any file disagrees with the tag.

## CI workflows

### `.github/workflows/ci.yml` — every PR and push to `main`

Two jobs on `ubuntu-latest`:

- **test** — `pnpm install --frozen-lockfile` → `pnpm typecheck` → `pnpm -r --workspace-concurrency=1 --filter '!@helios/pdm-supabase' test`.
- **cargo-test** — install Linux deps → `cargo test --workspace --locked`.

PRs auto-cancel superseded runs; main pushes run independently.

### `.github/workflows/release.yml` — on `v*` tag or `workflow_dispatch`

Single matrixed `build` job across 4 platforms, **sequential** (`max-parallel: 1`) because `tauri-action`'s `latest.json` merge is racy under parallel writes:

1. `macos-aarch64` (macos-14, target `aarch64-apple-darwin`)
2. `macos-x64` (macos-14, target `x86_64-apple-darwin`)
3. `windows` (windows-latest)
4. `linux` (ubuntu-22.04)

Each platform:

1. Resolve tag (`workflow_dispatch.inputs.tag` or `${GITHUB_REF_NAME}`).
2. Setup Node/pnpm/Rust/cargo-cache.
3. Linux: install webkit2gtk + deps.
4. `pnpm install --frozen-lockfile`.
5. **`node scripts/check-versions.mjs`** — fails fast if any file is out of sync with the tag.
6. `cargo test --workspace --locked`.
7. `pnpm -r --workspace-concurrency=1 --filter '!@helios/pdm-supabase' test`.
8. `tauri-action@v0` builds, signs with `TAURI_SIGNING_PRIVATE_KEY`, and uploads to a **draft** GitHub release. `updaterJsonPreferNsis: true` so Windows uses NSIS for the updater payload.

A follow-up **`publish`** job (Ubuntu, skipped on `-rc/-beta` tags) runs `gh release edit --draft=false` to publish.

Secrets used:

- `GITHUB_TOKEN` (provided)
- `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` (baked into the frontend at build time)

## Tauri config highlights

[`apps/desktop/src-tauri/tauri.conf.json`](../../apps/desktop/src-tauri/tauri.conf.json):

- **Window** — 1600×1000, resizable, overlay title bar, hidden title, traffic-light position `(14, 14)`, `dragDropEnabled: false` (the frontend handles drops via `useFileDrop`).
- **CSP** — explicit allow list: `connect-src` permits `ipc:`, `https://*.supabase.co`, `wss://*.supabase.co`; `img-src` allows `data:`, `blob:`, `https:`; `script-src` allows `'wasm-unsafe-eval'`.
- **Bundled resources** — sample CSVs + `docs/channels.yaml` bundled into the binary.
- **File associations** — `.helios` registered as `application/x-helios-bundle` with role `"Editor"`. Wired up so double-clicking a `.helios` file launches Helios with the path.
- **fs:scope** — `"**"` (widened back from a narrower scope per product requirement in commit `9802f44`).

## Repo layout

```
apps/desktop/        Tauri shell + React frontend (the app)
  src/               React components, hooks, helpers
  src-tauri/         Rust shell, IPC commands, capabilities
  tests/             vitest + jsdom tests

crates/              Rust crates
  helios-core/         channel store core types
  helios-csv/          CSV loader (incl. MoTeC + Link preprocessors)
  helios-arrow/        Arrow IPC helpers
  pdm-core/            PDM domain model
  pdm-sw-parser/       PDM software parser
  pdm-client/          PDM client library

packages/            TypeScript packages
  lib/               cursor emitter, time helpers, math-expression engine, FFT, regression, statistics
  store/             JS-side channel store + slice
  widgets/           18 widgets
  ui/                primitives
  auth/              Supabase auth provider + hooks

docs/                architecture, channel registry, install, ui audit
  wiki/              ← you are here
samples/             bundled sample sessions
fixtures/            CSV test fixtures (good / malformed / multi-rate / motec)
infra/               Supabase backend (pdm-supabase package)
v2_changes/          per-issue write-ups for everything landed since v1
scripts/             bump-version, check-versions, sample generators
```

## Adding things

### Add a channel
See [Channels & data → Adding a new channel](05-channels-and-data.md#adding-a-new-channel).

### Add a widget
See [Widgets reference → Widget contract](04-widgets-reference.md#widget-contract-for-developers).

### Add a CSV format
See [Channels & data → Adding a new CSV format](05-channels-and-data.md#adding-a-new-csv-format).

### Add a command-palette action
1. Open [`apps/desktop/src/App.tsx`](../../apps/desktop/src/App.tsx), find the `paletteActions: PaletteAction[]` build block (around line 397-532).
2. Push a new `{ id, label, sublabel?, kind, keywords?, hint?, run }`.
3. `kind` must be one of: `"workspace" | "session" | "system" | "channel" | "lap"`.
4. Done. The palette rebuilds on every render.

### Add a hotkey
Edit the global `onKey` handler in [`apps/desktop/src/App.tsx`](../../apps/desktop/src/App.tsx) (around line 210-304). Check `e.metaKey || e.ctrlKey` for modified keys; skip text inputs for single-character bindings.

## Reference files

- [`README.md`](../../README.md) — short project intro.
- [`docs/architecture.md`](../architecture.md) — top-down tour of the four layers.
- [`docs/INSTALL.md`](../INSTALL.md) — release-build install instructions.
- [`docs/ui-audit-followups.md`](../ui-audit-followups.md) — known UX gaps and planned fixes.
- [`turbo.json`](../../turbo.json) — task pipeline.
- [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml) — workspace packages.
- [`Cargo.toml`](../../Cargo.toml) — Rust workspace.
- [`tauri.conf.json`](../../apps/desktop/src-tauri/tauri.conf.json) — Tauri shell config.
