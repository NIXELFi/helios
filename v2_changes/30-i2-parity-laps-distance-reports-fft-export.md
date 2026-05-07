# 30 · i2 parity pass — laps, distance axis, reports, FFT, export · v2.5.0

Single big push toward MoTeC i2 feature parity. Shipped as v2.5.0. See
`docs/i2-parity-changeset.md` for the full ranked list of what landed and
what's recommended next.

## Highlights

- **Laps as first-class entities.** New `@helios/lib/laps` module with
  detection from a GPS start-finish line, beacon channel, math expression,
  or manual list of crossings. Per-session lap config persists in
  localStorage; recomputes live in the new Lap Config dialog.
- **Lap selection (Main / Ref / Overlays).** New `LapSelectionEmitter` at
  app level. Click in the lap panel selects Main; ⌘-click sets Ref;
  shift-click toggles an overlay. Header pill surfaces the current set.
- **Distance-axis strip chart.** New `xMode: "time" | "distance"` on the
  strip-chart config. Distance mode renders only the laps in the global
  selection, aligned by per-lap distance integrated from the speed channel.
- **Channel report widget.** Per-lap × per-channel × stat (avg, min, max,
  abs-max, start, end, change, σ). Multi-session blocks. Hide untrusted.
- **Time report widget.** Lap-time table with consistency %, rolling-window
  best, configurable window size.
- **Zone stats widget.** Datum-to-datum (or datum-to-cursor) stats panel:
  duration, Δ, μ, σ, min, max, slope/s.
- **FFT / spectrum widget.** Self-contained Cooley–Tukey FFT in
  `@helios/lib/fft`, Hanning window, linear/dB scale, linear/log frequency
  axis, optional zoom-range restriction.
- **CSV + KML export** via the new Export menu in the header.
- **Math expression engine upgrades:** `lap_max/min/mean/first/last`,
  `stat_min/max/mean/std_dev/start/end`, `integrate_over`, `time_valid`,
  `edge_delay`, `range_change`, `flip_flop`, `previous_sample`, `highpass`.
  Plus `// line` and `/* block */` comments.
- **Built-in "Lap Analysis" workspace** that lays out the new widgets so
  users discover them on first launch.

## Files touched

New:
- `packages/lib/src/laps.ts`, `fft.ts`
- `packages/widgets/src/{channel-report, time-report, zone-stats, fft}/`
- `apps/desktop/src/lib/{lap-config, csv-export, kml-export}.ts`
- `apps/desktop/src/components/LapConfigDialog.tsx`
- `apps/desktop/src/workspaces/lap-analysis.ts`

Updated:
- `packages/lib/src/{index, math-expr}.ts`
- `packages/widgets/src/{index, types}.ts`
- `packages/widgets/src/{lap-panel, strip-chart}/`
- `apps/desktop/src/lib/{vector-ops, math-channels, session, load-sample}.ts`
- `apps/desktop/src/{App, components/Tile, components/ConfigPanel, components/AddTileModal, components/SessionPanel}.tsx`
- `apps/desktop/src/workspaces/{types, index, overview-default}.ts`

## Verified

- `pnpm typecheck` — green across all 5 packages.
- `pnpm test` — 127 tests pass (73 desktop, 54 widgets).
- `cargo check` — green on the Tauri side.
- `pnpm vite:build` — production frontend bundle builds; csv-export and
  kml-export are code-split as lazy chunks (only loaded when the user opens
  the Export menu).

## Verified live

- `pnpm dev` ran end-to-end — channel report + session stats both showed
  laps; lap-panel + time-report initially showed empty (`requiredChannels()`
  returning `[]` was filtered out by `Tile.tsx`'s zero-slice guard); fixed
  by branching the filter on whether the widget asked for any channels.
- GPS picker UI: dialog collapses to a banner, GPS widget gets a pulsing
  yellow border + banner, click projects back to lat/lon, fields fill in.

## Post-ship items

- Lap detection on the bundled real MoTeC CSV needs a venue-matched
  start-finish point. Default config picks the GPS bbox center, which is
  rarely the start-finish — users will pick from the map (now possible via
  the new picker).
