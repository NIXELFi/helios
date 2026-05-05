# 03 — UI lags and glitches when scrubbing

## Symptom

While scrubbing, the dashboard updated noticeably slowly and several widgets visibly glitched. Other widgets (canvas-based gauges) updated fine.

## Root cause

`CursorEmitter.emit()` fires synchronously on every mouse-move event (potentially 100+ Hz). Most widgets handle this efficiently — they redraw their canvas imperatively with no React involvement. **`tire-grid` was the exception**: it bridged the emitter to React state with `setTick(x => x + 1)` per emit, forcing a full React reconciliation of all four corners (12 `sampleAt` binary searches per render) at mouse-event rate.

```tsx
// packages/widgets/src/tire-grid/render.tsx (before)
useEffect(() => cursorEmitter.subscribe(() => setTick((x) => x + 1)), [cursorEmitter]);
```

React can't keep up with 100+ Hz state writes, so renders queued and tore visibly during drags.

## Fix

Coalesce subscription callbacks through `requestAnimationFrame`. Many emits within one frame collapse to a single `setTick` call, so the tire grid re-renders at a steady ~60 Hz instead of mouse-event rate:

```tsx
useEffect(() => {
  let raf = 0;
  const off = cursorEmitter.subscribe(() => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; setTick((x) => x + 1); });
  });
  return () => { off(); if (raf) cancelAnimationFrame(raf); };
}, [cursorEmitter]);
```

This is the standard fix for any future widget that needs to bridge the emitter to React state.

## Files changed

- [packages/widgets/src/tire-grid/render.tsx](../packages/widgets/src/tire-grid/render.tsx)
