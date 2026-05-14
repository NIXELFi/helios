/* Pure compute for the lap-delta-trace widget. No React, no uPlot — just
 * arithmetic over typed arrays so the algorithm is testable in isolation.
 *
 * "Δt" is "main lap minus ref lap" as a function of distance along the lap:
 * for each distance d, take how long Main has spent reaching d, subtract how
 * long Ref spent reaching d. Positive Δ means Main is slower at this point in
 * the lap; negative means Main is ahead. The signed area is the eventual lap
 * time delta. */

export interface DeltaInput {
  /** Full session time array, microseconds since session start. */
  mainTimeUs: BigInt64Array;
  /** Per-sample distance along Main lap. NaN outside the lap; 0 at lap start;
   *  accumulating in meters. Length matches mainTimeUs. Typically produced by
   *  `perSampleLapDistance`. */
  mainDist: Float64Array;
  mainLapStartUs: number;
  mainLapEndUs: number;
  refTimeUs: BigInt64Array;
  refDist: Float64Array;
  refLapStartUs: number;
  refLapEndUs: number;
}

export interface DeltaResult {
  /** Distance axis, monotonic non-decreasing. */
  distance: Float64Array;
  /** Δt in seconds (Main minus Ref) sampled at each `distance[i]`. NaN where
   *  Ref's lap never reached this distance (Main went further than Ref) or
   *  Ref's data is missing. */
  deltaS: Float64Array;
  /** Final Δ at the end of Main's lap. Positive = Main was slower overall.
   *  NaN if Main's lap extent never overlapped Ref's. */
  finalDeltaS: number;
}

/** Compute Δt(distance) for two laps. Time inside each lap is taken relative
 *  to that lap's start (so we're comparing "wall-time at lap-distance d in
 *  Main" vs "wall-time at lap-distance d in Ref" without conflating session
 *  start offsets). Returns null if there's not enough data in either lap to
 *  build a curve. */
export function computeLapDelta(input: DeltaInput): DeltaResult | null {
  const mainRange = findLapIndices(input.mainTimeUs, input.mainDist, input.mainLapStartUs, input.mainLapEndUs);
  if (!mainRange) return null;
  const refRange = findLapIndices(input.refTimeUs, input.refDist, input.refLapStartUs, input.refLapEndUs);
  if (!refRange) return null;

  // Build Ref's (distance → lap-relative-time) lookup arrays, monotonic in
  // distance. We assume distance is non-decreasing within a lap (it should be
  // — it's the integral of |speed|); we clean up tiny regressions defensively
  // by clamping with the running max.
  const refDist: Float64Array = new Float64Array(refRange.count);
  const refTimeS: Float64Array = new Float64Array(refRange.count);
  {
    let lastDist = -Infinity;
    let n = 0;
    for (let k = 0; k < refRange.count; k++) {
      const idx = refRange.i0 + k;
      const d = input.refDist[idx]!;
      if (!Number.isFinite(d)) continue;
      const clamped = d < lastDist ? lastDist : d;
      const t = (Number(input.refTimeUs[idx]!) - input.refLapStartUs) / 1_000_000;
      refDist[n] = clamped;
      refTimeS[n] = t;
      lastDist = clamped;
      n++;
    }
    if (n < 2) return null;
    // Trim to actual length.
    if (n !== refDist.length) {
      const td = new Float64Array(n); td.set(refDist.subarray(0, n));
      const tt = new Float64Array(n); tt.set(refTimeS.subarray(0, n));
      return computeAgainst(input, mainRange, td, tt);
    }
  }
  return computeAgainst(input, mainRange, refDist, refTimeS);
}

interface LapRange { i0: number; count: number; }

function findLapIndices(
  time: BigInt64Array,
  dist: Float64Array,
  startUs: number,
  endUs: number,
): LapRange | null {
  const n = Math.min(time.length, dist.length);
  let i0 = -1, i1 = -1;
  for (let i = 0; i < n; i++) {
    const t = Number(time[i]!);
    if (t < startUs) continue;
    if (t > endUs) break;
    if (i0 < 0) i0 = i;
    i1 = i;
  }
  if (i0 < 0 || i1 < i0 + 1) return null;
  return { i0, count: i1 - i0 + 1 };
}

function computeAgainst(
  input: DeltaInput,
  mainRange: LapRange,
  refDist: Float64Array,
  refTimeS: Float64Array,
): DeltaResult {
  const dist = new Float64Array(mainRange.count);
  const delta = new Float64Array(mainRange.count);
  let lastDist = -Infinity;
  let lastFiniteDelta = NaN;
  const refMaxDist = refDist[refDist.length - 1]!;
  for (let k = 0; k < mainRange.count; k++) {
    const idx = mainRange.i0 + k;
    const d = input.mainDist[idx]!;
    if (!Number.isFinite(d)) {
      dist[k] = lastDist === -Infinity ? 0 : lastDist;
      delta[k] = NaN;
      continue;
    }
    const clamped = d < lastDist ? lastDist : d;
    lastDist = clamped;
    dist[k] = clamped;
    const tMain = (Number(input.mainTimeUs[idx]!) - input.mainLapStartUs) / 1_000_000;
    if (clamped > refMaxDist) {
      delta[k] = NaN;
      continue;
    }
    const tRef = interpolateRefTime(refDist, refTimeS, clamped);
    if (!Number.isFinite(tRef)) {
      delta[k] = NaN;
      continue;
    }
    const dt = tMain - tRef;
    delta[k] = dt;
    lastFiniteDelta = dt;
  }
  return { distance: dist, deltaS: delta, finalDeltaS: lastFiniteDelta };
}

/** Linear interpolation of refTimeS at a target distance, given that refDist
 *  is monotonic non-decreasing. Returns NaN when target is out of range. */
function interpolateRefTime(refDist: Float64Array, refTimeS: Float64Array, target: number): number {
  if (refDist.length === 0) return NaN;
  if (target <= refDist[0]!) return refTimeS[0]!;
  if (target >= refDist[refDist.length - 1]!) return refTimeS[refTimeS.length - 1]!;
  // Binary search for the largest index where refDist[idx] <= target.
  let lo = 0, hi = refDist.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (refDist[mid]! <= target) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.max(0, lo - 1);
  const dA = refDist[i]!, dB = refDist[i + 1]!;
  const tA = refTimeS[i]!, tB = refTimeS[i + 1]!;
  if (dB === dA) return tA;
  const frac = (target - dA) / (dB - dA);
  return tA + (tB - tA) * frac;
}

/** Format Δ for compact display. Always signed, trailing "s". 0.123 → "+0.12s",
 *  −1.4 → "−1.40s", 0 → "0.00s". */
export function formatDelta(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  const abs = Math.abs(v);
  return `${sign}${abs.toFixed(2)}s`;
}
