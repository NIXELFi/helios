# 04 — Scrubbing the strip chart didn't update other widgets

## Symptom

After implementing click/drag scrubbing on every plot, the GPS track scrub correctly updated all other widgets (gauges, tire grid, GPS dot). But scrubbing on the strip chart only moved the strip chart's own yellow line — every other widget stayed frozen.

## Root cause

The strip-chart's pointer handler emitted a **fractional** microsecond value:

```ts
const tS = u.posToVal(localX, "x");           // value in seconds, e.g. 12.345678
cursorEmitter.emit(tS * 1_000_000);           // 12_345_678.000001 — fractional
```

Subscribers that fed the value into a binary search over `slice.time` (a `BigInt64Array`) wrap it via `BigInt(t)`:

- [packages/widgets/src/lib/sample-at.ts:13](../packages/widgets/src/lib/sample-at.ts#L13) — used by every gauge widget
- [packages/widgets/src/gps-track/render.tsx](../packages/widgets/src/gps-track/render.tsx) — used to position the GPS dot

`BigInt()` throws `RangeError: ... is not an integer` when given a fractional number. The throw aborted each subscriber's draw mid-call, so visually nothing updated.

The GPS scrub avoided this because it emits `Number(slice.time[idx])` from a `BigInt64Array` — always an exact integer.

## Fix

Round at the emit source so cursor times are always integer microseconds:

```ts
cursorEmitter.emit(Math.round(tS * 1_000_000));
```

Sub-microsecond precision is meaningless for race telemetry (samples are 100 µs apart at the densest), so rounding has no perceptible effect on alignment.

We deliberately did **not** soften the `BigInt()` calls in the receivers — keeping them strict means future bugs that emit fractional times will surface immediately rather than silently drop frames.

## Files changed

- [packages/widgets/src/strip-chart/render.tsx](../packages/widgets/src/strip-chart/render.tsx)
