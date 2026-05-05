# 10 — Multi-session overlay phase B (GPS, XY plot, histogram)

## Symptom / motivation

Phase A landed the session panel and strip-chart overlay. The remaining multi-trace widgets (GPS track, XY scatter, histogram) still drew only the primary session, which broke the lap-vs-lap workflow on those tiles.

## What this commit ships

All three widgets now draw every visible session in its session color. Single-session behavior is preserved as a fall-through.

### GPS track — [packages/widgets/src/gps-track/render.tsx](../packages/widgets/src/gps-track/render.tsx)

- **Unified bounding box.** All visible sessions are projected into the same `[0,1]²` space using a single union of lat/lon bounds, so two laps of the same track align geographically.
- **Null-island guard.** A session whose every lat **and** lon sample sits inside the 1°×1° box around `(0,0)` is treated as "no GPS fix" and silently skipped. Without this, a session that exports `0,0` for every row (e.g. when the receiver wasn't locked, as in the SDM26 accel export) would stretch the union bbox to ~334 M units and collapse a valid track to a single pixel.
- **One stroke per session** in its session color (primary stroked thicker for emphasis).
- **One cursor dot per session** at the current time, positioned on each session's own track.
- **Click-to-scrub searches across every visible session** — clicking near any track's nearest sample emits that session's time and the cursor jumps there.
- The single-session "color by channel" gradient mode (the green→amber speed coloring) is preserved when only one session is visible. With multiple sessions visible, gradient mode is disabled in favor of the session-color overlay.

### XY plot — [packages/widgets/src/xy-plot/render.tsx](../packages/widgets/src/xy-plot/render.tsx)

- Same union-bbox approach: explicit `xMin/xMax/yMin/yMax` config still wins when set; otherwise the plot fits the union of all visible sessions' xy ranges.
- Each session contributes its own scatter cloud in session color.
- Click-to-scrub searches across every visible session.
- The "trail" (time-coloured gradient) mode is preserved single-session only — overlay reads cleaner with flat session colors.

### Histogram — [packages/widgets/src/histogram/render.tsx](../packages/widgets/src/histogram/render.tsx)

- **Single session:** filled bars in session color (v1 look).
- **Multi-session:** stepped outlines, one per session. Light fill (~18% alpha) in session color is layered behind each outline so distributions overlap legibly. Primary session's outline is drawn with a thicker stroke.
- **Bin alignment.** Bin range comes from the union of all visible sessions' values (unless explicitly configured), and the y-axis is normalized against the maximum bin count across **all** sessions, so per-session shapes are comparable in height.

## Decisions kept consistent across widgets

These follow phase A's conventions, recorded here for reference:

- **Primary session is drawn first** (so it sits on top in stroke order, not visually obscured by overlays).
- **Cursor stays one global time.** Each widget computes its own per-session sample at that time. Sessions of different durations show no dot once the cursor is past their end.
- **Sessions that lack a tile's required channels are silently skipped** — a histogram tile for `engine.rpm` with one session that has it and one that doesn't will only draw the first session, no error.

## Performance notes

The overlay path adds an O(N_session × N_points) projection step per draw. At three sessions × ~30 k samples each, the GPS / xy redraws still complete in under a frame on dev hardware. If session counts get unbounded later, the projection should be cached per (session × widget config) pair instead of recomputing on every cursor scrub — currently the heavy paths only redraw on data/config/visible-set changes, not on cursor moves.

## Files changed

- [packages/widgets/src/gps-track/render.tsx](../packages/widgets/src/gps-track/render.tsx)
- [packages/widgets/src/xy-plot/render.tsx](../packages/widgets/src/xy-plot/render.tsx)
- [packages/widgets/src/histogram/render.tsx](../packages/widgets/src/histogram/render.tsx)
