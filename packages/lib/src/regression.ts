/* Regression utilities. Pure math, no DOM, no React, suitable for any
 * widget or batch analysis. Each fit returns coefficients, R² (always
 * computed on the original Y scale, not any linearised intermediate),
 * the standard deviation of residuals (for ±σ confidence-band rendering),
 * a `predict(x)` callable, and the count of samples that survived NaN /
 * domain filtering. */

export interface FitResult {
  /** [b0, b1, ...] — meaning depends on fit kind. See per-fn docs. */
  coefficients: number[];
  /** Coefficient of determination, computed on the original scale. */
  rSquared: number;
  /** Standard deviation of residuals on the original scale. */
  residualStd: number;
  /** Number of samples that survived NaN / domain filtering. */
  validSamples: number;
  /** Evaluate the fit at an arbitrary x. */
  predict(x: number): number;
}

const NO_FIT: FitResult = {
  coefficients: [], rSquared: 0, residualStd: 0, validSamples: 0,
  predict: () => NaN,
};

/** y = b0 + b1·x  (closed-form least squares). */
export function fitLinear(xs: ArrayLike<number>, ys: ArrayLike<number>): FitResult {
  const n = Math.min(xs.length, ys.length);
  let sx = 0, sy = 0, sxx = 0, sxy = 0, valid = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i]!, y = ys[i]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    sx += x; sy += y; sxx += x * x; sxy += x * y; valid++;
  }
  if (valid < 2) return NO_FIT;
  const denom = valid * sxx - sx * sx;
  if (denom === 0) return { ...NO_FIT, validSamples: valid };
  const b1 = (valid * sxy - sx * sy) / denom;
  const b0 = (sy - b1 * sx) / valid;
  let ssRes = 0, ssTot = 0;
  const yMean = sy / valid;
  for (let i = 0; i < n; i++) {
    const x = xs[i]!, y = ys[i]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const yhat = b0 + b1 * x;
    const r = y - yhat;
    ssRes += r * r;
    ssTot += (y - yMean) * (y - yMean);
  }
  const rSquared = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  const residualStd = Math.sqrt(ssRes / Math.max(1, valid - 2));
  return {
    coefficients: [b0, b1],
    rSquared,
    residualStd,
    validSamples: valid,
    predict: (x: number) => b0 + b1 * x,
  };
}
