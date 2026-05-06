/* Lightweight statistics utilities used by widgets that compute fits or
 * binned aggregates. NaN values are skipped (the only sane default for
 * sensor data with sparse channels). All inputs are ArrayLike<number>
 * so callers can pass typed arrays without converting first. */

function packFinite(xs: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < xs.length; i++) if (Number.isFinite(xs[i]!)) out.push(xs[i]!);
  return out;
}

export function mean(xs: ArrayLike<number>): number {
  let sum = 0, n = 0;
  for (let i = 0; i < xs.length; i++) {
    const v = xs[i]!;
    if (Number.isFinite(v)) { sum += v; n++; }
  }
  return n === 0 ? NaN : sum / n;
}

export function stddev(xs: ArrayLike<number>): number {
  const m = mean(xs);
  if (!Number.isFinite(m)) return NaN;
  let ss = 0, n = 0;
  for (let i = 0; i < xs.length; i++) {
    const v = xs[i]!;
    if (Number.isFinite(v)) { const d = v - m; ss += d * d; n++; }
  }
  if (n < 2) return 0;
  return Math.sqrt(ss / (n - 1));
}

/** Pearson correlation. Returns NaN if either array has < 2 paired
 *  finite samples or if either has zero variance. */
export function correlation(xs: ArrayLike<number>, ys: ArrayLike<number>): number {
  const n = Math.min(xs.length, ys.length);
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, valid = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i]!, y = ys[i]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; valid++;
  }
  if (valid < 2) return NaN;
  const num = valid * sxy - sx * sy;
  const den = Math.sqrt((valid * sxx - sx * sx) * (valid * syy - sy * sy));
  return den === 0 ? NaN : num / den;
}

/** Type-7 percentile (numpy's "linear" interpolation, R's default).
 *  p in [0, 100]. Returns NaN if no finite samples. */
export function percentile(xs: ArrayLike<number>, p: number): number {
  const arr = packFinite(xs).sort((a, b) => a - b);
  if (arr.length === 0) return NaN;
  if (arr.length === 1) return arr[0]!;
  const h = (p / 100) * (arr.length - 1);
  const lo = Math.floor(h), hi = Math.ceil(h);
  if (lo === hi) return arr[lo]!;
  return arr[lo]! + (h - lo) * (arr[hi]! - arr[lo]!);
}

/** N evenly-spaced values from lo to hi inclusive. n=1 returns [lo]. */
export function linspace(lo: number, hi: number, n: number): Float64Array {
  if (n <= 0) return new Float64Array(0);
  if (n === 1) return Float64Array.from([lo]);
  const out = new Float64Array(n);
  const step = (hi - lo) / (n - 1);
  for (let i = 0; i < n; i++) out[i] = lo + step * i;
  return out;
}
