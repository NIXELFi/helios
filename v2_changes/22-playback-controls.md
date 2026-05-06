# 22 — Playback controls (▶ / pause / speed)

## Want

Replay a session in real time. Scrubbing manually only gets you so far when you're trying to debrief a corner sequence — you want to press play and watch every gauge, the GPS dot, and the steering wheel animate together.

## Add

Play/pause button + speed selector (0.25× / 0.5× / 1× / 2× / 4× / 8×) in the right side of the header, next to the existing cursor clock.

While playing, a `requestAnimationFrame` loop advances the cursor by `wallElapsedMs × 1000 × speed` per frame, then emits via the existing cursor emitter. Every widget already subscribes to the emitter so they all animate.

Subtleties:

- Pressing play when the cursor sits at the end of the session restarts from the beginning (loops once) instead of dead-stopping.
- Cursor wraps to the start when it passes `endUs`, so playback is continuous instead of dead-stopping at the end of every lap.
- A user scrub during playback (click on a strip chart, click on the GPS map, etc.) re-anchors the loop to the new cursor position by comparing `emitter.get()` against the last value the rAF loop wrote.
- Spacebar toggles play/pause from anywhere in the app, except inside form fields (so config-panel inputs stay typeable).

## Catch — fractional microseconds

Same trap as [04](04-strip-chart-fractional-microseconds.md): subscribers that feed cursor time into `BigInt()` (`sample-at`, `gps-track` index lookup) throw `RangeError` on fractional values and silently drop the frame. The rAF loop emitted `cursorStartUs + wallElapsedMs * 1000 * speed` which is fractional whenever wall-elapsed isn't a clean ms or speed isn't 1×. Strip chart's yellow line moved fine (uPlot is float-native), but every gauge / GPS / steering wheel froze on the first attempt.

`Math.round` at the emit site fixed it. Sub-microsecond precision is meaningless for telemetry data sampled at ≥100 µs intervals.

## Files changed

- [apps/desktop/src/App.tsx](../apps/desktop/src/App.tsx)
