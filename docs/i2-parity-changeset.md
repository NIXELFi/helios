# Helios → MoTeC i2 parity changeset

Drafted 2026-05-07 against `main` at v2.4.1; shipped as v2.5.0.

This document has three sections:

1. **What this pass shipped** — the work already done in the working tree
2. **Recommended next changes, ranked by complexity** — easiest first
3. **Recommended next changes, ranked by improvement** — highest impact first

The "next changes" lists are the same set, sorted differently. Each item has
a complexity tag (S / M / L / XL) and an improvement tag (low / med / high)
so the rankings are interpretable without re-reading both lists.

Tag legend:

| Tag | Complexity | Improvement |
| --- | --- | --- |
| S | < 1 hour | minor — affects rare workflows |
| M | 1–4 hours | clearly noticeable — affects weekly workflows |
| L | 1–2 days | substantial — changes the daily workflow |
| XL | 1–2 weeks | foundational — opens new categories of work |

---

## 1. What this pass shipped

| Area | Change | Complexity | Improvement |
| --- | --- | --- | --- |
| **Laps** | `@helios/lib/laps`: types + detection (GPS line, beacon, math expression, manual). Half-open lap segments with trusted / out-lap / in-lap, distance integration from a configurable speed channel, cache-key for invalidation | L | high |
| | Per-session `LapDetectionConfig` + `LapSet`, persisted in localStorage. `loadAllSessions` picks a sensible default (beacon → GPS line → none) | M | high |
| | `LapConfigDialog` with live preview — pick mode, edit params, see detected laps and best time before saving | M | high |
| | `SessionPanel` rewritten: each session row expands to show lap status and a "Configure lap detection…" button | S | med |
| | `LapSelectionEmitter` — global Main / Ref / Overlay state. Pruned automatically when sessions toggle invisible | M | high |
| | `lap_max / lap_min / lap_mean / lap_first / lap_last` math ops actually work (formerly threw "not implemented") | S | med |
| | Per-sample `perSampleLapDistance` (resets to 0 at lap boundaries) used by the distance-axis strip chart | M | high |
| **Distance axis** | Strip chart `xMode: "time" \| "distance"`. Distance mode renders only the selected laps (Main + Ref + Overlays), aligned by per-lap distance | L | high |
| | Color encodes lap role in distance mode (Main = brand yellow, Ref = cyan, Overlay = green); dashes vary by role | S | med |
| **Reports** | Channel report widget — per-lap × per-channel × stat (avg, min, max, abs-max, start, end, change, σ) with multi-session blocks | M | high |
| | Time report widget — lap times with Δ-best, Δ-avg, distance, rolling-window best, mean, σ, consistency % | M | high |
| | Zone stats widget — between two datums or datum→cursor: duration, Δ, μ, σ, min, max, slope/s per channel | M | high |
| **FFT** | `@helios/lib/fft`: in-place radix-2 Cooley–Tukey FFT, Hanning window, real-input magnitude-spectrum convenience wrapper | M | med |
| | FFT widget: configurable channel, optional zoom-range scoping, dB / linear y, log / linear frequency, fmax cap | M | med |
| **Math** | `stat_min / stat_max / stat_mean / stat_std_dev / stat_start / stat_end / integrate_over` — windowed statistics over a condition | M | high |
| | `time_valid(cond, hold_s)` — debounce: true once cond has been on for `hold_s` continuously | S | med |
| | `edge_delay(cond, hold_s)` — emits 1 at each rising edge of `cond` that has held for `hold_s` | S | med |
| | `range_change(cond)` — counter that increments on each rising edge | S | med |
| | `flip_flop(set, reset)` — SR latch | S | med |
| | `previous_sample(x, default)` — lag-1 with explicit initial value | S | low |
| | `highpass(x, fc_hz)` — first-order high-pass IIR (paired with the existing `lowpass`) | S | med |
| | `// line` and `/* block */` comments in math expressions — long-standing i2 wishlist item | S | med |
| **Export** | CSV export of the primary session (full or current zoom range), MoTeC-compatible header layout | M | med |
| | KML export of the GPS path with one Placemark per lap | S | low |
| | Header **Export ▾** menu, code-split so the dialog plugin loads lazily | S | low |
| **UI** | New "Lap Analysis" built-in workspace pre-populated with the new widgets so they're discoverable on first launch | S | med |
| | Header lap-selection pill — `M:Driver tryout L7 · R:… · +0` with one-click clear | S | low |
| | Lap-aware `lap_panel` widget: selectable rows (click / ⌘-click / shift-click), per-session blocks, untrusted dimming, ★ best lap | M | high |
| **Verification** | All packages typecheck. 127/127 tests pass. `cargo check` green. Vite production build green | — | — |

Implementation notes:

- The `lap_panel`'s pre-existing static-laps config is preserved as a fallback
  so saved workspaces with the old shape keep rendering exactly as they did
  in v2.4.1. New tiles and the rebuilt overview default emit `laps: []` and
  read live data from the LapSet.
- The strip chart's existing time-mode interactions (scrub, datum, drag-zoom,
  double-click reset) stay exactly as they were. Distance mode is read-only
  in this pass — interactive cursor in distance space requires a per-lap
  time↔distance mapping that's worth building once we know how it gets used.

---

## 2. Recommended next changes — by complexity (easiest first)

| # | Change | Complexity | Improvement |
| - | --- | --- | --- |
| 1 | Add the `gps.speed` unit hint as a per-channel meta override (currently the strip chart's distance mode assumes `gps.speed` is m/s, which is correct for MoTeC ADL but not always for other sources) | S | low |
| 2 | `D` keyboard shortcut to toggle the focused strip chart's xMode (mirrors i2's `F9`) | S | med |
| 3 | "Lock layout" toggle in the header (suppresses Edit Mode shortcuts; small win, but a common i2 user request) | S | low |
| 4 | Math channel autocomplete in the modal editor (we already export `MATH_BUILTINS` and `VECTOR_OPS` — just wire to the textarea) | S | med |
| 5 | "Reset all laps to best of primary" button on the lap-selection pill | S | low |
| 6 | Per-tile PNG export (right-click the tile header in edit mode → "Save as image"; serializes the canvas) | S | med |
| 7 | Strip chart: support 3rd and 4th distinct y-axes (currently caps at 2 and silently shares the first axis for a 3rd range) | S | med |
| 8 | Lap row right-click menu: trust/untrust, mark in/out lap, edit note, copy time | S | med |
| 9 | Untrusted-lap auto-detection: any lap with avg speed ≤ 30% of session avg flagged as out/in (heuristic) | S | low |
| 10 | "Save Math Channels…" / "Load Math Channels…" import/export to a `.helios-math.json` file | S | med |
| 11 | Channel meta editor UI (alarms, decimals, units) — currently YAML only, hard for non-technical users | M | med |
| 12 | Extended `docs/channels.yaml`: 50–150 canonical FSAE channels (suspension travels, dampers, AFR, EGT, brake pressure F/R, fuel P/T, IMU 3-axis, GPS heading/altitude/quality, drivetrain temps, gearbox shift) | M | med |
| 13 | Variance trace as a strip-chart overlay series — `Δt vs distance` between Main and Ref. The data plumbing exists; this is rendering a derived series | M | high |
| 14 | Suspension histogram widget: damper-velocity bins, low/high-speed bump/rebound categories, per-corner overlay | M | high |
| 15 | Mixture map widget: AFR vs RPM/TPS (or MAP), gear-change filter, per-lambda-sensor delay | M | med |
| 16 | Track sector definition: mark distance points on a lap to split into sectors. Stored per-track, applied across sessions | M | high |
| 17 | Sector-aware Time Report: eclectic (sum of best sector times across the session) and per-sector mini-table | M | high |
| 18 | PDF report export: take the current workspace and render to a single page or multi-page PDF (using the canvas-to-PDF approach) | M | med |
| 19 | "Same-track" alignment heuristic across sessions (compare GPS bboxes; cluster) so multi-session lap overlays in distance mode automatically match the right reference frame | M | med |
| 20 | Interactive cursor in strip-chart distance mode: click in distance space → emits the corresponding time on the Main lap, scrubs everything else through the existing cursor emitter | M | high |
| 21 | Setup-sheet integration (per-vehicle `.xlsx` with corner weights / springs / tires); auto-applies values as math constants | M | low |
| 22 | Track-map auto-generation from speed + lat_g (when GPS is missing or noisy), MoTeC's "Curvature parameter" tunable | L | med |
| 23 | Track-map overlay editor: drag start-finish line on the GPS map widget (live updates lap config) | L | high |
| 24 | Multi-monitor / undocked workspaces (Tauri windowing capability change + per-window state) | L | med |
| 25 | LD/LDX binary parser (Rust crate, integrates with `helios-csv` adapter). Round-trip MoTeC files without re-exporting CSV | L | high |
| 26 | Math channel groups / folders + libraries you can save and load like the existing workspace bundles | L | med |
| 27 | Race-control component (multi-vehicle telemetry positions on the track map). Telemetry is paused — design the rendering layer now so it's drop-in when telemetry resumes | L | low |
| 28 | Auto-detect untrusted laps using a learned classifier (sustained speed below stint average, abrupt distance jumps, GPS outage). Replaces the hand-tuned heuristic | XL | low |
| 29 | DBC enumeration import — read VAL_TABLE from `.dbc` files and expose as enum tables on numeric channels | XL | med |
| 30 | Cloud workspace sync (per-user account, sync targets, conflict resolution) | XL | low |
| 31 | Lap simulation / corner-by-corner lap-time prediction (vehicle model + track + driver inputs). Massive scope but the killer feature for setup work | XL | high |

---

## 3. Recommended next changes — by improvement (highest impact first)

| # | Change | Complexity | Improvement |
| - | --- | --- | --- |
| 1 | Variance trace overlay (Δt vs distance, Main vs Ref) | M | high |
| 2 | Suspension histogram widget | M | high |
| 3 | Track sector definition + sector-aware Time Report (one feature, two widgets) | M | high |
| 4 | Interactive cursor in distance mode | M | high |
| 5 | Track-map overlay editor (drag start-finish on the GPS widget) | L | high |
| 6 | LD/LDX binary parser (round-trip native MoTeC files) | L | high |
| 7 | Lap simulation / lap-time prediction | XL | high |
| 8 | `D` key shortcut to toggle xMode on strip charts | S | med |
| 9 | Strip chart: 3rd and 4th y-axes | S | med |
| 10 | Lap row right-click menu (trust/untrust, mark in/out, note, copy time) | S | med |
| 11 | Math channel autocomplete in the modal editor | S | med |
| 12 | Per-tile PNG export | S | med |
| 13 | Math channel libraries (save / load `.helios-math.json`) | S | med |
| 14 | Channel meta editor UI | M | med |
| 15 | Extended `docs/channels.yaml` (50–150 FSAE channels) | M | med |
| 16 | Mixture map widget | M | med |
| 17 | PDF report export | M | med |
| 18 | "Same-track" cross-session alignment | M | med |
| 19 | Track-map auto-generation from speed + lat_g | L | med |
| 20 | Multi-monitor / undocked workspaces | L | med |
| 21 | Math channel groups / libraries | L | med |
| 22 | DBC enumeration import | XL | med |
| 23 | Per-channel speed-unit hint override | S | low |
| 24 | "Lock layout" header toggle | S | low |
| 25 | "Reset all laps to best" button on the selection pill | S | low |
| 26 | Untrusted-lap auto-detection heuristic | S | low |
| 27 | Setup-sheet `.xlsx` integration | M | low |
| 28 | Race-control component (telemetry-blocked) | L | low |
| 29 | Learned untrusted-lap classifier | XL | low |
| 30 | Cloud workspace sync | XL | low |
| 31 | KML auto-color by speed channel (currently emits per-lap color only) | S | low |

---

## Notes

- "Improvement" is rated against the goal of **MoTeC i2 parity for an FSAE
  team's daily workflow**, not against generic data-analysis goodness.
  A widget that's nice but rarely used in a typical race weekend gets
  rated low even if it's individually impressive.
- The complexity estimates assume the i2-parity-pass codebase as the
  starting point — i.e. with laps as first-class entities and the lap
  selection emitter already in place. Some of these items would have been
  L or XL before this pass and are now S or M.
- A few items intentionally repeat across both rankings to make each
  ranking complete and standalone.

## Open questions for review

1. Should we tear out the static legacy `lap_panel.config.laps` field and
   migrate saved workspaces to the empty array, or leave the fallback in
   indefinitely? Leaning indefinite — the fallback is ~50 lines and lets
   `.helios` bundles from v2.4.1 still load.
2. Distance mode currently picks the speed channel from a hardcoded list
   (`gps.speed`, `vehicle.speed`). Should it surface the choice in the
   strip-chart config, fall back to the per-session lap config's
   `speedChannelId`, or both? Probably both, with the lap config's choice
   winning.
3. The lap selection emitter persists for the session but resets on app
   restart — same model as cursor and view-state. Should we persist it?
   I'd say no (the user's selection is contextual to the comparison they
   were doing) but it's worth flagging.
4. Default Ref-lap selection is "second-best lap of primary." MoTeC users
   commonly use "previous lap" as the comparison. Configurable preference?
