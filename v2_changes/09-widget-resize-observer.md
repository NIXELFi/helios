# 09 — Widgets didn't resize when their tile changed size

## Symptom

Two related layout issues showed up after the left session panel landed:

1. Tiles stretched (not relayed out) when the window was resized.
2. Tiles didn't fill back up when the side panel collapsed/expanded.

Visually: the canvas / uPlot rendered area kept its initial size, even though the surrounding `<div>` resized. So plots looked clipped, blurry, or with extra dead space.

## Root cause

Every canvas widget read its container size **once** at mount and never re-read it.

- **uPlot widgets** (strip chart): initialized with `width: containerRef.current.clientWidth` and `height: ...clientHeight` taken at mount. uPlot has a `setSize()` API but nothing was calling it.
- **Plain canvas widgets** (gps-track, xy-plot, histogram, bar-gauge, round-gauge, engine-bar): each calls `setupCanvas(canvas)` which reads `getBoundingClientRect()` — but only inside their `draw()` function, which is triggered on data/cursor change, **not on container resize**.

When the parent `<div>` (the tile) shrank or grew, neither path was notified. CSS scaled the existing canvas buffer, producing the stretched look.

## Fix

A small reusable `useResizeObserver` hook in [packages/widgets/src/lib/use-resize-observer.ts](../packages/widgets/src/lib/use-resize-observer.ts):

```ts
export function useResizeObserver(
  ref: RefObject<HTMLElement | null>,
  onResize: (entry: { width: number; height: number }) => void,
): void
```

It wires a `ResizeObserver` to the referenced element and calls `onResize` whenever the element changes size. Falls back to a single immediate call when `ResizeObserver` is undefined (jsdom test environments).

### Strip chart — [packages/widgets/src/strip-chart/render.tsx](../packages/widgets/src/strip-chart/render.tsx)

```ts
const onResize = useCallback(({ width, height }) => {
  const u = plotRef.current;
  if (!u) return;
  if (width > 0 && height > 0) u.setSize({ width, height });
}, []);
useResizeObserver(containerRef, onResize);
```

Calls uPlot's `setSize` imperatively — much cheaper than recreating the chart on every resize.

### Canvas widgets

Each calls the existing `draw()` on resize. `draw()` already re-reads `getBoundingClientRect()` via `setupCanvas()` and `canvasLogicalSize()`, so the buffer is rebuilt at the new size:

```ts
const onResize = useCallback(() => { draw(); }, []);
useResizeObserver(canvasRef, onResize);
```

Wired into: [gps-track](../packages/widgets/src/gps-track/render.tsx), [xy-plot](../packages/widgets/src/xy-plot/render.tsx), [histogram](../packages/widgets/src/histogram/render.tsx), [bar-gauge](../packages/widgets/src/bar-gauge/render.tsx), [round-gauge](../packages/widgets/src/round-gauge/render.tsx), [engine-bar](../packages/widgets/src/engine-bar/render.tsx).

## Files changed

- [packages/widgets/src/lib/use-resize-observer.ts](../packages/widgets/src/lib/use-resize-observer.ts) — new
- [packages/widgets/src/strip-chart/render.tsx](../packages/widgets/src/strip-chart/render.tsx)
- [packages/widgets/src/gps-track/render.tsx](../packages/widgets/src/gps-track/render.tsx)
- [packages/widgets/src/xy-plot/render.tsx](../packages/widgets/src/xy-plot/render.tsx)
- [packages/widgets/src/histogram/render.tsx](../packages/widgets/src/histogram/render.tsx)
- [packages/widgets/src/bar-gauge/render.tsx](../packages/widgets/src/bar-gauge/render.tsx)
- [packages/widgets/src/round-gauge/render.tsx](../packages/widgets/src/round-gauge/render.tsx)
- [packages/widgets/src/engine-bar/render.tsx](../packages/widgets/src/engine-bar/render.tsx)
