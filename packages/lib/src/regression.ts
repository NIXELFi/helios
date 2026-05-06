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

/** y = b0 + b1·x + b2·x² + … + bd·x^d  (normal equations, Gauss-Jordan).
 *  Degree must be >= 1; >= 6 starts to numerically misbehave on real data. */
export function fitPolynomial(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  degree: number,
): FitResult {
  if (degree < 1 || !Number.isInteger(degree)) return NO_FIT;
  const n = Math.min(xs.length, ys.length);
  const X: number[] = [], Y: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = xs[i]!, y = ys[i]!;
    if (Number.isFinite(x) && Number.isFinite(y)) { X.push(x); Y.push(y); }
  }
  const valid = X.length;
  if (valid < degree + 1) return { ...NO_FIT, validSamples: valid };
  const dim = degree + 1;
  const A: number[][] = Array.from({ length: dim }, () => new Array(dim).fill(0));
  const b: number[] = new Array(dim).fill(0);
  for (let i = 0; i < valid; i++) {
    const x = X[i]!, y = Y[i]!;
    let xPow = 1;
    const powers: number[] = [];
    for (let p = 0; p < dim; p++) { powers.push(xPow); xPow *= x; }
    for (let j = 0; j < dim; j++) {
      b[j]! += y * powers[j]!;
      for (let k = 0; k < dim; k++) A[j]![k]! += powers[j]! * powers[k]!;
    }
  }
  const coeffs = gaussJordanSolve(A, b);
  if (!coeffs) return { ...NO_FIT, validSamples: valid };
  const predict = (x: number): number => {
    let r = 0, xp = 1;
    for (let j = 0; j < dim; j++) { r += coeffs[j]! * xp; xp *= x; }
    return r;
  };
  let ssRes = 0, ssTot = 0, yMean = 0;
  for (let i = 0; i < valid; i++) yMean += Y[i]!;
  yMean /= valid;
  for (let i = 0; i < valid; i++) {
    const r = Y[i]! - predict(X[i]!);
    ssRes += r * r;
    ssTot += (Y[i]! - yMean) * (Y[i]! - yMean);
  }
  const rSquared = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  const residualStd = Math.sqrt(ssRes / Math.max(1, valid - dim));
  return { coefficients: coeffs, rSquared, residualStd, validSamples: valid, predict };
}

/** Standard Gauss-Jordan elimination with partial pivoting. Returns null
 *  when the matrix is singular. */
function gaussJordanSolve(matrix: number[][], rhs: number[]): number[] | null {
  const n = matrix.length;
  const A = matrix.map((row, i) => [...row, rhs[i]!]);
  for (let i = 0; i < n; i++) {
    let pivotRow = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r]![i]!) > Math.abs(A[pivotRow]![i]!)) pivotRow = r;
    if (Math.abs(A[pivotRow]![i]!) < 1e-12) return null;
    if (pivotRow !== i) [A[i], A[pivotRow]] = [A[pivotRow]!, A[i]!];
    for (let r = i + 1; r < n; r++) {
      const f = A[r]![i]! / A[i]![i]!;
      for (let c = i; c <= n; c++) A[r]![c]! -= f * A[i]![c]!;
    }
  }
  const x: number[] = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = A[i]![n]!;
    for (let c = i + 1; c < n; c++) s -= A[i]![c]! * x[c]!;
    x[i] = s / A[i]![i]!;
  }
  return x;
}

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
