# 01 — Cursor follows mouse everywhere instead of being click-driven

## Symptom

Moving the mouse anywhere over the dashboard advanced the playback cursor. There was no way to "park" the cursor at a specific time. Felt like the cursor was auto-scrolling.

## Root cause

The viewport's `<main>` element had a global `onMouseMove` handler that converted every mouse position to a time and called `cursorEmitter.emit(t)`. There was no concept of click-vs-hover — every pixel of mouse motion changed the time.

```tsx
// apps/desktop/src/App.tsx (before)
<main
  className="flex-1 relative cursor-crosshair"
  onMouseMove={(e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    const t = ext.startUs + frac * (ext.endUs - ext.startUs);
    emitter.emit(t);
  }}
>
```

## Fix

1. Removed the global `onMouseMove` handler and the `cursor-crosshair` class from `<main>`.
2. Moved the scrub interaction onto each scrubbable plot widget. Each widget owns pointer-down / pointer-move / pointer-up handlers and only emits while the user is actively dragging on that plot.
3. Strip charts use uPlot's `posToVal()` for pixel-accurate time conversion (see [02](02-cursor-misalignment.md)). GPS and XY plots use a nearest-sample search.

## Files changed

- [apps/desktop/src/App.tsx](../apps/desktop/src/App.tsx)
- [packages/widgets/src/strip-chart/render.tsx](../packages/widgets/src/strip-chart/render.tsx)
- [packages/widgets/src/gps-track/render.tsx](../packages/widgets/src/gps-track/render.tsx)
- [packages/widgets/src/xy-plot/render.tsx](../packages/widgets/src/xy-plot/render.tsx)
