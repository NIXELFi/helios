/* Pure zone aggregation for the Zone Stats widget. Split out of render.tsx so
 * the window-bounds search is unit-testable without mounting the widget.
 */

export interface ZoneAgg {
  n: number;
  min: number; max: number;
  start: number; end: number;
  sum: number; sumSq: number;
  durationS: number;
}

/** Half-open sample range `[lo, hi)` covering the timestamps within
 *  `[startUs, endUs]` inclusive. `hi <= lo` means the window holds no samples.
 *
 *  The time axis is sorted ascending (it's the rate group's time index), so
 *  both edges are binary searches. The previous linear scan started at index 0
 *  for every channel on every aggregate call — in 1-datum live mode that runs
 *  on every cursor tick, so a full session was rescanned per channel per tick.
 *
 *  Comparisons go through Number() rather than converting the bounds to BigInt:
 *  the bounds come from cursor/datum positions and can be fractional µs, and
 *  BigInt() would throw on those. Microsecond timestamps stay well inside
 *  Number.MAX_SAFE_INTEGER (~285 years), so the comparison is exact. */
export function zoneBounds(
  time: BigInt64Array, startUs: number, endUs: number, n = time.length,
): { lo: number; hi: number } {
  const len = Math.max(0, Math.min(n, time.length));
  // lo = first index with t >= startUs
  let lo = 0, loHi = len;
  while (lo < loHi) {
    const mid = (lo + loHi) >>> 1;
    if (Number(time[mid]!) < startUs) lo = mid + 1; else loHi = mid;
  }
  // hi = first index with t > endUs (exclusive end)
  let hiLo = lo, hi = len;
  while (hiLo < hi) {
    const mid = (hiLo + hi) >>> 1;
    if (Number(time[mid]!) <= endUs) hiLo = mid + 1; else hi = mid;
  }
  return { lo, hi: Math.max(lo, hi) };
}

/** Aggregate `values` over the samples whose timestamps fall in
 *  `[startUs, endUs]`. Non-finite samples are skipped but do not end the
 *  window. `durationS` is the wall-clock span of the zone itself, not of the
 *  samples found in it, so an empty window still reports its requested span. */
export function aggregateZone(
  values: Float64Array, time: BigInt64Array,
  startUs: number, endUs: number,
): ZoneAgg {
  const out: ZoneAgg = {
    n: 0, min: Infinity, max: -Infinity, start: NaN, end: NaN,
    sum: 0, sumSq: 0, durationS: Math.max(0, (endUs - startUs) / 1_000_000),
  };
  const n = Math.min(values.length, time.length);
  const { lo, hi } = zoneBounds(time, startUs, endUs, n);
  for (let i = lo; i < hi; i++) {
    const v = values[i]!;
    if (!Number.isFinite(v)) continue;
    if (out.n === 0) out.start = v;
    out.end = v;
    if (v < out.min) out.min = v;
    if (v > out.max) out.max = v;
    out.sum += v;
    out.sumSq += v * v;
    out.n++;
  }
  return out;
}

/** Placeholder aggregate for a channel with no data loaded — same shape, and
 *  the zone's own duration so the header and slope column stay consistent. */
export function emptyZoneAgg(startUs: number, endUs: number): ZoneAgg {
  return {
    n: 0, min: NaN, max: NaN, start: NaN, end: NaN,
    sum: 0, sumSq: 0, durationS: Math.max(0, (endUs - startUs) / 1_000_000),
  };
}
