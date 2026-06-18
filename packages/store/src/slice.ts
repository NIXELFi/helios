import { RateGroup } from "./rate-group";
import type { ChannelSlice, TimeRange } from "./types";

/**
 * Half-open slice: includes samples where startUs <= t < endUs.
 * Uses binary search on the monotonic time index. O(log N + K).
 */
export function sliceRateGroup(rg: RateGroup, channels: string[], range: TimeRange): ChannelSlice {
  for (const id of channels) {
    if (!rg.has(id)) throw new Error(`unknown channel ${id}`);
  }
  const { time } = rg;
  const lo = lowerBound(time, BigInt(range.startUs));
  const hi = lowerBound(time, BigInt(range.endUs));

  const sliceTime = time.slice(lo, hi);
  const data = new Map<string, Float64Array>();
  for (const id of channels) {
    data.set(id, rg.data(id).slice(lo, hi));
  }
  return { time: sliceTime, data, range };
}

function lowerBound(arr: BigInt64Array, target: bigint): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Resample a (srcTime, srcVals) column onto `base` using zero-order hold: each
 * output sample is the source value at the largest src index with
 * srcTime[idx] <= base[i] — i.e. the last known reading at or before that
 * timestamp. Matches sampleAt's lookup so a multi-rate slice reads back the
 * same value a single-channel sampleAt would. Base timestamps before the
 * column's first sample get NaN (no reading exists yet). Both `srcTime` and
 * `base` must be sorted ascending. O((N + M) · log N) via galloping.
 */
export function resampleHold(srcTime: BigInt64Array, srcVals: Float64Array, base: BigInt64Array): Float64Array {
  const out = new Float64Array(base.length);
  if (srcTime.length === 0) { out.fill(NaN); return out; }
  let idx = -1; // largest src index with srcTime[idx] <= current base ts
  for (let i = 0; i < base.length; i++) {
    const t = base[i]!;
    while (idx + 1 < srcTime.length && srcTime[idx + 1]! <= t) idx++;
    out[i] = idx < 0 ? NaN : srcVals[idx]!;
  }
  return out;
}
