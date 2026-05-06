# 24 — Auto-labeled turns and straights on the GPS view

## Want

MoTeC i2 labels every corner on its track-map view (T1, T2, …, S1, S2, …). Lets a driver coach point at a single label instead of saying "the long left after you exit the chicane." Wanted the same on the GPS widget.

## Add

`gps-track/turns.ts` — a pure detector that takes `(lat, lon, timeUs, options, latG?)` and returns a list of `TrackLabel { text, lat, lon, kind: "turn" | "straight" }` in lap order.

Algorithm:

1. **Pick a cornering signal.** If `latG` is provided and looks valid (≥ 5 finite samples > 0.05 G), use `|lat_g|` directly. Otherwise compute a GPS-based yaw rate.
2. For the GPS path, project lat/lon to a local meters frame at the trace centroid (with `cos(meanLat)` so a degree of longitude is the right length), then compute a **lookahead bearing** — the direction from sample i to sample i + lookahead (default 10 samples ≈ 100 ms). Lookahead instead of adjacent-sample so noisy GPS doesn't poison the bearing array with `atan2(near-0, near-0)` results. Movements under 10 cm across the lookahead window inherit the previous bearing for continuity.
3. **Yaw rate** = Δbearing / Δt, with the standard ±π unwrap so a U-turn doesn't generate a single spike followed by a noise burst.
4. **Smooth** with a moving-average window.
5. **Threshold + run-length** filter: contiguous samples above threshold for ≥ `minTurnDurationMs` = a turn.
6. **Label position** = centroid lat/lon of the run. Straights, when enabled, are gaps between consecutive turns ≥ 5 samples long.

Three sensitivity presets exposed in the GPS config panel — `low` (only obvious corners), `medium` (default), `high` (catches subtle bends). Each preset is a complete `TurnDetectOptions` tuple covering both signal-type thresholds, the smoothing window, and the run-duration floor.

## Why prefer lat_g over GPS

The first cut detected nothing on the user's real session because adjacent-sample bearing math is nearly meaningless when consecutive GPS samples nearly coincide (noise / upsampled-from-low-Hz / coasting). `lat_g` is a chassis-frame measurement of cornering force — orders of magnitude more reliable than GPS-derived yaw rate and applicable even when the GPS receiver is glitchy. The MoTeC ADL exports already ship `Lat_Accel` which the channel registry aliases to `imu.lat_g`, so most real sessions get the better signal automatically.

`requiredChannels` in the GPS widget descriptor includes `imu.lat_g` so the slice carries it; sessions without an IMU silently fall back to GPS-only detection.

## Render

Labels cached on a ref keyed by `${primary.session.id}:${primary.n}:${labelsMode}:${sensitivity}`, so cursor frames don't recompute. Drawn after the polylines but before the status text, projected through the same `projectPoint()` as everything else (MapLibre or normalized canvas — same labels follow the active projection).

Turn pills are gold-bordered, slightly larger; straight pills are dim grey, smaller. Status pill at the top-left now also includes `· N turns` for a quick count.

## Files changed

- [packages/widgets/src/gps-track/turns.ts](../packages/widgets/src/gps-track/turns.ts) (new)
- [packages/widgets/src/gps-track/render.tsx](../packages/widgets/src/gps-track/render.tsx)
- [packages/widgets/src/gps-track/config-editor.tsx](../packages/widgets/src/gps-track/config-editor.tsx)
- [packages/widgets/src/gps-track/index.tsx](../packages/widgets/src/gps-track/index.tsx) — `imu.lat_g` added to required channels
