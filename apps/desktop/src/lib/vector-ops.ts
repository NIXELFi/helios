/* Vector ops for math channels — the time-aware functions that can't be
 * expressed sample-by-sample. Each takes a Float64Array (and the rate group's
 * time index where time is needed) and returns a same-length Float64Array.
 *
 * NaNs in inputs propagate, except where noted. Edge samples for windowed
 * ops (smooth, derivative, shift) are filled with NaN so widgets render gaps
 * rather than fake values.
 */

import type { LapSet } from "@helios/lib";
import { lapAggregate } from "@helios/lib";

/** Central-difference time derivative. d/dt of `values` against `timeUs`.
 *  Edge samples (i = 0 and i = N-1) use forward/backward difference instead.
 *  Output units are inputs-per-second. Duplicate (zero-delta) adjacent
 *  timestamps emit NaN instead of ±Infinity so widgets render a gap rather
 *  than an infinite spike. */
export function derivative(values: Float64Array, timeUs: BigInt64Array): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  if (n === 1) { out[0] = NaN; return out; }
  // Forward difference at i=0
  {
    const v0 = values[0]!, v1 = values[1]!;
    const t0 = Number(timeUs[0]!) / 1_000_000;
    const t1 = Number(timeUs[1]!) / 1_000_000;
    const dt = t1 - t0;
    out[0] = dt === 0 ? NaN : (v1 - v0) / dt;
  }
  // Central difference for the interior
  for (let i = 1; i < n - 1; i++) {
    const tm = Number(timeUs[i - 1]!) / 1_000_000;
    const tp = Number(timeUs[i + 1]!) / 1_000_000;
    const dt = tp - tm;
    out[i] = dt === 0 ? NaN : (values[i + 1]! - values[i - 1]!) / dt;
  }
  // Backward difference at i=N-1
  {
    const vN1 = values[n - 1]!, vN2 = values[n - 2]!;
    const tN1 = Number(timeUs[n - 1]!) / 1_000_000;
    const tN2 = Number(timeUs[n - 2]!) / 1_000_000;
    const dt = tN1 - tN2;
    out[n - 1] = dt === 0 ? NaN : (vN1 - vN2) / dt;
  }
  return out;
}

/** Cumulative trapezoidal integral. ∫values dt from time[0] up to time[i].
 *  Output[0] = 0 by convention (or NaN if input[0] is NaN). NaNs in inputs
 *  emit NaN at that sample so widgets render data gaps as gaps. The running
 *  accumulator is preserved across the gap, so the next valid sample resumes
 *  integration from the last valid acc — the NaN gap itself contributes
 *  nothing to the integral (not propagating). */
export function integral(values: Float64Array, timeUs: BigInt64Array): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  let acc = 0;
  const v0 = values[0]!;
  out[0] = Number.isFinite(v0) ? 0 : NaN;
  let prevT = Number(timeUs[0]!) / 1_000_000;
  let prevV = v0;
  for (let i = 1; i < n; i++) {
    const t = Number(timeUs[i]!) / 1_000_000;
    const v = values[i]!;
    if (Number.isFinite(prevV) && Number.isFinite(v)) {
      acc += 0.5 * (prevV + v) * (t - prevT);
    }
    // Emit NaN at NaN-input samples to surface gaps; keep `acc` intact so the
    // next finite sample resumes from the previous valid accumulator.
    out[i] = Number.isFinite(v) ? acc : NaN;
    prevT = t;
    prevV = v;
  }
  return out;
}

/** Shift `values` forward (`dtSeconds > 0`) or backward (`< 0`) in time.
 *  At a sample at time t, return values[i'] where time[i'] ≈ t - dtSeconds.
 *  Edge samples whose source time is outside the array are NaN. */
export function shift(values: Float64Array, timeUs: BigInt64Array, dtSeconds: number): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  const dtUs = BigInt(Math.round(dtSeconds * 1_000_000));
  for (let i = 0; i < n; i++) {
    const targetT = timeUs[i]! - dtUs;
    if (targetT < timeUs[0]! || targetT > timeUs[n - 1]!) {
      out[i] = NaN;
      continue;
    }
    // Binary search for the largest j with timeUs[j] <= targetT
    let lo = 0, hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (timeUs[mid]! <= targetT) lo = mid + 1; else hi = mid;
    }
    const j = Math.max(0, lo - 1);
    out[i] = values[j]!;
  }
  return out;
}

/** Centered moving average over `window` samples. Edge samples (where the
 *  window would extend outside the array) are NaN so we don't fake values
 *  with smaller windows. `window` must be a positive integer; even values
 *  are floored to the next odd to keep the window centered. */
export function smooth(values: Float64Array, window: number): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  let w = Math.max(1, Math.floor(window));
  if (w % 2 === 0) w -= 1; // force odd → centerable
  if (w < 1) w = 1;
  if (w === 1) { out.set(values); return out; }
  const half = (w - 1) / 2;
  for (let i = 0; i < n; i++) {
    if (i < half || i + half >= n) { out[i] = NaN; continue; }
    let sum = 0;
    let count = 0;
    for (let k = i - half; k <= i + half; k++) {
      const v = values[k]!;
      if (Number.isFinite(v)) { sum += v; count++; }
    }
    out[i] = count > 0 ? sum / count : NaN;
  }
  return out;
}

/** First-order IIR low-pass filter at cutoff `fcHz`. `sampleRateHz` is the
 *  rate group's nominal rate. Output[0] = input[0]; subsequent samples
 *  follow `y[n] = α y[n-1] + (1-α) x[n]` where `α = exp(-2π fc / fs)`. */
export function lowpass(values: Float64Array, fcHz: number, sampleRateHz: number): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  if (!Number.isFinite(fcHz) || fcHz <= 0) {
    out.set(values);
    return out;
  }
  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) {
    out.set(values);
    return out;
  }
  // Standard exponential-smoothing alpha. Lower fc → stronger smoothing.
  const alpha = Math.exp(-2 * Math.PI * fcHz / sampleRateHz);
  out[0] = values[0]!;
  for (let i = 1; i < n; i++) {
    const prev = out[i - 1]!;
    const v = values[i]!;
    if (!Number.isFinite(v)) { out[i] = prev; continue; }
    if (!Number.isFinite(prev)) { out[i] = v; continue; }
    out[i] = alpha * prev + (1 - alpha) * v;
  }
  return out;
}

/** First-order high-pass IIR. Removes drift below `fcHz` (e.g. damper-velocity
 *  baseline). `y[n] = α (y[n-1] + x[n] - x[n-1])` where `α = exp(-2π fc/fs)`.
 *  Output[0] = 0 by convention. */
export function highpass(values: Float64Array, fcHz: number, sampleRateHz: number): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  if (!Number.isFinite(fcHz) || fcHz <= 0) { out.set(values); return out; }
  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) { out.set(values); return out; }
  const alpha = Math.exp(-2 * Math.PI * fcHz / sampleRateHz);
  out[0] = 0;
  for (let i = 1; i < n; i++) {
    const prevX = values[i - 1]!;
    const x = values[i]!;
    const prevY = out[i - 1]!;
    if (!Number.isFinite(x) || !Number.isFinite(prevX) || !Number.isFinite(prevY)) {
      out[i] = 0;
      continue;
    }
    out[i] = alpha * (prevY + x - prevX);
  }
  return out;
}

/** Lag-1 sample with default for the very first index. Lets users build
 *  custom edge detectors and finite-difference math without dropping into
 *  derivative()/shift() syntax. */
export function previousSample(values: Float64Array, defaultV: number): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  out[0] = defaultV;
  for (let i = 1; i < n; i++) out[i] = values[i - 1]!;
  return out;
}

/** Output 1 once `cond` has been true for `holdSeconds` continuously, else 0.
 *  Resets the held-true clock when `cond` goes false. Useful as `time_valid`
 *  in MoTeC parlance — debounces a noisy condition. */
export function timeValid(
  cond: Float64Array, timeUs: BigInt64Array, holdSeconds: number,
): Float64Array {
  const n = Math.min(cond.length, timeUs.length);
  const out = new Float64Array(n);
  let trueSinceUs = -1;
  const holdUs = BigInt(Math.round(holdSeconds * 1_000_000));
  for (let i = 0; i < n; i++) {
    const c = cond[i]! !== 0;
    if (!c) { trueSinceUs = -1; out[i] = 0; continue; }
    if (trueSinceUs < 0) trueSinceUs = Number(timeUs[i]!);
    out[i] = (BigInt(Number(timeUs[i]!)) - BigInt(trueSinceUs)) >= holdUs ? 1 : 0;
  }
  return out;
}

/** Edge detector with optional minimum hold-on time. Emits a 1 for one sample
 *  at each rising/falling edge of `cond` provided the edge persists at least
 *  `minHoldSeconds`. Useful for counting clean events.
 *  edgeKind: 0 = rising, 1 = falling. */
export function edgeDelay(
  cond: Float64Array, timeUs: BigInt64Array, minHoldSeconds: number, edgeKind: 0 | 1,
): Float64Array {
  const n = Math.min(cond.length, timeUs.length);
  const out = new Float64Array(n);
  if (n === 0) return out;
  const holdUs = BigInt(Math.round(minHoldSeconds * 1_000_000));
  let prev = cond[0]! !== 0 ? 1 : 0;
  let lastEdgeAt = -1;
  let pendingState = -1;
  for (let i = 1; i < n; i++) {
    const c = cond[i]! !== 0 ? 1 : 0;
    const tUs = Number(timeUs[i]!);
    if (c !== prev) {
      lastEdgeAt = tUs;
      pendingState = c;
    }
    if (lastEdgeAt >= 0
        && pendingState !== -1
        && (BigInt(tUs) - BigInt(lastEdgeAt)) >= holdUs) {
      const isRising = pendingState === 1;
      if ((edgeKind === 0 && isRising) || (edgeKind === 1 && !isRising)) {
        out[i] = 1;
      }
      pendingState = -1;
    }
    prev = c;
  }
  return out;
}

/** Increments by 1 at every rising edge of `cond`. The MoTeC `range_change`
 *  semantics: counts events. Equivalent to `cumsum(rising_edge(cond))`. */
export function rangeChange(cond: Float64Array): Float64Array {
  const n = cond.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  let prev = cond[0]! !== 0 ? 1 : 0;
  let count = 0;
  out[0] = 0;
  for (let i = 1; i < n; i++) {
    const c = cond[i]! !== 0 ? 1 : 0;
    if (prev === 0 && c === 1) count++;
    out[i] = count;
    prev = c;
  }
  return out;
}

/** SR latch. Goes 1 on rising edge of `set`, 0 on rising edge of `reset`.
 *  When both edges fire at the same sample, `reset` wins (safe default for
 *  alarm-latch use cases). */
export function flipFlop(setCond: Float64Array, resetCond: Float64Array): Float64Array {
  const n = Math.min(setCond.length, resetCond.length);
  const out = new Float64Array(n);
  if (n === 0) return out;
  let state = 0;
  let prevS = setCond[0]! !== 0 ? 1 : 0;
  let prevR = resetCond[0]! !== 0 ? 1 : 0;
  for (let i = 0; i < n; i++) {
    const s = setCond[i]! !== 0 ? 1 : 0;
    const r = resetCond[i]! !== 0 ? 1 : 0;
    const setEdge = i > 0 && prevS === 0 && s === 1;
    const resetEdge = i > 0 && prevR === 0 && r === 1;
    if (resetEdge) state = 0;
    else if (setEdge) state = 1;
    out[i] = state;
    prevS = s; prevR = r;
  }
  return out;
}

export type StatOp = "stat_min" | "stat_max" | "stat_mean" | "stat_std_dev"
                   | "stat_start" | "stat_end" | "integrate";

/** Conditional running statistic over the active window of `cond`. The window
 *  opens on a rising edge of cond, accumulates while cond stays nonzero, and
 *  emits a final value at the falling edge that holds until the next opening.
 *  Mirrors MoTeC's stat_* family.
 *
 *  - stat_min/max/mean: aggregate over the active window
 *  - stat_start: value at the rising edge
 *  - stat_end:   value at the falling edge
 *  - integrate:  ∫ values dt over the active window (NOT cumulative across windows) */
export function statOver(
  op: StatOp,
  values: Float64Array,
  cond: Float64Array,
  timeUs: BigInt64Array,
): Float64Array {
  const n = Math.min(values.length, cond.length, timeUs.length);
  const out = new Float64Array(n);
  if (n === 0) return out;
  let active = false;
  let mn = Infinity, mx = -Infinity, sum = 0, cnt = 0, sumSq = 0;
  let startV = NaN, endV = NaN;
  let intAcc = 0, intPrevT = -1, intPrevV = NaN;
  let lastEmitted = NaN;
  let prevC = 0;
  for (let i = 0; i < n; i++) {
    const c = cond[i]! !== 0 ? 1 : 0;
    const v = values[i]!;
    const tUs = Number(timeUs[i]!);
    const rising = i > 0 && prevC === 0 && c === 1;
    const falling = i > 0 && prevC === 1 && c === 0;
    if (rising) {
      mn = Infinity; mx = -Infinity; sum = 0; cnt = 0; sumSq = 0;
      startV = v; endV = v;
      intAcc = 0; intPrevT = tUs; intPrevV = v;
      active = true;
    }
    if (active) {
      if (Number.isFinite(v)) {
        if (v < mn) mn = v;
        if (v > mx) mx = v;
        sum += v; cnt++; sumSq += v * v;
        endV = v;
      }
      if (intPrevT >= 0 && Number.isFinite(intPrevV) && Number.isFinite(v)) {
        const dt = (tUs - intPrevT) / 1_000_000;
        intAcc += 0.5 * (intPrevV + v) * dt;
      }
      intPrevT = tUs; intPrevV = v;
    }
    if (falling) {
      lastEmitted = aggValue(op, mn, mx, sum, cnt, sumSq, startV, endV, intAcc);
      active = false;
    }
    // While active, emit the running aggregate. While idle, hold the last
    // emitted value (or NaN if nothing has fired yet).
    out[i] = active
      ? aggValue(op, mn, mx, sum, cnt, sumSq, startV, endV, intAcc)
      : lastEmitted;
    prevC = c;
  }
  return out;
}

function aggValue(
  op: StatOp,
  mn: number, mx: number, sum: number, cnt: number, sumSq: number,
  startV: number, endV: number, intAcc: number,
): number {
  switch (op) {
    case "stat_min": return cnt === 0 ? NaN : mn;
    case "stat_max": return cnt === 0 ? NaN : mx;
    case "stat_mean": return cnt === 0 ? NaN : sum / cnt;
    case "stat_std_dev": {
      if (cnt < 2) return 0;
      const m = sum / cnt;
      const variance = (sumSq - cnt * m * m) / (cnt - 1);
      return variance < 0 ? 0 : Math.sqrt(variance);
    }
    case "stat_start": return startV;
    case "stat_end":   return endV;
    case "integrate":  return intAcc;
  }
}

/** Wrapper for lap-aggregate vector ops; resolves at apply time once the
 *  caller provides a `LapSet`. Returns NaN-filled when laps are absent so
 *  the math still parses and downstream channels keep their shape. */
export function lapAggOp(
  op: "lap_max" | "lap_min" | "lap_mean" | "lap_first" | "lap_last",
  values: Float64Array,
  timeUs: BigInt64Array,
  laps: LapSet | null,
): Float64Array {
  if (!laps || laps.laps.length === 0) {
    const out = new Float64Array(values.length);
    out.fill(NaN);
    return out;
  }
  return lapAggregate(op, values, timeUs, laps);
}

/** Names the math-channel preprocessor recognizes as vector ops. The parser
 *  accepts these as ordinary function calls (the tokenizer doesn't know
 *  about them); the apply function intercepts them before per-sample
 *  evaluation. */
export const VECTOR_OPS = new Set([
  "derivative", "integral", "shift", "smooth", "lowpass", "highpass",
  "previous_sample", "time_valid", "edge_delay", "range_change", "flip_flop",
  "stat_min", "stat_max", "stat_mean", "stat_std_dev", "stat_start", "stat_end",
  "integrate_over",
]);

/** Lap-aggregate vector ops; require a LapSet for evaluation. Listed
 *  separately so the math UI can show a hint when laps aren't configured
 *  yet, and the preprocessor can route them through `lapAggOp`. */
export const LAP_OPS = new Set([
  "lap_max", "lap_min", "lap_mean", "lap_first", "lap_last",
]);
