/* In-place radix-2 Cooley–Tukey FFT, real-input convenience wrapper, and a
 * Hanning window. Pure-JS, no deps. Power-of-2 sizes only — callers pad or
 * truncate to the nearest power of 2 before invoking.
 *
 * Used by the FFT widget but exported as a general-purpose helper. The
 * complex inputs/outputs are interleaved in a single Float64Array (re0, im0,
 * re1, im1, …) to avoid two-array bookkeeping. */

/** Round n down to the nearest power of two. Returns 0 when n < 1. */
export function pow2Floor(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 0;
  return 1 << Math.floor(Math.log2(n));
}

/** Hanning window of length N. Multiplies endpoints toward 0 to suppress
 *  spectral leakage from non-periodic real-world signals. */
export function hanning(n: number): Float64Array {
  const out = new Float64Array(n);
  if (n <= 1) { out[0] = 1; return out; }
  for (let i = 0; i < n; i++) out[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return out;
}

/** In-place complex FFT. `interleaved` is [re0, im0, re1, im1, …, reN-1, imN-1]
 *  with N a power of two. Throws when N is not power of two. */
export function fft(interleaved: Float64Array): void {
  const n2 = interleaved.length;
  const n = n2 / 2;
  if (n < 1 || (n & (n - 1)) !== 0) throw new Error(`fft: length ${n} is not a power of two`);
  // Bit-reversal permutation
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const ti = i << 1, tj = j << 1;
      let tmp = interleaved[ti]!;     interleaved[ti]     = interleaved[tj]!;     interleaved[tj]     = tmp;
      tmp     = interleaved[ti + 1]!; interleaved[ti + 1] = interleaved[tj + 1]!; interleaved[tj + 1] = tmp;
    }
  }
  // Cooley-Tukey butterflies
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const angle = -2 * Math.PI / len;
    const wRe = Math.cos(angle), wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < halfLen; k++) {
        const aIdx = (i + k) << 1;
        const bIdx = (i + k + halfLen) << 1;
        const aRe = interleaved[aIdx]!, aIm = interleaved[aIdx + 1]!;
        const bRe = interleaved[bIdx]!, bIm = interleaved[bIdx + 1]!;
        const tRe = bRe * curRe - bIm * curIm;
        const tIm = bRe * curIm + bIm * curRe;
        interleaved[aIdx]     = aRe + tRe;
        interleaved[aIdx + 1] = aIm + tIm;
        interleaved[bIdx]     = aRe - tRe;
        interleaved[bIdx + 1] = aIm - tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/** Convenience: take a real-valued time-domain signal, optionally apply a
 *  Hanning window, and return the magnitude spectrum (length N/2 + 1) and
 *  corresponding frequency bins (Hz) given `sampleRateHz`. The DC bin is
 *  included; the Nyquist bin is the last entry. */
export function magnitudeSpectrum(
  values: Float64Array,
  sampleRateHz: number,
  applyWindow: boolean,
): { freqHz: Float64Array; magnitude: Float64Array } {
  const nIn = values.length;
  const N = pow2Floor(nIn);
  if (N < 2) return { freqHz: new Float64Array(0), magnitude: new Float64Array(0) };
  const buf = new Float64Array(2 * N);
  if (applyWindow) {
    const w = hanning(N);
    for (let i = 0; i < N; i++) {
      buf[2 * i] = (values[i]! || 0) * w[i]!;
    }
  } else {
    for (let i = 0; i < N; i++) buf[2 * i] = values[i]! || 0;
  }
  fft(buf);
  const half = N / 2;
  const freq = new Float64Array(half + 1);
  const mag = new Float64Array(half + 1);
  // Match numpy's rfft scaling — magnitude scaled by 2/N for non-DC/Nyquist
  // bins so the displayed amplitude approximates the input signal's amplitude
  // for a pure sinusoid. Hanning correction factor (2x) compensates for the
  // window's mean of 0.5; gives values close to the underlying signal peak.
  const scale = 2 / N;
  const winCorr = applyWindow ? 2 : 1;
  for (let k = 0; k <= half; k++) {
    const re = buf[2 * k]!, im = buf[2 * k + 1]!;
    const m = Math.sqrt(re * re + im * im) * scale * winCorr;
    mag[k] = (k === 0 || k === half) ? m / 2 : m;
    freq[k] = (k * sampleRateHz) / N;
  }
  return { freqHz: freq, magnitude: mag };
}
