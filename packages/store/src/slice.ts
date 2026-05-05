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
