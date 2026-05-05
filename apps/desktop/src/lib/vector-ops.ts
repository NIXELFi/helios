/* Vector ops for math channels — the time-aware functions that can't be
 * expressed sample-by-sample. Each takes a Float64Array (and the rate group's
 * time index where time is needed) and returns a same-length Float64Array.
 *
 * NaNs in inputs propagate, except where noted. Edge samples for windowed
 * ops (smooth, derivative, shift) are filled with NaN so widgets render gaps
 * rather than fake values.
 */

/** Central-difference time derivative. d/dt of `values` against `timeUs`.
 *  Edge samples (i = 0 and i = N-1) use forward/backward difference instead.
 *  Output units are inputs-per-second. */
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
    out[0] = (v1 - v0) / (t1 - t0);
  }
  // Central difference for the interior
  for (let i = 1; i < n - 1; i++) {
    const tm = Number(timeUs[i - 1]!) / 1_000_000;
    const tp = Number(timeUs[i + 1]!) / 1_000_000;
    out[i] = (values[i + 1]! - values[i - 1]!) / (tp - tm);
  }
  // Backward difference at i=N-1
  {
    const vN1 = values[n - 1]!, vN2 = values[n - 2]!;
    const tN1 = Number(timeUs[n - 1]!) / 1_000_000;
    const tN2 = Number(timeUs[n - 2]!) / 1_000_000;
    out[n - 1] = (vN1 - vN2) / (tN1 - tN2);
  }
  return out;
}

/** Cumulative trapezoidal integral. ∫values dt from time[0] up to time[i].
 *  Output[0] = 0 by convention. NaNs in inputs reset the running sum to NaN
 *  for that sample, but later samples are treated as starting fresh from the
 *  next valid value (not propagating). */
export function integral(values: Float64Array, timeUs: BigInt64Array): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  let acc = 0;
  out[0] = 0;
  let prevT = Number(timeUs[0]!) / 1_000_000;
  let prevV = values[0]!;
  for (let i = 1; i < n; i++) {
    const t = Number(timeUs[i]!) / 1_000_000;
    const v = values[i]!;
    if (Number.isFinite(prevV) && Number.isFinite(v)) {
      acc += 0.5 * (prevV + v) * (t - prevT);
    }
    out[i] = acc;
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

/** Names the math-channel preprocessor recognizes as vector ops. The parser
 *  accepts these as ordinary function calls (the tokenizer doesn't know
 *  about them); the apply function intercepts them before per-sample
 *  evaluation. */
export const VECTOR_OPS = new Set([
  "derivative", "integral", "shift", "smooth", "lowpass",
]);

/** Names that are reserved for future lap-aggregate work. They parse and
 *  surface a clear error instead of silently returning NaN, so users know
 *  the feature is acknowledged but not yet implemented. */
export const LAP_OPS = new Set([
  "lap_max", "lap_min", "lap_mean", "lap_first", "lap_last",
]);
