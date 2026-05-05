# Helios Architecture

The authoritative design spec is at `docs/superpowers/specs/2026-05-04-helios-design.md`.

This file is a quick orientation pointer for new contributors.

## Layers (top → bottom)

1. **Widgets** (`packages/widgets/`) — pure React renderers. Each widget implements the `Widget<Config>` contract: `defaultConfig`, `ConfigEditor`, `Render`, `requiredChannels`. The global `widgetRegistry` maps `type` → widget. Widgets receive a `ChannelSlice` and a `CursorEmitter` ref; they update imperatively on cursor events to avoid React re-renders at 100 Hz.

2. **Session** (Plan 1: minimal stub in `apps/desktop/src/workspaces/`; full layer arrives in Plan 3) — workspaces, layouts, math channels, alarms, datums, laps, cursor, playback. Plan 1 ships a single hardcoded workspace; Plan 3 introduces the full session reducer + persistence.

3. **Channel Store** (`packages/store/`, `crates/helios-*`) — the only place samples live. Rust crates parse CSV (and later `.ld`) into rate-grouped Arrow tables; a Tauri command serializes each rate group as Arrow IPC bytes; the TS `ChannelStore` decodes them back into typed arrays. `slice()` is the hot path: binary-search on `time_us`, return parallel `Float64Array`s for the requested channels.

## Channel registry

`docs/channels.yaml` is the canonical SDM26 channel inventory. The CSV loader resolves column names against alias lists in this file. Unknown columns get auto-registered with sane defaults derived from header suffixes (`_psi`, `_rpm`, `_pct`, etc.).

## How to add a new channel

1. Add an entry to `docs/channels.yaml`.
2. Add the column to your CSV (or alias an existing column name).
3. Reference the channel id in any widget config.

Channels never need code changes.

## How to add a new widget

1. Create `packages/widgets/src/<your-widget>/{index,render,config-editor}.tsx`.
2. Implement the `Widget<Config>` contract.
3. Re-export from `packages/widgets/src/index.ts`.
4. Add it to the `widgets` map in `apps/desktop/src/components/Tile.tsx`.
5. Add at least one render test in `packages/widgets/tests/`.
