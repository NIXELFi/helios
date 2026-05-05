/**
 * Find the channel value at time `tUs`. Uses binary search to find the
 * largest sample index where time[idx] <= t, then returns that sample.
 * Returns null if the slice is empty or the channel is missing.
 */
export function sampleAt(
  slice: { time: BigInt64Array; data: Map<string, Float64Array> },
  channelId: string,
  tUs: number,
): number | null {
  const col = slice.data.get(channelId);
  if (!col || slice.time.length === 0) return null;
  const t = BigInt(tUs);
  let lo = 0, hi = slice.time.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (slice.time[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  const idx = Math.max(0, lo - 1);
  return col[idx] ?? null;
}
