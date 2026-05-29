# Changelog & feature history

Helios keeps a per-issue running log under [`v2_changes/`](../../v2_changes/) — one Markdown file per change, numbered in landing order. Each file uses a consistent skeleton: *Symptom / motivation*, *Root cause* or *What this commit ships*, *Decisions*, *What's NOT in this commit*, and a *Files changed* manifest.

This page distills the 33 entries into a chronological digest plus a deduplicated feature inventory.

> **Note:** [`v2_changes/README.md`](../../v2_changes/README.md) currently indexes entries 01–28. Entries **29–33** exist as files but are missing from the README — the index needs updating.

## Version timeline

| Version | Entries | Highlights |
| --- | --- | --- |
| **v2.2** (early) | 01–18 | Cursor model, MoTeC ingest, multi-session overlay, edit mode, math channels (A+B), loading screen. |
| **v2.3.x** | 19–25 | GPS basemap, GPS int32 fix, steering wheel, playback, per-channel Y axis, track labels, workspace CRUD. |
| **v2.3.3** | 26 | Workspace tab-strip horizontal scroll + `.helios` launch handler. |
| **v2.4.0** | 27, 28 | **XY analysis plot** (six overlay kinds, filter, group-by, quadrant fit). Polish bundle: global datums/zoom, custom tab scrollbar, edit-mode focus, FpsCounter, panther icon, real steering art. |
| **v2.4.1** | 29 | Histogram split mode + zoom; math channel bracketed-id palette; per-session math apply errors. |
| **v2.5.0** | 30 | **i2 parity pass**: laps as first-class entities, distance-axis strip chart, channel/time/zone reports, FFT widget, CSV + KML export, expanded math engine, Lap Analysis workspace. |
| **v2.5.1** | 31 | User-loaded sessions (`+`/`×`/drag-drop in Sessions panel), Link ECU CSV preamble support. |
| **v2.5.2** | 32 | Smart channel resolver — semantic matching gated by units row; 6 new canonical channels. |
| **v2.5.3** | 33 | Split `engine.tps` / `engine.aps` (plus `_sub` variants); loader collision protection. |
| **v3.0.x – v3.2.x** | (post-v2_changes) | Vault module, channel source-override picker, auto-resolver coverage expansion (~100 aliases), workspace UX polish, ⌘K palette, hotkeys, lap UX, footer compare, Tauri title-bar overlay, app-state persistence, dynamic LoadingScreen version, WCAG AA contrast + ARIA-modal + prefers-reduced-motion. |
| **v3.4–v3.6** | 35–40 | CFD tab (engine-sim port, config editor, sweeps, optimization, wave viewer); UI unification across Log / Vault / CFD + persistent sidebar (brand, version, updater); CFD Clear-data + wave-viewer polish. |
| **v3.7.0** | 41–44 | **App-wide auth + accounts.** User-configurable Supabase connection (bring-your-own project); persistent sign-in / sign-up with mandatory display name + subteam; `owner`/`admin`/`editor`/`viewer` role tiers + in-app admin panel; managed subteams (`pdm.subteams`); password change + forgot-password via 6-digit email OTP over Resend SMTP. |

## Per-entry summary

### 01 — Cursor follows mouse everywhere
Removed the global `onMouseMove` cursor; moved scrubbing into each plot widget with pointer-down/move/up handlers. Cursor only updates when you click/drag on a scrubbable plot.

### 02 — Yellow cursor doesn't align with the pointer
Strip-chart scrub handler now lives on uPlot's `over` element and uses `posToVal(localX, "x")` so input and render coordinate spaces match.

### 03 — UI lags when scrubbing
`CursorEmitter` fires at 100+ Hz; tire-grid was forcing a full React reconcile per event. Fix: coalesce subscriptions through `requestAnimationFrame`. Codified as the standard pattern for any future React-bridging widget.

### 04 — Scrubbing didn't update other widgets
Strip chart emitted fractional µs that crashed `BigInt(t)`. Fix: `Math.round(tS * 1_000_000)` at the emit site. Receivers stay strict.

### 05 — Real MoTeC data
Built the MoTeC preprocessor (metadata-block + units-row stripping; duplicate `Time` dedup) and added MoTeC display-name aliases (`Engine Speed → engine.rpm`).

### 06 — Sample switcher
`SAMPLES` registry + header `<select>` for bundled CSVs. Adding a sample is one registry entry + one in `tauri.conf.json`'s resource map.

### 07 — Workspace switcher (phase 1)
Added a `Workspace = { id, label, tiles[] }` type, an Engine Focus built-in, tab buttons. Read-only on purpose; the editor (phase 2) built on the locked-down model.

### 08 — Multi-session overlay phase A
Introduced `LoadedSession`, the `SessionPanel`, and `overlays?: OverlaySession[]` on widget render props. Strip chart now draws one series per (session × channel) pair.

### 09 — Widgets didn't resize
Built `useResizeObserver` for canvas + uPlot widgets so they reflow when the tile resizes or the sidebar collapses.

### 10 — Multi-session overlay phase B
GPS track (with **null-island guard**), XY plot, histogram brought up to overlay parity.

### 11 — Edit mode + tile config editor
`workspace-storage.ts` (localStorage `helios.workspaces.v1`), `Edit` toggle, click-to-select, right-side `ConfigPanel` mounting each widget's own `ConfigEditor`. Auto-saves on every keystroke.

### 12 — Channel pickers + Channels inspector modal
Reusable `ChannelPicker` (grouped by `ChannelMeta.group`) replaces every plain channel-id input in 9 widget editors. New `Channels` header button opens the inspector modal.

### 13 — Layout editor: drag, resize, add, duplicate, delete
`apps/desktop/src/lib/grid.ts` (24×16 grid, snap helpers, `findNextFreeSlot`), drag-to-move title bar, bottom-right resize chevron, `AddTileModal` palette, ConfigPanel Duplicate/Delete.

### 14 — Snap-to-grid + change widget type
Replaced destructive "Auto-arrange" with `snapAllToGrid()` (preserves each tile's size). Type-swap dropdown in the ConfigPanel lets a tile change widget type in place.

### 15 — Math channels phase A
Hand-rolled tokenizer + recursive-descent parser for math expressions. 18 functions, ternary, bracketed `[Engine Speed]`. Persisted via `helios.math-channels.v1`. New `ƒ Math` header button.

### 16 — Math channels phase B
Added vector ops (`derivative integral shift smooth lowpass`) with synthetic `__v0/__v1` channels in the pre-pass. Drag-and-drop palette of channels, operators, functions in the editor.

### 17 — Config edits not persisting to the canvas
Two causes. (a) Renderers ignored `config.color` after the overlay refactor — fixed by branching on `isMulti`. (b) Canvas widgets' `onResize = useCallback(...)` captured the first render's `draw` — fixed by the `drawRef.current = draw` pattern. Also tightened workspace mutators to functional `setState`.

### 18 — Loading screen + brand wordmark
Imported Orbitron, defined `.font-helios`, built the splash with stage label + percentage + sliding shimmer + error banner. `loadAllSessions` now takes `onProgress`.

### 19 — GPS basemap
MapLibre layered under the GPS canvas. Modes: `none`, `dark` (CARTO), `satellite` (Esri), `custom` URL. Canvas overlay handles all interactions; MapLibre is `interactive: false`.

### 20 — MoTeC GPS int32 decode
Fixed the "lat must be between -90 and 90" crash. `decodeGpsValue(v)` treats values past ±1000 as int32-as-uint32 micro-degrees. Only allocates new buffers when at least one value trips the threshold.

### 21 — Steering Wheel widget
Canvas widget rotates spokes + rim pip by `channelId`; outer-ring ticks at 0 and ±`maxAngle`; numeric turns red over limit.

### 22 — Playback controls
▶/❚❚ + 0.25/0.5/1/2/4/8× speed selector. rAF loop advances cursor; cursor wraps at `endUs`; spacebar toggles (form-aware); user scrub re-anchors.

### 23 — Per-channel Y axis on strip chart
Per-channel optional `yMin/yMax`; unique resolved ranges get their own uPlot scale; same-range channels share an axis; 2-axis cap. Also fixed: bottom legend clipping (in-canvas pills), uPlot date labels (`scales.x.time = false`), axis size 40→60.

### 24 — Auto-labeled turns and straights
`gps-track/turns.ts` pure detector. Prefers `imu.lat_g`, falls back to GPS yaw rate. Three sensitivity presets. Labels cached per `${session.id}:${n}:${labelsMode}:${sensitivity}`.

### 25 — User-managed workspaces
Full CRUD: `+ New`, double-click rename, right-click context menu (Rename, Color ▸, Duplicate, Export…, Delete), drag-to-reorder. New `<ConfirmDialog>` replaces `window.confirm()` (the no-browser-dialogs rule). Export → `helios-workspace-bundle` v1 JSON.

### 26 — Workspace UX polish
Tab strip now lives in `overflow-x-auto` + `w-max`. `.helios` file association wired via `tauri-plugin-single-instance` + `PendingOpenFiles` + `on_page_load` drain + `get_pending_open_files` command. Frontend `useFileOpener` listens, reads, validates, opens a confirm modal.

### 27 — XY Analysis Plot
Upgraded `xy_plot` from fixed scatter to composable analysis. Simple ↔ Advanced toggle; six overlay kinds: scatter, fit (linear / poly 1-6 / exp / log / power, ±σ band, extrapolation), formula, bins, stats, **quadrant-fit**. Per-sample filter expression; group-by channel; global zoom. New `regression.ts` and `statistics.ts` libs.

### 28 — v2.4.0 polish bundle
Panther app icon (yellow squircle). Real steering wheel art bitmap. **Global datums** (shift+click → red-orange vertical line on every plot) and **global zoom** (shift+drag) via `ViewStateEmitter`. Yellow header pills (`Reset zoom`, `Clear datums (N)`). **Custom thin yellow scrollbar** on workspace tabs. **Edit-mode header focus** (session label / tabs / playback hide). `FpsCounter` footer pill. Updater pill reads real version via `getVersion()`. macOS overscroll rubber-band killed.

### 29 — v2.4.1 histogram + math fixes
Histogram **`split at`** field realigns bin edges to land exactly on the split value; dashed marker + per-side `n=…, μ=…`. Optional symmetric range. Histograms subscribe to `ViewStateEmitter`. Math palette auto-wraps non-bare ids in `[…]`; tolerant case/whitespace resolver. Math apply errors are now **per-session**.

### 30 — i2 parity pass (v2.5.0)
**Laps as first-class** via `@helios/lib/laps` (gps-line / beacon / expression / manual; persisted per session). **LapSelectionEmitter** (Main / Ref / Overlay; click / ⌘-click / shift-click). **Distance-axis strip chart** (`xMode: "distance"`). New **Channel Report**, **Time Report**, **Zone Stats**, **FFT** widgets. **CSV + KML export**. Math engine got `lap_*`, `stat_*`, `integrate_over`, `time_valid`, `edge_delay`, `range_change`, `flip_flop`, `previous_sample`, `highpass`, plus `// line` and `/* block */` comments. Built-in **Lap Analysis** workspace. 127 tests pass.

### 31 — User sessions (v2.5.1)
Add / remove / drag-drop user-loaded CSVs. Three entry points: `+` button → native picker (multi-select), drag-and-drop via `useFileDrop`, `×` on hover to remove. **Link ECU CSV preamble** support added. Session id = `user:` + `djb2(absolutePath)` so reloading the same file preserves lap config. Unloadable extensions surface a single per-batch error dialog.

### 32 — Smart channel resolver (v2.5.2)
Three-layer resolver: exact alias → semantic match (tokenize header, search `match_keywords[]` contiguous, gated by `match_units[]`) → default custom channel. **Unit gate** prevents `Oil Pressure` (kPa) from grabbing `engine.oil_temp` (°C). Six new canonical channels added: `oil_pressure`, `fuel_pressure`, `map`, `lambda`, `battery_voltage`, `long_g`.

### 33 — TPS / APS split (v2.5.3)
v2.5.2 had aliased both `TPS` and `APS` (Main/Sub) to `engine.tps` — but they're physically distinct (throttle plate vs driver pedal). Split into `engine.tps`, `engine.tps_sub`, `engine.aps`, `engine.aps_sub` with disjoint keywords. Added **loader collision protection**: keeps the FIRST mapping, demotes later collisions back to their raw header with a warning. Users must reload sessions for the fix to apply.

## Cumulative feature inventory

A deduplicated bullet list of user-visible features Helios gained across all 33 entries, grouped by area.

### Visualization
- Strip chart with per-channel Y axes, same-range grouping, 2-axis cap, in-canvas legend pills, elapsed-time X labels.
- GPS track with toggleable basemap (CARTO dark / Esri satellite / custom XYZ), null-island guard, MoTeC micro-degree decode, click-to-scrub.
- Auto-detected turn / straight labels on the GPS view with low/medium/high sensitivity.
- XY analysis plot with six combinable overlays (scatter, fit, formula, bins, stats, quadrant-fit), filter expression, group-by, zoom integration.
- Histogram with multi-session stepped outlines, split-at-value mode, symmetric range, zoom-aware re-binning.
- Steering wheel widget with rotating bitmap rim/spokes and over-limit color.
- Channel / Time / Zone-stats report widgets; FFT spectrum widget.
- Distance-axis strip chart aligned by per-lap distance.
- Global datums (shift+click) and global zoom (shift+drag) across every chart.

### Data ingest
- MoTeC CSV preamble preprocessor (metadata + units row + duplicate `Time` dedup).
- Link ECU CSV preamble preprocessor.
- Channel alias table covering MoTeC + Link variants.
- Smart channel resolver: exact alias → semantic match (unit-gated) → default custom channel.
- Two-pass loader with collision protection (first wins).
- MoTeC ADL int32-as-uint32 GPS micro-degree decoding.
- Bundled-sample registry + in-app sample switcher.
- User-loadable CSVs via picker, drag-drop, `+` button.
- Per-session removal; deterministic `user:djb2(path)` session ids.
- Per-session channel source overrides.
- Canonical channels for engine, chassis, GPS, IMU including the v2.5.2 additions.

### Workspaces
- Multiple workspaces with tab strip; built-in Overview, Engine Focus, Lap Analysis.
- Versioned localStorage persistence (v1 → v5 migrations).
- Full CRUD: create, rename, duplicate, delete, drag-reorder, recolor.
- `.helios` share-bundle export / import (non-destructive merge with id regeneration + label dedup).
- File-association handler: double-click `.helios` to import; single-instance redirect.
- Reset-all command.
- Tab-strip horizontal scroll with custom yellow scrollbar.

### Math channels
- Hand-rolled expression engine (tokenizer + recursive-descent parser + AST + evaluator).
- 18 scalar functions; constants `pi`, `e`; ternary; bracketed `[Names with spaces]`.
- 12+ vector ops: `derivative integral shift smooth lowpass highpass`, `stat_*`, `lap_*`, `integrate_over`, `time_valid`, `edge_delay`, `range_change`, `flip_flop`, `previous_sample`.
- Comments: `// line` and `/* block */`.
- Modal with token palette (click + drag), live diagnostics, per-session error surfacing.
- Global persistence; highest-rate-dep selection; cross-rate-group resample; tolerant id resolver.

### Laps
- First-class detection (gps_line / beacon / expression / manual).
- Per-session config persisted; live recompute via Lap Config dialog.
- LapSelectionEmitter (Main / Ref / Overlay) with click / ⌘-click / shift-click + M/R/O buttons.
- Lap palette quick actions (best as Main, 2nd-best as Ref, swap, clear Ref).

### Playback
- Play / pause; 0.25× / 0.5× / 1× / 2× / 4× / 8×.
- Continuous looping at session end; re-anchor on user scrub.
- Spacebar toggle (form-field-aware).

### Modules
- Vault module (Supabase-backed file storage with versions, locks, sync).
- ModulePicker rail; mount-once switching.
- Auth provider (Supabase) with email/password sign-in.

### UI / UX
- Brand: Orbitron wordmark, ASU gold #FFC627, "Sun Devil Motorsports · Telemetry" subtitle.
- Loading screen with stage label, percentage, animated shimmer, error banner, dynamic version.
- Panther app icon.
- Edit mode: gold selection ring, grid overlay, drag/resize, add/duplicate/delete, type-swap, snap-to-grid.
- Channels inspector with filter + source overrides.
- ChannelPicker dropdowns everywhere.
- Reusable ConfirmDialog component; no `window.alert/confirm/prompt` anywhere.
- FpsCounter footer pill.
- Updater pill with real version.
- Edit-mode header focus.
- CSV + KML export menu.
- Datum / zoom reset pills.
- Tauri title-bar overlay (no native chrome) with traffic-light position (14, 14).
- Command palette (⌘K) with fuzzy ranking across workspace / session / lap / system actions.
- Footer lap-compare strip (Main / Ref / Δ color-coded).

### Accessibility
- WCAG AA text contrast on body and dim text.
- `role="dialog"` + `aria-modal="true"` on every modal; `aria-label`(led-by); `aria-pressed` on toggles; `aria-current` on active rail tab.
- `prefers-reduced-motion: reduce` disables shimmer and pulse animations.

### Performance & infra
- rAF-coalesced cursor subscriptions (standard pattern).
- `useResizeObserver` on canvas + uPlot widgets.
- `drawRef.current` pattern for stale-closure-proof redraws.
- Functional-`setState` workspace mutators for closure freshness.
- Round-at-emit-site cursor times.
- macOS overscroll rubber-band suppression.
- Versioned localStorage envelopes for forward migration.
- Sequential CI matrix builds (`max-parallel: 1`) to avoid `latest.json` race in tauri-action.
- Updater capability isolated in its own capabilities file for defense in depth.

### Testing
- 25+ Rust CSV tests (MoTeC + Link fixtures, semantic disambiguation, collision protection).
- 127+ JS/TS tests across @helios/lib, @helios/widgets, apps/desktop.
- Visual tests intentionally dropped (none provided real coverage).

---

For the raw, per-issue write-ups, see [`v2_changes/`](../../v2_changes/).
