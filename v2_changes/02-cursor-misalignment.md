# 02 — Yellow cursor line doesn't align with the mouse pointer

## Symptom

The yellow vertical cursor line on the strip chart drifted away from the mouse — typically by a few dozen pixels horizontally. The further from the chart's left edge, the bigger the visible gap.

## Root cause

Two coordinate spaces were being mixed:

- **Time was computed** in `App.tsx` using `<main>`'s full client width:
  `frac = (clientX - mainRect.left) / mainRect.width`.
- **The cursor line was positioned** with uPlot's `valToPos(t, "x")`, which returns a position relative to uPlot's `over` element — i.e. the chart's plot area, *excluding* the y-axis labels and any internal padding.

Because the y-axis (~50 px on the left) is part of `<main>`'s width but not part of `over`'s width, the two fractions diverged. At the right edge of the chart the time corresponded to pixel ~`mainWidth`, but the cursor was painted at pixel ~`overWidth` (which is smaller), shifting the line left of the pointer.

## Fix

Move the click/drag handler into the strip-chart widget itself, attached to the same `over` element used to position the cursor line. Use uPlot's `posToVal(localX, "x")` to convert mouse position to time:

```ts
const rect = over.getBoundingClientRect();
const localX = e.clientX - rect.left;
const tS = u.posToVal(localX, "x");
cursorEmitter.emit(Math.round(tS * 1_000_000));
```

Because both the input (`localX` in `over` coords) and the output rendering (`valToPos`) use the same coordinate space, the line lands exactly under the pointer at any zoom level.

## Files changed

- [packages/widgets/src/strip-chart/render.tsx](../packages/widgets/src/strip-chart/render.tsx)
