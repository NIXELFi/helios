# 23 — Per-channel Y axis on the strip chart

## Symptom

Combining `engine.rpm` (0–14000) and `engine.tps` (0–100) on the same strip chart left the throttle line pinned to the bottom edge — invisible — because both channels shared one Y scale.

## Fix

Per-channel ranges, MoTeC i2-style. `StripChartChannel` gained optional `yMin` / `yMax`; the chart-level `yMin` / `yMax` is now a fallback for channels that don't override. Each unique resolved range gets its own uPlot scale + axis.

Refinements:

- **Same-range grouping.** Four shock channels at ±25 mm get one axis on the left, not four stacked axes overflowing the tile. Channels are grouped by their resolved (min, max) tuple — one scale per group.
- **Cap at 2 axes total** (one left, one right). Beyond that, additional ranges fall back to the first scale rather than growing a third axis stack outward into the next tile.
- **Axis tick color = trace color**, so the user can read which axis owns which range.
- **Grid lines only on the left axis** so the background stays clean when ranges differ.

## Knock-on fixes (same widget pass)

- **Bottom legend was clipped** by the next tile down. uPlot renders its default legend as an HTML table outside the canvas. Disabled (`legend.show = false`) and replaced with a compact in-canvas overlay in the top-right: one tight horizontal row of tiny pills with color chip + channel id (no range numbers — the axis tick labels show those). `max-w-[80%]` so very wide channel names wrap rather than running off the right edge.
- **Date labels read "12/31/69 5:00pm"**. uPlot's default x scale assumes Unix timestamps. `scales.x.time = false` flips it to a numeric scale; `axes[0].values` provides a `formatElapsed()` that prints `0.5`, `5`, `1:30` depending on magnitude.
- **Left axis clipped 5-digit labels** like `15,000`. Axis `size: 40` → `60`.
- **Color swatch in the config editor was rendering near-black** at 28×24 because WebKit's native `<input type="color">` shows its OS chrome at that size with the actual color hidden. Lay a colored div underneath a transparent color input — the div shows the bound color, the input still opens the OS picker on click.
- **Remove-channel × button got pushed past the right edge** of the ConfigPanel when channel names were long. `flex-1` on `ChannelPicker` had implicit min-content width. Wrap the picker in `min-w-0 flex-1` and add `shrink-0` to the swatch and × so the picker yields space first.

## Files changed

- [packages/widgets/src/strip-chart/render.tsx](../packages/widgets/src/strip-chart/render.tsx)
- [packages/widgets/src/strip-chart/config-editor.tsx](../packages/widgets/src/strip-chart/config-editor.tsx)
