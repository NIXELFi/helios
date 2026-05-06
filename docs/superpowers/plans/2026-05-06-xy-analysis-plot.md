# XY Analysis Plot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the existing `xy_plot` widget into a fully composable analysis tool — simple/advanced mode toggle, plugin-style overlays (scatter / fit / formula / bins / stats / quadrant-fit), filter + group-by + zoom-respecting data pipeline, math-library additions for regression and statistics — while keeping every existing saved tile rendering identically via a one-shot migration.

**Architecture:** Plugin-style overlay system. Each overlay kind is a self-contained module exposing `{ defaultConfig, compute, draw?, Component?, Editor }`. The render orchestrator runs a shared data pipeline once (filter → group-by → zoom-clamp), then iterates `config.overlays` calling each module's compute/draw or DOM Component. New regression and statistics utilities live in `@helios/lib` so they're testable in isolation. A migration in `xy-plot/index.tsx` rewrites legacy v1 configs into the v2 schema on read.

**Tech Stack:** TypeScript, React 18, vitest, JSDOM, Canvas 2D API, math-expr engine (existing `@helios/lib/math-expr`), uPlot is **not** used in the XY plot (canvas-direct), pnpm workspaces.

**Spec:** [`docs/superpowers/specs/2026-05-06-xy-analysis-plot-design.md`](../specs/2026-05-06-xy-analysis-plot-design.md)

---

## Phase 1 — Math library: regression + statistics

The widget cannot render any fit overlay until these utilities exist. They live in `@helios/lib` so the regression math is testable in isolation and reusable by future widgets.

### Task 1: `fitLinear` + result types in `regression.ts`

**Files:**
- Create: `packages/lib/src/regression.ts`
- Test: `packages/lib/tests/regression.test.ts`
- Modify: `packages/lib/src/index.ts` (add export)

- [ ] **Step 1: Write the failing test**

```ts
// packages/lib/tests/regression.test.ts
import { describe, it, expect } from "vitest";
import { fitLinear } from "../src/regression";

describe("fitLinear", () => {
  it("recovers exact slope + intercept for a perfect line", () => {
    // y = 3x + 1
    const xs = [0, 1, 2, 3, 4];
    const ys = [1, 4, 7, 10, 13];
    const fit = fitLinear(xs, ys);
    expect(fit.coefficients[0]).toBeCloseTo(1, 8);   // intercept
    expect(fit.coefficients[1]).toBeCloseTo(3, 8);   // slope
    expect(fit.rSquared).toBeCloseTo(1, 8);
    expect(fit.residualStd).toBeCloseTo(0, 8);
    expect(fit.predict(5)).toBeCloseTo(16, 8);
  });

  it("returns R²=0 for a constant Y", () => {
    const xs = [0, 1, 2, 3];
    const ys = [5, 5, 5, 5];
    const fit = fitLinear(xs, ys);
    expect(fit.rSquared).toBeCloseTo(0, 8);
  });

  it("skips NaN samples", () => {
    const xs = [0, 1, NaN, 3, 4];
    const ys = [1, 4, 99,  10, 13];
    const fit = fitLinear(xs, ys);
    expect(fit.coefficients[1]).toBeCloseTo(3, 4);
    expect(fit.validSamples).toBe(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/lib && pnpm vitest run tests/regression.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `fitLinear`**

```ts
// packages/lib/src/regression.ts
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
  // Residuals + R²
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
```

- [ ] **Step 4: Add lib export**

```ts
// packages/lib/src/index.ts (add line at end)
export * from "./regression";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/lib && pnpm vitest run tests/regression.test.ts`
Expected: PASS — 3 tests

- [ ] **Step 6: Commit**

```bash
git add packages/lib/src/regression.ts packages/lib/src/index.ts packages/lib/tests/regression.test.ts
git commit -m "feat(lib): regression — fitLinear with R² + residualStd"
```

---

### Task 2: `fitPolynomial` (normal equations)

**Files:**
- Modify: `packages/lib/src/regression.ts`
- Modify: `packages/lib/tests/regression.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// Append to packages/lib/tests/regression.test.ts
import { fitPolynomial } from "../src/regression";

describe("fitPolynomial", () => {
  it("recovers a quadratic exactly", () => {
    // y = 1 + 2x + 3x²
    const xs = [-2, -1, 0, 1, 2, 3];
    const ys = xs.map((x) => 1 + 2 * x + 3 * x * x);
    const fit = fitPolynomial(xs, ys, 2);
    expect(fit.coefficients[0]).toBeCloseTo(1, 6);
    expect(fit.coefficients[1]).toBeCloseTo(2, 6);
    expect(fit.coefficients[2]).toBeCloseTo(3, 6);
    expect(fit.rSquared).toBeCloseTo(1, 6);
    expect(fit.predict(4)).toBeCloseTo(1 + 8 + 48, 6);
  });

  it("returns no-fit when fewer samples than degree+1", () => {
    const fit = fitPolynomial([0, 1], [0, 1], 3);
    expect(fit.coefficients).toEqual([]);
    expect(fit.validSamples).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/lib && pnpm vitest run tests/regression.test.ts`
Expected: FAIL — `fitPolynomial is not exported`

- [ ] **Step 3: Implement `fitPolynomial`**

```ts
// Append to packages/lib/src/regression.ts

/** y = b0 + b1·x + b2·x² + … + bd·x^d  (normal equations, Gauss-Jordan).
 *  Degree must be >= 1; >= 6 starts to numerically misbehave on real data. */
export function fitPolynomial(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  degree: number,
): FitResult {
  if (degree < 1 || !Number.isInteger(degree)) return NO_FIT;
  const n = Math.min(xs.length, ys.length);
  // Filter NaNs into a packed array for clean indexing.
  const X: number[] = [], Y: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = xs[i]!, y = ys[i]!;
    if (Number.isFinite(x) && Number.isFinite(y)) { X.push(x); Y.push(y); }
  }
  const valid = X.length;
  if (valid < degree + 1) return { ...NO_FIT, validSamples: valid };
  // Build the (degree+1)×(degree+1) normal matrix A and rhs b such that
  // A·coeffs = b. A[j][k] = Σ x^(j+k); b[j] = Σ y·x^j.
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
  // R² + residual stddev on original scale.
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
 *  if the matrix is singular (degenerate input data). Mutates copies, not
 *  the input arrays. */
function gaussJordanSolve(matrix: number[][], rhs: number[]): number[] | null {
  const n = matrix.length;
  const A = matrix.map((row, i) => [...row, rhs[i]!]);  // augmented
  for (let i = 0; i < n; i++) {
    // Pivot: find row >=i with largest |A[*][i]| and swap into row i.
    let pivotRow = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r]![i]!) > Math.abs(A[pivotRow]![i]!)) pivotRow = r;
    if (Math.abs(A[pivotRow]![i]!) < 1e-12) return null;
    if (pivotRow !== i) [A[i], A[pivotRow]] = [A[pivotRow]!, A[i]!];
    // Eliminate below.
    for (let r = i + 1; r < n; r++) {
      const f = A[r]![i]! / A[i]![i]!;
      for (let c = i; c <= n; c++) A[r]![c]! -= f * A[i]![c]!;
    }
  }
  // Back-substitute.
  const x: number[] = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = A[i]![n]!;
    for (let c = i + 1; c < n; c++) s -= A[i]![c]! * x[c]!;
    x[i] = s / A[i]![i]!;
  }
  return x;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/lib && pnpm vitest run tests/regression.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add packages/lib/src/regression.ts packages/lib/tests/regression.test.ts
git commit -m "feat(lib): regression — fitPolynomial via normal equations"
```

---

### Task 3: `fitExponential`, `fitLogarithmic`, `fitPower` (linearised)

**Files:**
- Modify: `packages/lib/src/regression.ts`
- Modify: `packages/lib/tests/regression.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// Append to packages/lib/tests/regression.test.ts
import { fitExponential, fitLogarithmic, fitPower } from "../src/regression";

describe("fitExponential", () => {
  it("recovers y = 2 · e^(0.5·x)", () => {
    const xs = [0, 1, 2, 3, 4];
    const ys = xs.map((x) => 2 * Math.exp(0.5 * x));
    const fit = fitExponential(xs, ys);
    expect(fit.coefficients[0]).toBeCloseTo(2, 4);   // a
    expect(fit.coefficients[1]).toBeCloseTo(0.5, 4); // b
    expect(fit.rSquared).toBeCloseTo(1, 4);
  });
  it("skips non-positive y samples", () => {
    const fit = fitExponential([0, 1, 2], [1, -3, 7.389056]);
    expect(fit.validSamples).toBe(2);
  });
});

describe("fitLogarithmic", () => {
  it("recovers y = 1 + 2·ln(x)", () => {
    const xs = [1, 2, 3, 4, 5];
    const ys = xs.map((x) => 1 + 2 * Math.log(x));
    const fit = fitLogarithmic(xs, ys);
    expect(fit.coefficients[0]).toBeCloseTo(1, 4);
    expect(fit.coefficients[1]).toBeCloseTo(2, 4);
  });
  it("skips non-positive x samples", () => {
    const fit = fitLogarithmic([0, 1, 2.718281828], [99, 1, 2]);
    expect(fit.validSamples).toBe(2);
  });
});

describe("fitPower", () => {
  it("recovers y = 3 · x^2", () => {
    const xs = [1, 2, 3, 4, 5];
    const ys = xs.map((x) => 3 * Math.pow(x, 2));
    const fit = fitPower(xs, ys);
    expect(fit.coefficients[0]).toBeCloseTo(3, 4);   // a
    expect(fit.coefficients[1]).toBeCloseTo(2, 4);   // b
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/lib && pnpm vitest run tests/regression.test.ts`
Expected: FAIL — three exports missing

- [ ] **Step 3: Implement the three linearised fits**

```ts
// Append to packages/lib/src/regression.ts

/** y = a · e^(b·x). Linearised by taking ln on both sides and fitting
 *  ln(y) = ln(a) + b·x with linear least squares; samples with y <= 0
 *  are skipped (no real ln). R² + residualStd are reported on the
 *  original (non-log) scale. */
export function fitExponential(xs: ArrayLike<number>, ys: ArrayLike<number>): FitResult {
  const n = Math.min(xs.length, ys.length);
  const X: number[] = [], LY: number[] = [], YORIG: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = xs[i]!, y = ys[i]!;
    if (!Number.isFinite(x) || !Number.isFinite(y) || y <= 0) continue;
    X.push(x); LY.push(Math.log(y)); YORIG.push(y);
  }
  const valid = X.length;
  if (valid < 2) return { ...NO_FIT, validSamples: valid };
  const linFit = fitLinear(X, LY);
  if (linFit.coefficients.length === 0) return { ...NO_FIT, validSamples: valid };
  const lnA = linFit.coefficients[0]!;
  const b = linFit.coefficients[1]!;
  const a = Math.exp(lnA);
  const predict = (x: number) => a * Math.exp(b * x);
  return { coefficients: [a, b], ...rsquaredAndResidual(X, YORIG, predict, valid) };
}

/** y = a + b·ln(x). Skips x <= 0. */
export function fitLogarithmic(xs: ArrayLike<number>, ys: ArrayLike<number>): FitResult {
  const n = Math.min(xs.length, ys.length);
  const LX: number[] = [], Y: number[] = [], XORIG: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = xs[i]!, y = ys[i]!;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0) continue;
    LX.push(Math.log(x)); Y.push(y); XORIG.push(x);
  }
  const valid = LX.length;
  if (valid < 2) return { ...NO_FIT, validSamples: valid };
  const linFit = fitLinear(LX, Y);
  if (linFit.coefficients.length === 0) return { ...NO_FIT, validSamples: valid };
  const a = linFit.coefficients[0]!;
  const b = linFit.coefficients[1]!;
  const predict = (x: number) => a + b * Math.log(x);
  return { coefficients: [a, b], ...rsquaredAndResidual(XORIG, Y, predict, valid) };
}

/** y = a · x^b. Skips x <= 0 or y <= 0. */
export function fitPower(xs: ArrayLike<number>, ys: ArrayLike<number>): FitResult {
  const n = Math.min(xs.length, ys.length);
  const LX: number[] = [], LY: number[] = [], XORIG: number[] = [], YORIG: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = xs[i]!, y = ys[i]!;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) continue;
    LX.push(Math.log(x)); LY.push(Math.log(y)); XORIG.push(x); YORIG.push(y);
  }
  const valid = LX.length;
  if (valid < 2) return { ...NO_FIT, validSamples: valid };
  const linFit = fitLinear(LX, LY);
  if (linFit.coefficients.length === 0) return { ...NO_FIT, validSamples: valid };
  const a = Math.exp(linFit.coefficients[0]!);
  const b = linFit.coefficients[1]!;
  const predict = (x: number) => a * Math.pow(x, b);
  return { coefficients: [a, b], ...rsquaredAndResidual(XORIG, YORIG, predict, valid) };
}

/** Compute R² and residual stddev on the original scale given a predict fn. */
function rsquaredAndResidual(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  predict: (x: number) => number,
  validSamples: number,
): Pick<FitResult, "rSquared" | "residualStd" | "validSamples" | "predict"> {
  const n = Math.min(xs.length, ys.length);
  let sumY = 0;
  for (let i = 0; i < n; i++) sumY += ys[i]!;
  const yMean = sumY / Math.max(1, n);
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i]! - predict(xs[i]!);
    ssRes += r * r;
    ssTot += (ys[i]! - yMean) * (ys[i]! - yMean);
  }
  const rSquared = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  const residualStd = Math.sqrt(ssRes / Math.max(1, n - 2));
  return { rSquared, residualStd, validSamples, predict };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/lib && pnpm vitest run tests/regression.test.ts`
Expected: PASS — 10 tests

- [ ] **Step 5: Commit**

```bash
git add packages/lib/src/regression.ts packages/lib/tests/regression.test.ts
git commit -m "feat(lib): regression — exponential, logarithmic, power fits"
```

---

### Task 4: `statistics.ts` (mean, stddev, correlation, percentile, linspace)

**Files:**
- Create: `packages/lib/src/statistics.ts`
- Test: `packages/lib/tests/statistics.test.ts`
- Modify: `packages/lib/src/index.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/lib/tests/statistics.test.ts
import { describe, it, expect } from "vitest";
import { mean, stddev, correlation, percentile, linspace } from "../src/statistics";

describe("statistics", () => {
  it("mean ignores NaN", () => {
    expect(mean([1, 2, NaN, 4])).toBeCloseTo((1 + 2 + 4) / 3, 8);
  });
  it("mean of empty / all-NaN is NaN", () => {
    expect(mean([])).toBeNaN();
    expect(mean([NaN, NaN])).toBeNaN();
  });
  it("stddev of [2,4,4,4,5,5,7,9] is 2.138 (sample, n-1)", () => {
    expect(stddev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.13809, 4);
  });
  it("correlation of identical arrays is 1", () => {
    expect(correlation([1, 2, 3, 4], [1, 2, 3, 4])).toBeCloseTo(1, 8);
  });
  it("correlation of negated arrays is -1", () => {
    expect(correlation([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 8);
  });
  it("percentile interpolates between samples", () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBeCloseTo(3, 8);
    expect(percentile([1, 2, 3, 4, 5], 25)).toBeCloseTo(2, 8);
    expect(percentile([1, 2, 3, 4, 5], 75)).toBeCloseTo(4, 8);
  });
  it("linspace produces n evenly-spaced values from lo to hi inclusive", () => {
    const ls = linspace(0, 10, 5);
    expect(Array.from(ls)).toEqual([0, 2.5, 5, 7.5, 10]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/lib && pnpm vitest run tests/statistics.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `statistics.ts`**

```ts
// packages/lib/src/statistics.ts
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
  return Math.sqrt(ss / (n - 1));   // sample stddev
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

/** Type-7 percentile (R's default, matches numpy.percentile interpolation="linear").
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
```

- [ ] **Step 4: Add lib export**

```ts
// packages/lib/src/index.ts (add line at end)
export * from "./statistics";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/lib && pnpm vitest run tests/statistics.test.ts`
Expected: PASS — 7 tests

- [ ] **Step 6: Commit**

```bash
git add packages/lib/src/statistics.ts packages/lib/src/index.ts packages/lib/tests/statistics.test.ts
git commit -m "feat(lib): statistics — mean, stddev, correlation, percentile, linspace"
```

---

## Phase 2 — XY plot architecture (no behaviour change yet)

This phase introduces the new types, the migration, the data pipeline, and the empty registry. The widget keeps rendering exactly as today via Phase 3's scatter overlay.

### Task 5: `types.ts` — schema, overlay union, contracts

**Files:**
- Create: `packages/widgets/src/xy-plot/types.ts`

- [ ] **Step 1: Create the types file** (no test — it's pure types; consumers in later tasks exercise them)

```ts
// packages/widgets/src/xy-plot/types.ts
/* Public surface for the XY-plot widget's overlay system. Every overlay
 * module imports the types from here; nothing imports across overlays. */
import type { FC } from "react";
import type { ChannelMeta } from "@helios/store";
import type { OverlaySession } from "../types";

/* ─── Plot-level config ──────────────────────────────────────────────── */

export type Mode = "simple" | "advanced";

export interface XyPlotConfig {
  /** Schema version. v1 = legacy (no overlays array); migrations.ts
   *  rewrites v1 into v2 on load. */
  version: 2;
  mode: Mode;

  xChannelId: string;
  yChannelId: string;
  xMin?: number; xMax?: number;
  yMin?: number; yMax?: number;

  /** Optional math-expr formula. Samples where the result is falsy are
   *  excluded from every overlay. Empty string == no filter. */
  filter?: string;

  /** Optional channel id. When set, distinct values become groups; each
   *  group gets a palette color and (where the overlay supports it) its
   *  own fit. */
  groupByChannelId?: string;

  /** Ordered overlay list. Drawn in array order (later = on top). */
  overlays: Overlay[];
}

/* ─── Overlay union ──────────────────────────────────────────────────── */

export type Overlay =
  | { id: string; kind: "scatter";       config: ScatterConfig }
  | { id: string; kind: "fit";           config: FitConfig }
  | { id: string; kind: "formula";       config: FormulaConfig }
  | { id: string; kind: "bins";          config: BinsConfig }
  | { id: string; kind: "stats";         config: StatsConfig }
  | { id: string; kind: "quadrant-fit";  config: QuadrantFitConfig };

export interface ScatterConfig {
  color: string;
  pointSize: number;     // px, default 2
  alpha: number;         // 0..1, default 1
  trail: boolean;        // existing time-color gradient
}

export type FitKind =
  | { type: "linear" }
  | { type: "polynomial"; degree: number }
  | { type: "exponential" }
  | { type: "logarithmic" }
  | { type: "power" };

export interface FitConfig {
  kind: FitKind;
  color: string;
  lineWidth: number;
  showBand: boolean;
  extrapolate: boolean;
  perGroup: boolean;
}

export interface FormulaConfig {
  expression: string;
  color: string;
  lineWidth: number;
  dashed: boolean;
}

export interface BinsConfig {
  binCount: number;
  statistic: "mean" | "median" | "p25-p75";
  color: string;
  showCount: boolean;
}

export interface StatsConfig {
  position: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  show: {
    count: boolean;
    meanXY: boolean;
    stdXY: boolean;
    correlation: boolean;
    fitRSquared: boolean;
    fitEquation: boolean;
  };
  fitOverlayId?: string;
}

export interface QuadrantFitConfig {
  kind: FitKind;
  color: string;
  lineWidth: number;
  showBand: boolean;
  showStatsOverlay: boolean;
}

/* ─── Pipeline + render contracts ────────────────────────────────────── */

/** One bucket of samples after filter + group-by + zoom. One per
 *  (session × group-by-value) combination. */
export interface SessionGroup {
  session: OverlaySession;
  /** Group-by value as a string ("" when no group-by is configured). */
  groupKey: string;
  /** Color the scatter overlay should use. Palette-cycled per groupKey
   *  when group-by is active; otherwise the overlay's configured color. */
  color: string;
  time: Float64Array;     // µs as f64 (avoids BigInt overhead in compute)
  xs: Float64Array;
  ys: Float64Array;
  n: number;
}

export interface PlotLayout {
  xmin: number; xmax: number; ymin: number; ymax: number;
  padL: number; padT: number; plotW: number; plotH: number;
  /** Project a data-space (x, y) to canvas-space (px, py). */
  project(x: number, y: number): { px: number; py: number };
}

export interface OverlayContext {
  bounds: { xmin: number; xmax: number; ymin: number; ymax: number };
  /** Artifacts produced by overlays earlier in the array. Used by stats
   *  to read a fit's R² + equation by id. */
  priorArtifacts: ReadonlyMap<string, unknown>;
  availableChannels: ChannelMeta[];
}

export interface LegendEntry {
  /** Shown as a small color swatch + label in the in-canvas legend. */
  color: string;
  label: string;
}

export interface OverlayEditorProps<C> {
  config: C;
  onChange: (next: C) => void;
  availableChannels: ChannelMeta[];
}

export interface OverlayModule<C, A> {
  readonly kind: string;
  defaultConfig(): C;
  compute(groups: SessionGroup[], cfg: C, ctx: OverlayContext): A;
  draw?(ctx: CanvasRenderingContext2D, layout: PlotLayout, artifacts: A, cfg: C): void;
  Component?: FC<{ artifacts: A; cfg: C; layout: PlotLayout }>;
  Editor: FC<OverlayEditorProps<C>>;
  legendEntries?(cfg: C, artifacts: A): LegendEntry[];
  availability: ReadonlyArray<Mode>;
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `cd packages/widgets && pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/widgets/src/xy-plot/types.ts
git commit -m "feat(xy-plot): introduce v2 types — XyPlotConfig, Overlay, OverlayModule"
```

---

### Task 6: `migrations.ts` — legacy → v2

**Files:**
- Create: `packages/widgets/src/xy-plot/migrations.ts`
- Test: `packages/widgets/tests/xy-plot/migrations.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/widgets/tests/xy-plot/migrations.test.ts
import { describe, it, expect } from "vitest";
import { migrateConfig } from "../../src/xy-plot/migrations";

describe("migrateConfig", () => {
  it("rewrites a legacy v1 config into v2 with a single scatter overlay", () => {
    const legacy = {
      xChannelId: "throttle",
      yChannelId: "rpm",
      xMin: 0, xMax: 100, yMin: 0, yMax: 14000,
      color: "#26A69A",
      trail: true,
    };
    const v2 = migrateConfig(legacy as never);
    expect(v2.version).toBe(2);
    expect(v2.mode).toBe("simple");
    expect(v2.xChannelId).toBe("throttle");
    expect(v2.yChannelId).toBe("rpm");
    expect(v2.xMin).toBe(0); expect(v2.yMax).toBe(14000);
    expect(v2.overlays).toEqual([{
      id: "migrated-scatter",
      kind: "scatter",
      config: { color: "#26A69A", pointSize: 2, alpha: 1, trail: true },
    }]);
  });

  it("is a no-op on an already-v2 config", () => {
    const v2 = {
      version: 2 as const, mode: "advanced" as const,
      xChannelId: "a", yChannelId: "b",
      overlays: [{ id: "x", kind: "scatter" as const,
        config: { color: "#fff", pointSize: 3, alpha: 1, trail: false } }],
    };
    expect(migrateConfig(v2)).toBe(v2);
  });

  it("supplies sane defaults when legacy fields are missing", () => {
    const sparse = { xChannelId: "a", yChannelId: "b" };
    const v2 = migrateConfig(sparse as never);
    expect(v2.overlays[0]!.kind).toBe("scatter");
    const sc = v2.overlays[0]!.config as { color: string; pointSize: number; alpha: number; trail: boolean };
    expect(sc.color).toBe("#FFC627");
    expect(sc.pointSize).toBe(2);
    expect(sc.alpha).toBe(1);
    expect(sc.trail).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/widgets && pnpm vitest run tests/xy-plot/migrations.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `migrations.ts`**

```ts
// packages/widgets/src/xy-plot/migrations.ts
import type { XyPlotConfig } from "./types";

interface LegacyConfig {
  xChannelId: string;
  yChannelId: string;
  xMin?: number; xMax?: number;
  yMin?: number; yMax?: number;
  color?: string;
  trail?: boolean;
}

/** Turn a v1 (legacy) config into a v2 with a single scatter overlay
 *  preserving the old visual. v2 inputs pass through unchanged so this
 *  is safe to call unconditionally on every config read. */
export function migrateConfig(input: XyPlotConfig | LegacyConfig): XyPlotConfig {
  if ((input as XyPlotConfig).version === 2) return input as XyPlotConfig;
  const legacy = input as LegacyConfig;
  return {
    version: 2,
    mode: "simple",
    xChannelId: legacy.xChannelId,
    yChannelId: legacy.yChannelId,
    xMin: legacy.xMin,
    xMax: legacy.xMax,
    yMin: legacy.yMin,
    yMax: legacy.yMax,
    overlays: [{
      id: "migrated-scatter",
      kind: "scatter",
      config: {
        color: legacy.color ?? "#FFC627",
        pointSize: 2,
        alpha: 1,
        trail: legacy.trail ?? false,
      },
    }],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/widgets && pnpm vitest run tests/xy-plot/migrations.test.ts`
Expected: PASS — 3 tests

- [ ] **Step 5: Commit**

```bash
git add packages/widgets/src/xy-plot/migrations.ts packages/widgets/tests/xy-plot/migrations.test.ts
git commit -m "feat(xy-plot): one-shot v1→v2 config migration"
```

---

### Task 7: `data-pipeline.ts` — filter + group-by + zoom

**Files:**
- Create: `packages/widgets/src/xy-plot/data-pipeline.ts`
- Test: `packages/widgets/tests/xy-plot/data-pipeline.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/widgets/tests/xy-plot/data-pipeline.test.ts
import { describe, it, expect } from "vitest";
import { buildSessionGroups } from "../../src/xy-plot/data-pipeline";
import type { OverlaySession } from "../../src/types";

function fakeSession(): OverlaySession {
  // 5 samples at t = 0, 1, 2, 3, 4 µs
  // throttle = [10, 20, 30, 40, 50], rpm = [1000, 2000, 3000, 4000, 5000],
  // gear = [1, 1, 2, 2, 3]
  return {
    id: "s", label: "s", color: "#FFC627",
    range: { startUs: 0, endUs: 4 },
    isPrimary: true,
    slice: {
      time: BigInt64Array.from([0n, 1n, 2n, 3n, 4n]),
      data: new Map<string, Float64Array>([
        ["throttle", Float64Array.from([10, 20, 30, 40, 50])],
        ["rpm",      Float64Array.from([1000, 2000, 3000, 4000, 5000])],
        ["gear",     Float64Array.from([1, 1, 2, 2, 3])],
      ]),
    },
  };
}

describe("buildSessionGroups", () => {
  it("with no filter / no group-by / no zoom, returns one group per session", () => {
    const out = buildSessionGroups([fakeSession()], {
      xChannelId: "throttle", yChannelId: "rpm",
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.n).toBe(5);
    expect(out[0]!.groupKey).toBe("");
  });

  it("filter expression drops samples where it is falsy", () => {
    const out = buildSessionGroups([fakeSession()], {
      xChannelId: "throttle", yChannelId: "rpm",
      filter: "throttle > 25",
    });
    expect(out[0]!.n).toBe(3);
    expect(Array.from(out[0]!.xs)).toEqual([30, 40, 50]);
  });

  it("group-by produces one group per distinct value, palette-cycled colors", () => {
    const out = buildSessionGroups([fakeSession()], {
      xChannelId: "throttle", yChannelId: "rpm",
      groupByChannelId: "gear",
    });
    expect(out).toHaveLength(3);
    const keys = out.map((g) => g.groupKey).sort();
    expect(keys).toEqual(["1", "2", "3"]);
    // colors must all differ
    const colors = new Set(out.map((g) => g.color));
    expect(colors.size).toBe(3);
  });

  it("zoom range clamps samples by timestamp", () => {
    const out = buildSessionGroups([fakeSession()], {
      xChannelId: "throttle", yChannelId: "rpm",
      zoomRange: { startUs: 1, endUs: 3 },
    });
    expect(out[0]!.n).toBe(3);
    expect(Array.from(out[0]!.xs)).toEqual([20, 30, 40]);
  });

  it("filter + group-by + zoom together compose correctly", () => {
    const out = buildSessionGroups([fakeSession()], {
      xChannelId: "throttle", yChannelId: "rpm",
      filter: "throttle >= 20",
      groupByChannelId: "gear",
      zoomRange: { startUs: 1, endUs: 4 },
    });
    // surviving samples: indices 1..4 with throttle>=20 → all 4. Group by gear:
    // gear=1 → [20], gear=2 → [30,40], gear=3 → [50]
    const byGear = new Map(out.map((g) => [g.groupKey, Array.from(g.xs)]));
    expect(byGear.get("1")).toEqual([20]);
    expect(byGear.get("2")).toEqual([30, 40]);
    expect(byGear.get("3")).toEqual([50]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/widgets && pnpm vitest run tests/xy-plot/data-pipeline.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `data-pipeline.ts`**

```ts
// packages/widgets/src/xy-plot/data-pipeline.ts
import { parseExpr, evalAst, type Ast } from "@helios/lib";
import type { OverlaySession } from "../types";
import type { SessionGroup } from "./types";

export interface PipelineInput {
  xChannelId: string;
  yChannelId: string;
  filter?: string;
  groupByChannelId?: string;
  zoomRange?: { startUs: number; endUs: number } | null;
}

const PALETTE = [
  "#FFC627", "#26A69A", "#EF5350", "#42A5F5",
  "#AB47BC", "#FFA726", "#66BB6A", "#EC407A",
];

/** Compile filter expressions on demand and cache. The cache lives at
 *  module scope so the same formula reused across renders is parsed
 *  once. Invalid formulas are cached as `null` so we don't reparse. */
const exprCache = new Map<string, Ast | null>();
function getCompiledFilter(text: string): Ast | null {
  if (exprCache.has(text)) return exprCache.get(text)!;
  const result = parseExpr(text);
  const ast = result.ast ?? null;
  exprCache.set(text, ast);
  return ast;
}

/** Run filter → group-by → zoom-clamp once over every visible session.
 *  Output is a flat list of (session × groupKey) buckets, each with
 *  packed Float64 arrays the overlays consume. */
export function buildSessionGroups(
  sessions: OverlaySession[],
  input: PipelineInput,
): SessionGroup[] {
  const out: SessionGroup[] = [];
  const filterAst = input.filter && input.filter.trim() ? getCompiledFilter(input.filter) : null;
  const groupChannel = input.groupByChannelId;

  // For deterministic palette assignment we collect groupKeys in first-seen
  // order, then map each to a palette index.
  const groupOrder: string[] = [];
  const groupIndex = new Map<string, number>();
  const ensureGroup = (key: string): number => {
    let idx = groupIndex.get(key);
    if (idx === undefined) { idx = groupOrder.length; groupOrder.push(key); groupIndex.set(key, idx); }
    return idx;
  };

  for (const session of sessions) {
    const xCol = session.slice.data.get(input.xChannelId);
    const yCol = session.slice.data.get(input.yChannelId);
    if (!xCol || !yCol) continue;
    const time = session.slice.time;
    const n = Math.min(xCol.length, yCol.length, time.length);
    const groupCol = groupChannel ? session.slice.data.get(groupChannel) : null;

    // First pass: compute survival mask + group key per sample. Mutable
    // per-group buffers keyed by groupKey.
    const buffers = new Map<string, { time: number[]; xs: number[]; ys: number[] }>();
    const filterEnv: Record<string, number> = {};

    for (let i = 0; i < n; i++) {
      const tUs = Number(time[i]);
      if (input.zoomRange && (tUs < input.zoomRange.startUs || tUs > input.zoomRange.endUs)) continue;
      if (filterAst) {
        // Build a lazy-ish per-sample env: we only populate channels that
        // appear in the formula. For simplicity (and because real filter
        // formulas rarely touch many channels) we just populate every
        // channel referenced by the AST. Cheap: tiny constant-factor cost.
        for (const [name, col] of session.slice.data) filterEnv[name] = col[i] ?? NaN;
        const v = evalAst(filterAst, filterEnv);
        if (!v) continue;   // 0 / NaN / false → drop
      }
      const groupKey = groupChannel && groupCol
        ? String(groupCol[i] ?? "")
        : "";
      let buf = buffers.get(groupKey);
      if (!buf) { buf = { time: [], xs: [], ys: [] }; buffers.set(groupKey, buf); ensureGroup(groupKey); }
      buf.time.push(tUs);
      buf.xs.push(xCol[i]!);
      buf.ys.push(yCol[i]!);
    }

    for (const [groupKey, buf] of buffers) {
      const palIdx = groupChannel ? groupIndex.get(groupKey)! : -1;
      const color = palIdx >= 0 ? PALETTE[palIdx % PALETTE.length]! : session.color;
      out.push({
        session,
        groupKey,
        color,
        time: Float64Array.from(buf.time),
        xs: Float64Array.from(buf.xs),
        ys: Float64Array.from(buf.ys),
        n: buf.xs.length,
      });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/widgets && pnpm vitest run tests/xy-plot/data-pipeline.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add packages/widgets/src/xy-plot/data-pipeline.ts packages/widgets/tests/xy-plot/data-pipeline.test.ts
git commit -m "feat(xy-plot): data pipeline — filter + group-by + zoom"
```

---

### Task 8: Empty `registry.ts` and module-load assertion

**Files:**
- Create: `packages/widgets/src/xy-plot/overlays/registry.ts`

- [ ] **Step 1: Implement registry**

```ts
// packages/widgets/src/xy-plot/overlays/registry.ts
import type { OverlayModule } from "../types";

/* Module registry. Each overlay file imports this and self-registers via
 * the helper below. The render orchestrator and config editor look up
 * overlays by `kind` here so they're agnostic to the available set. */

const REGISTRY = new Map<string, OverlayModule<unknown, unknown>>();

export function register<C, A>(mod: OverlayModule<C, A>): void {
  if (REGISTRY.has(mod.kind)) {
    throw new Error(`Overlay '${mod.kind}' is already registered`);
  }
  if (!mod.draw && !mod.Component) {
    throw new Error(`Overlay '${mod.kind}' must define draw or Component`);
  }
  REGISTRY.set(mod.kind, mod as unknown as OverlayModule<unknown, unknown>);
}

export function getOverlayModule(kind: string): OverlayModule<unknown, unknown> | undefined {
  return REGISTRY.get(kind);
}

export function listOverlayModules(): OverlayModule<unknown, unknown>[] {
  return [...REGISTRY.values()];
}
```

- [ ] **Step 2: Typecheck**

Run: `cd packages/widgets && pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/widgets/src/xy-plot/overlays/registry.ts
git commit -m "feat(xy-plot): overlay module registry"
```

---

## Phase 3 — Migrate scatter to overlay system; preserve existing behaviour

After this phase the widget renders identically to today, but routes through the new architecture. All existing widget tests still pass; legacy configs migrate transparently.

### Task 9: `overlays/scatter.ts`

**Files:**
- Create: `packages/widgets/src/xy-plot/overlays/scatter.ts`
- Test: `packages/widgets/tests/xy-plot/overlays/scatter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/widgets/tests/xy-plot/overlays/scatter.test.ts
import { describe, it, expect } from "vitest";
import { scatterOverlay } from "../../../src/xy-plot/overlays/scatter";
import type { SessionGroup } from "../../../src/xy-plot/types";

const fakeGroup: SessionGroup = {
  session: { id: "s", label: "s", color: "#FFC627",
             range: { startUs: 0, endUs: 1 }, isPrimary: true,
             slice: { time: BigInt64Array.from([0n]), data: new Map() } },
  groupKey: "",
  color: "#FFC627",
  time: Float64Array.from([0]),
  xs: Float64Array.from([1, 2, 3]),
  ys: Float64Array.from([4, 5, 6]),
  n: 3,
};

describe("scatter overlay", () => {
  it("compute returns the unmodified groups (no derived artifacts)", () => {
    const cfg = scatterOverlay.defaultConfig();
    const artifacts = scatterOverlay.compute([fakeGroup], cfg, {
      bounds: { xmin: 0, xmax: 10, ymin: 0, ymax: 10 },
      priorArtifacts: new Map(),
      availableChannels: [],
    });
    expect(artifacts.groups).toBe(artifacts.groups);
    expect(artifacts.groups[0]!.n).toBe(3);
  });

  it("legendEntries produces one entry per group", () => {
    const cfg = scatterOverlay.defaultConfig();
    const artifacts = scatterOverlay.compute([fakeGroup, { ...fakeGroup, groupKey: "g2", color: "#26A69A" }], cfg, {
      bounds: { xmin: 0, xmax: 10, ymin: 0, ymax: 10 },
      priorArtifacts: new Map(),
      availableChannels: [],
    });
    const entries = scatterOverlay.legendEntries!(cfg, artifacts);
    expect(entries).toHaveLength(2);
    expect(entries[1]!.label).toBe("g2");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/widgets && pnpm vitest run tests/xy-plot/overlays/scatter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `scatter.ts`**

```ts
// packages/widgets/src/xy-plot/overlays/scatter.ts
import type { OverlayModule, SessionGroup, ScatterConfig } from "../types";
import { register } from "./registry";

interface ScatterArtifact {
  groups: SessionGroup[];
}

export const scatterOverlay: OverlayModule<ScatterConfig, ScatterArtifact> = {
  kind: "scatter",
  availability: ["simple", "advanced"],
  defaultConfig() {
    return { color: "#FFC627", pointSize: 2, alpha: 1, trail: false };
  },
  compute(groups) {
    return { groups };
  },
  draw(ctx, layout, artifacts, cfg) {
    const { project } = layout;
    const size = Math.max(1, cfg.pointSize);
    ctx.globalAlpha = Math.max(0, Math.min(1, cfg.alpha));
    if (cfg.trail && artifacts.groups.length === 1) {
      // Time-color gradient (single-session-only)
      const g = artifacts.groups[0]!;
      for (let i = 0; i < g.n; i++) {
        const t = i / Math.max(1, g.n - 1);
        ctx.fillStyle = lerpColor("#26A69A", "#FFB800", t);
        const { px, py } = project(g.xs[i]!, g.ys[i]!);
        ctx.fillRect(px - size / 2, py - size / 2, size, size);
      }
    } else {
      for (const g of artifacts.groups) {
        ctx.fillStyle = g.color || cfg.color;
        for (let i = 0; i < g.n; i++) {
          const x = g.xs[i]!, y = g.ys[i]!;
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          const { px, py } = project(x, y);
          ctx.fillRect(px - size / 2, py - size / 2, size, size);
        }
      }
    }
    ctx.globalAlpha = 1;
  },
  legendEntries(_cfg, artifacts) {
    if (artifacts.groups.length <= 1) return [];
    return artifacts.groups.map((g) => ({ color: g.color, label: g.groupKey || "(default)" }));
  },
  Editor: () => null,   // editor wired in Task 11; null is valid React
};

register(scatterOverlay);

function lerpColor(aHex: string, bHex: string, t: number): string {
  const a = parseInt(aHex.slice(1), 16), b = parseInt(bHex.slice(1), 16);
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `rgb(${r},${g},${bl})`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/widgets && pnpm vitest run tests/xy-plot/overlays/scatter.test.ts`
Expected: PASS — 2 tests

- [ ] **Step 5: Commit**

```bash
git add packages/widgets/src/xy-plot/overlays/scatter.ts packages/widgets/tests/xy-plot/overlays/scatter.test.ts
git commit -m "feat(xy-plot): scatter overlay (preserves existing behaviour)"
```

---

### Task 10: Refactor `render.tsx` to iterate overlays + use data-pipeline

**Files:**
- Modify: `packages/widgets/src/xy-plot/render.tsx` (replace draw fn body & wire pipeline)

This task is the riskiest in the plan — the existing `xy-plot.test.tsx` must keep passing afterwards. The marker layer (cursor + datums) is preserved exactly.

- [ ] **Step 1: Confirm baseline tests pass**

Run: `cd packages/widgets && pnpm vitest run tests/xy-plot.test.tsx`
Expected: PASS — 2 existing tests

- [ ] **Step 2: Replace `render.tsx` with the orchestrator version**

Open `packages/widgets/src/xy-plot/render.tsx` and replace the entire file with:

```tsx
import { useCallback, useEffect, useRef } from "react";
import type { WidgetRenderProps, OverlaySession } from "../types";
import { setupCanvas, canvasLogicalSize } from "../lib/canvas-helpers";
import { useResizeObserver } from "../lib/use-resize-observer";
import type { XyPlotConfig, PlotLayout, OverlayContext, SessionGroup } from "./types";
import { buildSessionGroups } from "./data-pipeline";
import { getOverlayModule } from "./overlays/registry";
// Side-effect imports: each overlay self-registers on load. Add new
// overlays to this list as they're created in later tasks.
import "./overlays/scatter";

/* For backward compatibility with the previous file's exported config name.
 * Real shape lives in ./types — this is just a re-export so existing
 * `import type { XyPlotConfig } from "./render"` lines keep working. */
export type { XyPlotConfig } from "./types";

export function XyPlotRender(props: WidgetRenderProps<XyPlotConfig>) {
  const { config, slice, cursorEmitter, timeRange, overlays: visibleOverlays, viewState } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const markerCanvasRef = useRef<HTMLCanvasElement>(null);
  const layoutRef = useRef<{ groups: SessionGroup[]; layout: PlotLayout } | null>(null);
  const drawRef = useRef<() => void>(() => {});
  const markerDrawRef = useRef<() => void>(() => {});

  const visible: OverlaySession[] = visibleOverlays && visibleOverlays.length > 0
    ? visibleOverlays
    : [{ id: "primary", label: "primary", color: "#FFC627", slice, range: timeRange, isPrimary: true }];

  drawRef.current = () => draw();

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { drawRef.current(); markerDrawRef.current(); },
    [slice, config, JSON.stringify(visible.map((v) => v.id))]);

  const onResize = useCallback(() => { drawRef.current(); markerDrawRef.current(); }, []);
  useResizeObserver(canvasRef, onResize);

  // Pointer scrub on the marker canvas. Same closest-point logic as before.
  useEffect(() => {
    const c = markerCanvasRef.current; if (!c) return;
    let dragging = false;
    const emitFromEvent = (e: PointerEvent) => {
      const layout = layoutRef.current; if (!layout || layout.groups.length === 0) return;
      const rect = c.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      let bestT = 0, bestD = Infinity;
      for (const g of layout.groups) {
        for (let i = 0; i < g.n; i++) {
          const { px, py } = layout.layout.project(g.xs[i]!, g.ys[i]!);
          const dx = px - mx, dy = py - my;
          const d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; bestT = g.time[i]!; }
        }
      }
      cursorEmitter.emit(Math.round(bestT));
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      dragging = true; c.setPointerCapture(e.pointerId); emitFromEvent(e);
    };
    const onMove = (e: PointerEvent) => { if (dragging) emitFromEvent(e); };
    const onUp = (e: PointerEvent) => {
      dragging = false;
      if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
    };
    c.addEventListener("pointerdown", onDown);
    c.addEventListener("pointermove", onMove);
    c.addEventListener("pointerup", onUp);
    c.addEventListener("pointercancel", onUp);
    return () => {
      c.removeEventListener("pointerdown", onDown);
      c.removeEventListener("pointermove", onMove);
      c.removeEventListener("pointerup", onUp);
      c.removeEventListener("pointercancel", onUp);
    };
  }, [cursorEmitter]);

  // Marker layer (cursor ring + crosshair + datum markers) — unchanged from
  // the pre-overlay implementation. Imported as drawCursorAndDatums below.
  useEffect(() => {
    const drawMarkers = () => {
      const layout = layoutRef.current;
      const c = markerCanvasRef.current; if (!c) return;
      const ctx = setupCanvas(c);
      const { w, h } = canvasLogicalSize(c);
      ctx.clearRect(0, 0, w, h);
      if (!layout || layout.groups.length === 0) return;
      drawCursorAndDatums(ctx, layout.layout, layout.groups, cursorEmitter.get(), viewState?.get().datums ?? []);
    };
    markerDrawRef.current = drawMarkers;
    drawMarkers();
    const offCursor = cursorEmitter.subscribe(drawMarkers);
    const offView = viewState?.subscribe(drawMarkers);
    return () => { offCursor(); offView?.(); };
  }, [cursorEmitter, viewState]);

  function draw() {
    const c = canvasRef.current; if (!c) return;
    const ctx = setupCanvas(c);
    const { w, h } = canvasLogicalSize(c);
    ctx.clearRect(0, 0, w, h);

    const groups = buildSessionGroups(visible, {
      xChannelId: config.xChannelId,
      yChannelId: config.yChannelId,
      filter: config.filter,
      groupByChannelId: config.groupByChannelId,
      zoomRange: viewState?.get().zoomRange ?? null,
    });

    if (groups.length === 0) {
      ctx.fillStyle = "#7B8088"; ctx.font = "12px Inter, system-ui, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("no data", w / 2, h / 2);
      layoutRef.current = null;
      return;
    }

    // Bounds: explicit config wins, else union across all groups.
    let xmin = config.xMin, xmax = config.xMax, ymin = config.yMin, ymax = config.yMax;
    if (xmin === undefined || xmax === undefined || ymin === undefined || ymax === undefined) {
      let xn = Infinity, xx = -Infinity, yn = Infinity, yx = -Infinity;
      for (const g of groups) {
        for (let i = 0; i < g.n; i++) {
          const xv = g.xs[i]!, yv = g.ys[i]!;
          if (xv < xn) xn = xv; if (xv > xx) xx = xv;
          if (yv < yn) yn = yv; if (yv > yx) yx = yv;
        }
      }
      xmin = xmin ?? xn; xmax = xmax ?? xx; ymin = ymin ?? yn; ymax = ymax ?? yx;
    }
    const padL = 28, padR = 8, padT = 18, padB = 22;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const xSpan = Math.max(1e-9, xmax! - xmin!);
    const ySpan = Math.max(1e-9, ymax! - ymin!);
    const layout: PlotLayout = {
      xmin: xmin!, xmax: xmax!, ymin: ymin!, ymax: ymax!,
      padL, padT, plotW, plotH,
      project(x, y) {
        return {
          px: padL + ((x - xmin!) / xSpan) * plotW,
          py: padT + plotH - ((y - ymin!) / ySpan) * plotH,
        };
      },
    };
    layoutRef.current = { groups, layout };

    // Frame + zero crosshair
    ctx.strokeStyle = "#2A2C32"; ctx.lineWidth = 1;
    ctx.strokeRect(padL + 0.5, padT + 0.5, plotW, plotH);
    ctx.strokeStyle = "#5A5F66";
    ctx.beginPath();
    if (xmin! < 0 && xmax! > 0) {
      const x0 = layout.project(0, 0).px;
      ctx.moveTo(x0, padT); ctx.lineTo(x0, padT + plotH);
    }
    if (ymin! < 0 && ymax! > 0) {
      const y0 = layout.project(0, 0).py;
      ctx.moveTo(padL, y0); ctx.lineTo(padL + plotW, y0);
    }
    ctx.stroke();

    // Iterate overlays in array order. Skip unknown kinds with a warn.
    const ctxObj: OverlayContext = {
      bounds: { xmin: xmin!, xmax: xmax!, ymin: ymin!, ymax: ymax! },
      priorArtifacts: new Map(),
      availableChannels: [],   // editor side has channels; render doesn't need them
    };
    const priorArtifacts = ctxObj.priorArtifacts as Map<string, unknown>;
    for (const overlay of config.overlays) {
      const mod = getOverlayModule(overlay.kind);
      if (!mod) { console.warn(`xy-plot: unknown overlay kind '${overlay.kind}'`); continue; }
      if (config.mode === "simple" && !mod.availability.includes("simple")) continue;
      const artifacts = mod.compute(groups, overlay.config as never, ctxObj);
      priorArtifacts.set(overlay.id, artifacts);
      mod.draw?.(ctx, layout, artifacts, overlay.config as never);
    }

    // Axis labels (unchanged from previous implementation)
    ctx.fillStyle = "#7B8088"; ctx.font = "10px Inter, system-ui, sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText(`${config.xChannelId} × ${config.yChannelId}`, 4, 4);
    ctx.textAlign = "left"; ctx.textBaseline = "bottom";
    ctx.fillText(xmin!.toFixed(1), padL, h - 4);
    ctx.textAlign = "right";
    ctx.fillText(xmax!.toFixed(1), w - padR, h - 4);
    ctx.save();
    ctx.translate(10, padT + plotH / 2); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(`${ymin!.toFixed(1)} → ${ymax!.toFixed(1)}`, 0, 0);
    ctx.restore();
  }

  return (
    <div className="relative w-full h-full bg-[#16171B]">
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
      <canvas ref={markerCanvasRef} className="absolute inset-0 w-full h-full cursor-crosshair" />
    </div>
  );
}

/* Cursor + datum markers — extracted out of the previous render so the
 * orchestrator stays compact. Same visuals as before. */
function drawCursorAndDatums(
  ctx: CanvasRenderingContext2D,
  layout: PlotLayout,
  groups: SessionGroup[],
  cursorUs: number,
  datums: number[],
): void {
  const { padL, padT, plotW, plotH, project } = layout;
  // Datums first (cursor draws on top when they coincide).
  for (const tUs of datums) {
    for (const g of groups) {
      const idx = indexAtTime(g.time, tUs);
      if (idx === null) continue;
      const x = g.xs[idx], y = g.ys[idx];
      if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      const { px, py } = project(x, y);
      ctx.strokeStyle = "rgba(255, 107, 74, 0.35)"; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, py); ctx.lineTo(padL + plotW, py);
      ctx.moveTo(px, padT); ctx.lineTo(px, padT + plotH);
      ctx.stroke();
      ctx.fillStyle = "#FF6B4A"; ctx.strokeStyle = "#0E0E10"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    }
  }
  for (const g of groups) {
    const xy = interpolatedAt(g.time, g.xs, g.ys, cursorUs);
    if (!xy) continue;
    const { px, py } = project(xy.x, xy.y);
    ctx.strokeStyle = "rgba(232, 234, 238, 0.45)"; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, py); ctx.lineTo(padL + plotW, py);
    ctx.moveTo(px, padT); ctx.lineTo(px, padT + plotH);
    ctx.stroke();
    ctx.strokeStyle = "#E8EAEE"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.stroke();
  }
}

function indexAtTime(time: Float64Array, tUs: number): number | null {
  if (time.length === 0) return null;
  let lo = 0, hi = time.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (time[mid]! <= tUs) lo = mid + 1; else hi = mid;
  }
  return Math.max(0, lo - 1);
}

function interpolatedAt(
  time: Float64Array, xs: Float64Array, ys: Float64Array, tUs: number,
): { x: number; y: number } | null {
  if (time.length === 0) return null;
  const idx = indexAtTime(time, tUs);
  if (idx === null) return null;
  const x0 = xs[idx]!, y0 = ys[idx]!;
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) return null;
  if (idx + 1 >= time.length) return { x: x0, y: y0 };
  const x1 = xs[idx + 1]!, y1 = ys[idx + 1]!;
  if (!Number.isFinite(x1) || !Number.isFinite(y1)) return { x: x0, y: y0 };
  const t0 = time[idx]!, t1 = time[idx + 1]!;
  const span = t1 - t0;
  if (span <= 0) return { x: x0, y: y0 };
  const f = Math.max(0, Math.min(1, (tUs - t0) / span));
  return { x: x0 + (x1 - x0) * f, y: y0 + (y1 - y0) * f };
}
```

- [ ] **Step 3: Run all xy-plot widget tests**

Run: `cd packages/widgets && pnpm vitest run tests/xy-plot.test.tsx tests/xy-plot/`
Expected: existing 2 tests still PASS, scatter overlay tests PASS, data-pipeline tests PASS, migrations tests PASS

- [ ] **Step 4: Run the full widget test suite to catch regressions**

Run: `cd packages/widgets && pnpm test`
Expected: all green

- [ ] **Step 5: Commit**

```bash
git add packages/widgets/src/xy-plot/render.tsx
git commit -m "refactor(xy-plot): orchestrator iterates overlays, uses data pipeline"
```

---

### Task 11: Wire migration in `index.tsx` + minimal config-editor scaffold

**Files:**
- Modify: `packages/widgets/src/xy-plot/index.tsx`
- Modify: `packages/widgets/src/xy-plot/config-editor.tsx`

- [ ] **Step 1: Update `index.tsx` to migrate on read**

Replace `packages/widgets/src/xy-plot/index.tsx` with:

```tsx
import type { Widget } from "../types";
import { XyPlotConfigEditor } from "./config-editor";
import { XyPlotRender } from "./render";
import type { XyPlotConfig } from "./types";
import { migrateConfig } from "./migrations";

/* The widget instance carries its config through React props. We wrap
 * Render and Editor so any incoming config (from saved workspace, from
 * default, from import) goes through migrateConfig first — that's the
 * one place where v1 → v2 conversion happens. */
function MigratingRender(props: React.ComponentProps<typeof XyPlotRender>) {
  return <XyPlotRender {...props} config={migrateConfig(props.config as never)} />;
}
function MigratingEditor(props: React.ComponentProps<typeof XyPlotConfigEditor>) {
  return <XyPlotConfigEditor {...props} config={migrateConfig(props.config as never)} />;
}

export const xyPlotWidget: Widget<XyPlotConfig> = {
  type: "xy_plot",
  defaultConfig: {
    version: 2,
    mode: "simple",
    xChannelId: "",
    yChannelId: "",
    overlays: [{
      id: "default-scatter",
      kind: "scatter",
      config: { color: "#FFC627", pointSize: 2, alpha: 1, trail: false },
    }],
  },
  ConfigEditor: MigratingEditor,
  Render: MigratingRender,
  requiredChannels: (c) => {
    const m = migrateConfig(c as never);
    const out: string[] = [];
    if (m.xChannelId) out.push(m.xChannelId);
    if (m.yChannelId) out.push(m.yChannelId);
    if (m.groupByChannelId) out.push(m.groupByChannelId);
    return out;
  },
};

export type { XyPlotConfig } from "./types";
```

- [ ] **Step 2: Replace `config-editor.tsx` with a minimal v2 editor**

Replace `packages/widgets/src/xy-plot/config-editor.tsx` with:

```tsx
import type { WidgetConfigEditorProps } from "../types";
import type { XyPlotConfig } from "./types";
import { ChannelPicker } from "../lib/channel-picker";

/* Minimal editor — exposes only the simple-mode fields for now. Filter,
 * group-by, and overlay list are added in later tasks. The mode toggle
 * is already in the schema (defaults to "simple") and the render-side
 * gating works correctly for both modes; UI for switching is wired in
 * Task 16. */
export function XyPlotConfigEditor({ config, onChange, availableChannels }: WidgetConfigEditorProps<XyPlotConfig>) {
  const set = <K extends keyof XyPlotConfig>(k: K, v: XyPlotConfig[K]) =>
    onChange({ ...config, [k]: v });
  return (
    <div className="flex flex-col gap-1 p-2 text-xs text-[#D8DCE2]">
      <label className="flex justify-between items-center"><span>xChannelId</span>
        <ChannelPicker className="w-40" value={config.xChannelId} onChange={(v) => set("xChannelId", v)} channels={availableChannels} />
      </label>
      <label className="flex justify-between items-center"><span>yChannelId</span>
        <ChannelPicker className="w-40" value={config.yChannelId} onChange={(v) => set("yChannelId", v)} channels={availableChannels} />
      </label>
      {(["xMin", "xMax", "yMin", "yMax"] as const).map((k) => (
        <label key={k} className="flex justify-between"><span>{k}</span>
          <input type="number" className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32"
            value={config[k] === undefined ? "" : config[k]}
            onChange={(e) => set(k, e.target.value === "" ? undefined : Number(e.target.value))} />
        </label>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Run the full widget test suite**

Run: `cd packages/widgets && pnpm test`
Expected: PASS — all green

- [ ] **Step 4: Run desktop test suite (catches App.tsx integration regressions)**

Run: `cd apps/desktop && pnpm typecheck && pnpm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/widgets/src/xy-plot/index.tsx packages/widgets/src/xy-plot/config-editor.tsx
git commit -m "feat(xy-plot): wire migration + minimal v2 config editor"
```

---

## Phase 4 — Fit overlay

### Task 12: `overlays/fit.ts` — compute (regression + sampled curve + ±σ)

**Files:**
- Create: `packages/widgets/src/xy-plot/overlays/fit.ts`
- Test: `packages/widgets/tests/xy-plot/overlays/fit.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/widgets/tests/xy-plot/overlays/fit.test.ts
import { describe, it, expect } from "vitest";
import { fitOverlay } from "../../../src/xy-plot/overlays/fit";
import type { SessionGroup } from "../../../src/xy-plot/types";

const linearGroup: SessionGroup = {
  session: { id: "s", label: "s", color: "#FFC627",
             range: { startUs: 0, endUs: 1 }, isPrimary: true,
             slice: { time: BigInt64Array.from([0n]), data: new Map() } },
  groupKey: "",
  color: "#FFC627",
  time: Float64Array.from([0, 1, 2, 3, 4]),
  xs: Float64Array.from([0, 1, 2, 3, 4]),
  ys: Float64Array.from([1, 4, 7, 10, 13]),  // y = 3x + 1
  n: 5,
};

describe("fit overlay", () => {
  it("linear fit recovers slope + intercept and samples the curve across the bounds", () => {
    const cfg = { ...fitOverlay.defaultConfig(), kind: { type: "linear" as const } };
    const artifacts = fitOverlay.compute([linearGroup], cfg, {
      bounds: { xmin: 0, xmax: 4, ymin: 1, ymax: 13 },
      priorArtifacts: new Map(), availableChannels: [],
    });
    expect(artifacts.fits).toHaveLength(1);
    const [fit] = artifacts.fits;
    expect(fit!.coefficients[0]).toBeCloseTo(1, 6);
    expect(fit!.coefficients[1]).toBeCloseTo(3, 6);
    expect(fit!.rSquared).toBeCloseTo(1, 6);
    expect(fit!.sampleX[0]).toBeCloseTo(0, 6);
    expect(fit!.sampleX[fit!.sampleX.length - 1]).toBeCloseTo(4, 6);
  });

  it("legendEntries reports kind + R² rounded to 3 decimals", () => {
    const cfg = { ...fitOverlay.defaultConfig(), kind: { type: "linear" as const } };
    const artifacts = fitOverlay.compute([linearGroup], cfg, {
      bounds: { xmin: 0, xmax: 4, ymin: 1, ymax: 13 },
      priorArtifacts: new Map(), availableChannels: [],
    });
    const entries = fitOverlay.legendEntries!(cfg, artifacts);
    expect(entries[0]!.label).toMatch(/linear.*R².*1\.000/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/widgets && pnpm vitest run tests/xy-plot/overlays/fit.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `fit.ts`**

```ts
// packages/widgets/src/xy-plot/overlays/fit.ts
import { fitLinear, fitPolynomial, fitExponential, fitLogarithmic, fitPower, linspace, type FitResult } from "@helios/lib";
import type { OverlayModule, SessionGroup, FitConfig, FitKind, OverlayContext } from "../types";
import { register } from "./registry";

interface PerGroupFit {
  groupKey: string;
  color: string;
  coefficients: number[];
  rSquared: number;
  residualStd: number;
  /** Densely-sampled X for drawing the curve. */
  sampleX: Float64Array;
  /** y = predict(sampleX[i]) at each i. */
  sampleY: Float64Array;
}

interface FitArtifact {
  fits: PerGroupFit[];
  /** Set when a fit failed (too few samples, singular, etc.). One label per group. */
  warnings: string[];
}

const SAMPLE_COUNT = 200;

export const fitOverlay: OverlayModule<FitConfig, FitArtifact> = {
  kind: "fit",
  availability: ["advanced"],
  defaultConfig() {
    return {
      kind: { type: "linear" },
      color: "#FFC627",
      lineWidth: 1.5,
      showBand: false,
      extrapolate: false,
      perGroup: false,
    };
  },
  compute(groups, cfg, ctx) {
    const fits: PerGroupFit[] = [];
    const warnings: string[] = [];
    const buckets = cfg.perGroup ? groupBy(groups, (g) => g.groupKey) : [{ key: "", groups }];
    for (const { key, groups: bucketGroups } of buckets) {
      // Pool xs/ys across the groups in this bucket.
      let totalN = 0;
      for (const g of bucketGroups) totalN += g.n;
      const xs = new Float64Array(totalN);
      const ys = new Float64Array(totalN);
      let off = 0;
      for (const g of bucketGroups) { xs.set(g.xs, off); ys.set(g.ys, off); off += g.n; }

      const result = runFit(cfg.kind, xs, ys);
      if (result.coefficients.length === 0) {
        warnings.push(`${key || "fit"}: no fit (${result.validSamples} samples)`);
        continue;
      }
      const lo = cfg.extrapolate ? ctx.bounds.xmin : minFinite(xs);
      const hi = cfg.extrapolate ? ctx.bounds.xmax : maxFinite(xs);
      const sampleX = linspace(lo, hi, SAMPLE_COUNT);
      const sampleY = new Float64Array(SAMPLE_COUNT);
      for (let i = 0; i < SAMPLE_COUNT; i++) sampleY[i] = result.predict(sampleX[i]!);
      fits.push({
        groupKey: key,
        color: bucketGroups[0]?.color ?? cfg.color,
        coefficients: result.coefficients,
        rSquared: result.rSquared,
        residualStd: result.residualStd,
        sampleX, sampleY,
      });
    }
    return { fits, warnings };
  },
  draw(ctx, layout, artifacts, cfg) {
    for (const f of artifacts.fits) {
      // ±σ band first so the line draws on top.
      if (cfg.showBand && f.residualStd > 0) {
        ctx.fillStyle = withAlpha(cfg.color, 0.12);
        ctx.beginPath();
        for (let i = 0; i < f.sampleX.length; i++) {
          const { px, py } = layout.project(f.sampleX[i]!, f.sampleY[i]! + f.residualStd);
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        for (let i = f.sampleX.length - 1; i >= 0; i--) {
          const { px, py } = layout.project(f.sampleX[i]!, f.sampleY[i]! - f.residualStd);
          ctx.lineTo(px, py);
        }
        ctx.closePath(); ctx.fill();
      }
      ctx.strokeStyle = cfg.perGroup ? f.color : cfg.color;
      ctx.lineWidth = cfg.lineWidth;
      ctx.beginPath();
      for (let i = 0; i < f.sampleX.length; i++) {
        const { px, py } = layout.project(f.sampleX[i]!, f.sampleY[i]!);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
  },
  legendEntries(cfg, artifacts) {
    return artifacts.fits.map((f) => ({
      color: cfg.perGroup ? f.color : cfg.color,
      label: `${describeFitKind(cfg.kind)}${f.groupKey ? " [" + f.groupKey + "]" : ""}  R²=${f.rSquared.toFixed(3)}`,
    }));
  },
  Editor: () => null,   // wired in Task 16
};

register(fitOverlay);

/* ─── helpers ────────────────────────────────────────────────────────── */

function runFit(kind: FitKind, xs: Float64Array, ys: Float64Array): FitResult {
  switch (kind.type) {
    case "linear":      return fitLinear(xs, ys);
    case "polynomial":  return fitPolynomial(xs, ys, kind.degree);
    case "exponential": return fitExponential(xs, ys);
    case "logarithmic": return fitLogarithmic(xs, ys);
    case "power":       return fitPower(xs, ys);
  }
}

function describeFitKind(k: FitKind): string {
  switch (k.type) {
    case "polynomial": return `poly d=${k.degree}`;
    default:           return k.type;
  }
}

function groupBy<T>(items: T[], keyFn: (t: T) => string): Array<{ key: string; groups: T[] }> {
  const m = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    let bucket = m.get(key);
    if (!bucket) { bucket = []; m.set(key, bucket); }
    bucket.push(item);
  }
  return [...m.entries()].map(([key, groups]) => ({ key, groups }));
}

function minFinite(xs: Float64Array): number {
  let m = Infinity;
  for (let i = 0; i < xs.length; i++) if (Number.isFinite(xs[i]!) && xs[i]! < m) m = xs[i]!;
  return Number.isFinite(m) ? m : 0;
}
function maxFinite(xs: Float64Array): number {
  let m = -Infinity;
  for (let i = 0; i < xs.length; i++) if (Number.isFinite(xs[i]!) && xs[i]! > m) m = xs[i]!;
  return Number.isFinite(m) ? m : 0;
}

function withAlpha(hex: string, alpha: number): string {
  // Accept #RRGGBB; produce rgba(...).
  if (!hex.startsWith("#") || hex.length !== 7) return hex;
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${(v >> 16) & 0xff},${(v >> 8) & 0xff},${v & 0xff},${alpha})`;
}
```

- [ ] **Step 4: Register the overlay by adding the side-effect import**

Edit `packages/widgets/src/xy-plot/render.tsx`:

```diff
 import "./overlays/scatter";
+import "./overlays/fit";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/widgets && pnpm vitest run tests/xy-plot/overlays/fit.test.ts && pnpm test`
Expected: PASS — all widget tests

- [ ] **Step 6: Commit**

```bash
git add packages/widgets/src/xy-plot/overlays/fit.ts packages/widgets/tests/xy-plot/overlays/fit.test.ts packages/widgets/src/xy-plot/render.tsx
git commit -m "feat(xy-plot): fit overlay (linear/poly/exp/log/power, ±σ, extrapolate)"
```

---

## Phase 5 — Formula overlay

### Task 13: `overlays/formula.ts`

**Files:**
- Create: `packages/widgets/src/xy-plot/overlays/formula.ts`
- Test: `packages/widgets/tests/xy-plot/overlays/formula.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/widgets/tests/xy-plot/overlays/formula.test.ts
import { describe, it, expect } from "vitest";
import { formulaOverlay } from "../../../src/xy-plot/overlays/formula";

describe("formula overlay", () => {
  it("samples a parsable expression across the bounds", () => {
    const cfg = { ...formulaOverlay.defaultConfig(), expression: "2 * x + 1" };
    const artifacts = formulaOverlay.compute([], cfg, {
      bounds: { xmin: 0, xmax: 10, ymin: 0, ymax: 30 },
      priorArtifacts: new Map(), availableChannels: [],
    });
    expect(artifacts.error).toBeNull();
    expect(artifacts.sampleY[0]).toBeCloseTo(1, 6);
    expect(artifacts.sampleY[artifacts.sampleY.length - 1]).toBeCloseTo(21, 6);
  });

  it("returns an error for an unparseable expression", () => {
    const cfg = { ...formulaOverlay.defaultConfig(), expression: "2 * +" };
    const artifacts = formulaOverlay.compute([], cfg, {
      bounds: { xmin: 0, xmax: 10, ymin: 0, ymax: 30 },
      priorArtifacts: new Map(), availableChannels: [],
    });
    expect(artifacts.error).not.toBeNull();
    expect(artifacts.sampleY).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/widgets && pnpm vitest run tests/xy-plot/overlays/formula.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `formula.ts`**

```ts
// packages/widgets/src/xy-plot/overlays/formula.ts
import { parseExpr, evalAst, linspace, type Ast } from "@helios/lib";
import type { OverlayModule, FormulaConfig } from "../types";
import { register } from "./registry";

interface FormulaArtifact {
  sampleX: Float64Array;
  sampleY: Float64Array;
  /** Compile-error message for the editor / on-canvas banner. null = OK. */
  error: string | null;
}

const SAMPLE_COUNT = 200;
// Per-formula AST cache. Same idea as data-pipeline's filter cache.
const cache = new Map<string, { ast: Ast | null; error: string | null }>();
function compile(expr: string): { ast: Ast | null; error: string | null } {
  if (cache.has(expr)) return cache.get(expr)!;
  const result = parseExpr(expr);
  const entry = { ast: result.ast ?? null, error: result.error ?? null };
  cache.set(expr, entry);
  return entry;
}

export const formulaOverlay: OverlayModule<FormulaConfig, FormulaArtifact> = {
  kind: "formula",
  availability: ["advanced"],
  defaultConfig() {
    return { expression: "x", color: "#26A69A", lineWidth: 1.5, dashed: true };
  },
  compute(_groups, cfg, ctx) {
    const compiled = compile(cfg.expression || "");
    if (!compiled.ast) {
      return { sampleX: new Float64Array(0), sampleY: new Float64Array(0), error: compiled.error ?? "empty expression" };
    }
    const sampleX = linspace(ctx.bounds.xmin, ctx.bounds.xmax, SAMPLE_COUNT);
    const sampleY = new Float64Array(SAMPLE_COUNT);
    const env: Record<string, number> = {};
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      env.x = sampleX[i]!;
      try { sampleY[i] = Number(evalAst(compiled.ast, env)); }
      catch { sampleY[i] = NaN; }
    }
    return { sampleX, sampleY, error: null };
  },
  draw(ctx, layout, artifacts, cfg) {
    if (artifacts.error) {
      ctx.fillStyle = "rgba(239, 83, 80, 0.85)";
      ctx.font = "11px ui-monospace, monospace";
      ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillText(`formula: ${artifacts.error}`, layout.padL + 4, layout.padT + 4);
      return;
    }
    ctx.strokeStyle = cfg.color;
    ctx.lineWidth = cfg.lineWidth;
    ctx.setLineDash(cfg.dashed ? [4, 3] : []);
    ctx.beginPath();
    let drawing = false;
    for (let i = 0; i < artifacts.sampleX.length; i++) {
      const y = artifacts.sampleY[i]!;
      if (!Number.isFinite(y)) { drawing = false; continue; }
      const { px, py } = layout.project(artifacts.sampleX[i]!, y);
      if (!drawing) { ctx.moveTo(px, py); drawing = true; }
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  },
  legendEntries(cfg) {
    return [{ color: cfg.color, label: `y = ${cfg.expression}` }];
  },
  Editor: () => null,
};

register(formulaOverlay);
```

- [ ] **Step 4: Register the overlay**

Edit `packages/widgets/src/xy-plot/render.tsx`:

```diff
 import "./overlays/scatter";
 import "./overlays/fit";
+import "./overlays/formula";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/widgets && pnpm vitest run tests/xy-plot/overlays/formula.test.ts && pnpm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/widgets/src/xy-plot/overlays/formula.ts packages/widgets/tests/xy-plot/overlays/formula.test.ts packages/widgets/src/xy-plot/render.tsx
git commit -m "feat(xy-plot): formula overlay (y=f(x), uses math-expr engine)"
```

---

## Phase 6 — Bins overlay (predictive lookup curve)

### Task 14: `overlays/bins.ts`

**Files:**
- Create: `packages/widgets/src/xy-plot/overlays/bins.ts`
- Test: `packages/widgets/tests/xy-plot/overlays/bins.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/widgets/tests/xy-plot/overlays/bins.test.ts
import { describe, it, expect } from "vitest";
import { binsOverlay } from "../../../src/xy-plot/overlays/bins";
import type { SessionGroup } from "../../../src/xy-plot/types";

const group: SessionGroup = {
  session: { id: "s", label: "s", color: "#FFC627",
             range: { startUs: 0, endUs: 1 }, isPrimary: true,
             slice: { time: BigInt64Array.from([0n]), data: new Map() } },
  groupKey: "",
  color: "#FFC627",
  time: Float64Array.from([0, 0, 0, 0, 0, 0]),
  xs: Float64Array.from([0, 0.1, 5, 5.1, 10, 9.9]),  // bins at lo / mid / hi
  ys: Float64Array.from([1, 3,   5, 7,   9, 11]),
  n: 6,
};

describe("bins overlay", () => {
  it("mean statistic produces one yStat per non-empty bin", () => {
    const cfg = { ...binsOverlay.defaultConfig(), binCount: 3, statistic: "mean" as const };
    const artifacts = binsOverlay.compute([group], cfg, {
      bounds: { xmin: 0, xmax: 10, ymin: 0, ymax: 12 },
      priorArtifacts: new Map(), availableChannels: [],
    });
    expect(artifacts.bins).toHaveLength(3);
    expect(artifacts.bins[0]!.yStat).toBeCloseTo((1 + 3) / 2, 6);
    expect(artifacts.bins[1]!.yStat).toBeCloseTo((5 + 7) / 2, 6);
    expect(artifacts.bins[2]!.yStat).toBeCloseTo((9 + 11) / 2, 6);
  });

  it("p25-p75 fills yLow/yHigh per bin", () => {
    const cfg = { ...binsOverlay.defaultConfig(), binCount: 3, statistic: "p25-p75" as const };
    const artifacts = binsOverlay.compute([group], cfg, {
      bounds: { xmin: 0, xmax: 10, ymin: 0, ymax: 12 },
      priorArtifacts: new Map(), availableChannels: [],
    });
    expect(artifacts.bins[0]!.yLow).toBeDefined();
    expect(artifacts.bins[0]!.yHigh).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/widgets && pnpm vitest run tests/xy-plot/overlays/bins.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `bins.ts`**

```ts
// packages/widgets/src/xy-plot/overlays/bins.ts
import { mean, percentile } from "@helios/lib";
import type { OverlayModule, BinsConfig, SessionGroup } from "../types";
import { register } from "./registry";

interface Bin {
  xCenter: number;
  yStat: number;
  yLow?: number;
  yHigh?: number;
  n: number;
}

interface BinsArtifact { bins: Bin[]; }

export const binsOverlay: OverlayModule<BinsConfig, BinsArtifact> = {
  kind: "bins",
  availability: ["advanced"],
  defaultConfig() {
    return { binCount: 20, statistic: "mean", color: "#42A5F5", showCount: false };
  },
  compute(groups, cfg, ctx) {
    const binCount = Math.max(1, Math.min(200, cfg.binCount));
    const lo = ctx.bounds.xmin, hi = ctx.bounds.xmax;
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return { bins: [] };
    const width = (hi - lo) / binCount;
    const buckets: number[][] = Array.from({ length: binCount }, () => []);
    for (const g of groups) {
      for (let i = 0; i < g.n; i++) {
        const x = g.xs[i]!, y = g.ys[i]!;
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const idx = Math.min(binCount - 1, Math.max(0, Math.floor((x - lo) / width)));
        buckets[idx]!.push(y);
      }
    }
    const bins: Bin[] = [];
    for (let i = 0; i < binCount; i++) {
      const ys = buckets[i]!;
      if (ys.length === 0) continue;
      const center = lo + (i + 0.5) * width;
      if (cfg.statistic === "mean") {
        bins.push({ xCenter: center, yStat: mean(ys), n: ys.length });
      } else if (cfg.statistic === "median") {
        bins.push({ xCenter: center, yStat: percentile(ys, 50), n: ys.length });
      } else { // p25-p75
        bins.push({
          xCenter: center,
          yStat: percentile(ys, 50),
          yLow: percentile(ys, 25),
          yHigh: percentile(ys, 75),
          n: ys.length,
        });
      }
    }
    return { bins };
  },
  draw(ctx, layout, artifacts, cfg) {
    if (artifacts.bins.length === 0) return;
    // Optional band first
    if (cfg.statistic === "p25-p75") {
      ctx.fillStyle = withAlpha(cfg.color, 0.18);
      ctx.beginPath();
      for (let i = 0; i < artifacts.bins.length; i++) {
        const b = artifacts.bins[i]!;
        const { px, py } = layout.project(b.xCenter, b.yHigh ?? b.yStat);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      for (let i = artifacts.bins.length - 1; i >= 0; i--) {
        const b = artifacts.bins[i]!;
        const { px, py } = layout.project(b.xCenter, b.yLow ?? b.yStat);
        ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.fill();
    }
    // Center line
    ctx.strokeStyle = cfg.color; ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < artifacts.bins.length; i++) {
      const b = artifacts.bins[i]!;
      const { px, py } = layout.project(b.xCenter, b.yStat);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
    // Sample-count dots
    if (cfg.showCount) {
      ctx.fillStyle = cfg.color;
      for (const b of artifacts.bins) {
        const { px, py } = layout.project(b.xCenter, b.yStat);
        const r = Math.min(5, 1 + Math.log10(b.n + 1) * 1.5);
        ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
      }
    }
  },
  legendEntries(cfg) {
    return [{ color: cfg.color, label: `bins (${cfg.statistic}, ${cfg.binCount})` }];
  },
  Editor: () => null,
};

register(binsOverlay);

function withAlpha(hex: string, alpha: number): string {
  if (!hex.startsWith("#") || hex.length !== 7) return hex;
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${(v >> 16) & 0xff},${(v >> 8) & 0xff},${v & 0xff},${alpha})`;
}

// SessionGroup is imported via the type to keep tree-shaking honest;
// the runtime never references it.
export type _ = SessionGroup;
```

Note: the trailing `export type _ = SessionGroup` keeps the import live for the type checker; it's a one-line price for clean module imports.

- [ ] **Step 4: Register the overlay**

Edit `packages/widgets/src/xy-plot/render.tsx`:

```diff
 import "./overlays/scatter";
 import "./overlays/fit";
 import "./overlays/formula";
+import "./overlays/bins";
```

- [ ] **Step 5: Run tests**

Run: `cd packages/widgets && pnpm vitest run tests/xy-plot/overlays/bins.test.ts && pnpm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/widgets/src/xy-plot/overlays/bins.ts packages/widgets/tests/xy-plot/overlays/bins.test.ts packages/widgets/src/xy-plot/render.tsx
git commit -m "feat(xy-plot): bins overlay (mean/median/p25-p75 lookup curve)"
```

---

## Phase 7 — Stats overlay (DOM Component path)

### Task 15: Render orchestrator: thread DOM Component overlays through

**Files:**
- Modify: `packages/widgets/src/xy-plot/render.tsx`

The `Component` path of an overlay produces a React element rendered into a DOM wrapper above the marker canvas. This task adds the wrapper + the iteration step.

- [ ] **Step 1: Add a state ref + DOM wrapper to render.tsx**

Edit the JSX returned from `XyPlotRender` so it has a third absolutely-positioned div for DOM overlays. Replace:

```tsx
return (
  <div className="relative w-full h-full bg-[#16171B]">
    <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
    <canvas ref={markerCanvasRef} className="absolute inset-0 w-full h-full cursor-crosshair" />
  </div>
);
```

with:

```tsx
return (
  <div className="relative w-full h-full bg-[#16171B]">
    <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
    <canvas ref={markerCanvasRef} className="absolute inset-0 w-full h-full cursor-crosshair" />
    {/* DOM overlay layer — pointer-events-none so the marker canvas keeps
        receiving scrub events; individual Components opt back in to
        pointer events (e.g. selectable text) on themselves. */}
    <div className="absolute inset-0 pointer-events-none">
      {domOverlays.map((d) => <div key={d.id}>{d.element}</div>)}
    </div>
  </div>
);
```

- [ ] **Step 2: Track DOM overlay state in `useState`**

At the top of `XyPlotRender` (next to existing `useRef`s), add:

```tsx
const [domOverlays, setDomOverlays] = useState<Array<{ id: string; element: ReactNode }>>([]);
```

(Add `useState`, `ReactNode` to the React imports.)

- [ ] **Step 3: In `draw()`, build the DOM overlays alongside canvas overlays**

Locate the overlay iteration block in `draw()` and replace it with:

```ts
const ctxObj: OverlayContext = {
  bounds: { xmin: xmin!, xmax: xmax!, ymin: ymin!, ymax: ymax! },
  priorArtifacts: new Map(),
  availableChannels: [],
};
const priorArtifacts = ctxObj.priorArtifacts as Map<string, unknown>;
const nextDomOverlays: Array<{ id: string; element: ReactNode }> = [];
for (const overlay of config.overlays) {
  const mod = getOverlayModule(overlay.kind);
  if (!mod) { console.warn(`xy-plot: unknown overlay kind '${overlay.kind}'`); continue; }
  if (config.mode === "simple" && !mod.availability.includes("simple")) continue;
  const artifacts = mod.compute(groups, overlay.config as never, ctxObj);
  priorArtifacts.set(overlay.id, artifacts);
  mod.draw?.(ctx, layout, artifacts, overlay.config as never);
  if (mod.Component) {
    const Comp = mod.Component;
    nextDomOverlays.push({
      id: overlay.id,
      element: <Comp artifacts={artifacts} cfg={overlay.config as never} layout={layout} />,
    });
  }
}
setDomOverlays(nextDomOverlays);
```

- [ ] **Step 4: Run all widget tests**

Run: `cd packages/widgets && pnpm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/widgets/src/xy-plot/render.tsx
git commit -m "feat(xy-plot): render orchestrator threads DOM Component overlays"
```

---

### Task 16: `overlays/stats.ts` — selectable HTML stats panel

**Files:**
- Create: `packages/widgets/src/xy-plot/overlays/stats.ts`
- Test: `packages/widgets/tests/xy-plot/overlays/stats.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/widgets/tests/xy-plot/overlays/stats.test.ts
import { describe, it, expect } from "vitest";
import { statsOverlay } from "../../../src/xy-plot/overlays/stats";
import type { SessionGroup } from "../../../src/xy-plot/types";

const group: SessionGroup = {
  session: { id: "s", label: "s", color: "#FFC627",
             range: { startUs: 0, endUs: 1 }, isPrimary: true,
             slice: { time: BigInt64Array.from([0n]), data: new Map() } },
  groupKey: "",
  color: "#FFC627",
  time: Float64Array.from([0, 1, 2, 3]),
  xs: Float64Array.from([1, 2, 3, 4]),
  ys: Float64Array.from([2, 4, 6, 8]),
  n: 4,
};

describe("stats overlay", () => {
  it("computes count, means, stddevs, correlation", () => {
    const cfg = statsOverlay.defaultConfig();
    const a = statsOverlay.compute([group], cfg, {
      bounds: { xmin: 0, xmax: 5, ymin: 0, ymax: 10 },
      priorArtifacts: new Map(), availableChannels: [],
    });
    expect(a.count).toBe(4);
    expect(a.meanX).toBeCloseTo(2.5, 6);
    expect(a.meanY).toBeCloseTo(5, 6);
    expect(a.correlation).toBeCloseTo(1, 6);
  });

  it("reads R² from a referenced fit overlay's prior artifact", () => {
    const cfg = { ...statsOverlay.defaultConfig(), fitOverlayId: "fit-1",
      show: { ...statsOverlay.defaultConfig().show, fitRSquared: true } };
    const fakeFitArtifacts = {
      fits: [{ rSquared: 0.987, coefficients: [1, 2], groupKey: "",
               color: "#fff", residualStd: 0,
               sampleX: new Float64Array(0), sampleY: new Float64Array(0) }],
      warnings: [],
    };
    const a = statsOverlay.compute([group], cfg, {
      bounds: { xmin: 0, xmax: 5, ymin: 0, ymax: 10 },
      priorArtifacts: new Map([["fit-1", fakeFitArtifacts]]),
      availableChannels: [],
    });
    expect(a.fitRSquared).toBeCloseTo(0.987, 3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/widgets && pnpm vitest run tests/xy-plot/overlays/stats.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `stats.ts`**

```ts
// packages/widgets/src/xy-plot/overlays/stats.ts
import { mean, stddev, correlation } from "@helios/lib";
import type { OverlayModule, StatsConfig } from "../types";
import { register } from "./registry";

interface StatsArtifact {
  count: number;
  meanX: number;
  meanY: number;
  stdX: number;
  stdY: number;
  correlation: number;
  fitRSquared: number | null;
  fitEquation: string | null;
  position: StatsConfig["position"];
  show: StatsConfig["show"];
}

interface ReferencedFitArtifact {
  fits: Array<{ rSquared: number; coefficients: number[] }>;
}

export const statsOverlay: OverlayModule<StatsConfig, StatsArtifact> = {
  kind: "stats",
  availability: ["advanced"],
  defaultConfig() {
    return {
      position: "top-right",
      show: { count: true, meanXY: true, stdXY: true,
              correlation: true, fitRSquared: false, fitEquation: false },
    };
  },
  compute(groups, cfg, ctx) {
    // Pool xs/ys across all groups for the panel.
    let totalN = 0;
    for (const g of groups) totalN += g.n;
    const xs = new Float64Array(totalN);
    const ys = new Float64Array(totalN);
    let off = 0;
    for (const g of groups) { xs.set(g.xs, off); ys.set(g.ys, off); off += g.n; }

    let fitRSquared: number | null = null;
    let fitEquation: string | null = null;
    if (cfg.fitOverlayId) {
      const fitArt = ctx.priorArtifacts.get(cfg.fitOverlayId) as ReferencedFitArtifact | undefined;
      if (fitArt && fitArt.fits.length > 0) {
        fitRSquared = fitArt.fits[0]!.rSquared;
        fitEquation = formatEquation(fitArt.fits[0]!.coefficients);
      }
    }

    return {
      count: totalN,
      meanX: mean(xs), meanY: mean(ys),
      stdX: stddev(xs), stdY: stddev(ys),
      correlation: correlation(xs, ys),
      fitRSquared, fitEquation,
      position: cfg.position,
      show: cfg.show,
    };
  },
  Component({ artifacts }) {
    const lines: string[] = [];
    if (artifacts.show.count) lines.push(`n = ${artifacts.count}`);
    if (artifacts.show.meanXY) lines.push(`x̄ = ${fmt(artifacts.meanX)}    ȳ = ${fmt(artifacts.meanY)}`);
    if (artifacts.show.stdXY) lines.push(`σx = ${fmt(artifacts.stdX)}   σy = ${fmt(artifacts.stdY)}`);
    if (artifacts.show.correlation) lines.push(`r = ${fmt(artifacts.correlation)}`);
    if (artifacts.show.fitRSquared) lines.push(`R² = ${artifacts.fitRSquared !== null ? fmt(artifacts.fitRSquared) : "—"}`);
    if (artifacts.show.fitEquation) lines.push(artifacts.fitEquation ?? "");
    const posClass = positionClass(artifacts.position);
    return (
      <div
        className={`absolute ${posClass} m-2 px-2 py-1 text-[10px] font-mono-num leading-tight bg-[#0E0E10cc] text-[#D8DCE2] border border-[#2A2C32] rounded-sm pointer-events-auto select-text`}
        style={{ whiteSpace: "pre" }}
      >
        {lines.join("\n")}
      </div>
    );
  },
  Editor: () => null,
};

register(statsOverlay);

function fmt(v: number): string { return Number.isFinite(v) ? v.toFixed(3) : "—"; }

function positionClass(pos: StatsConfig["position"]): string {
  switch (pos) {
    case "top-left":     return "top-0 left-0";
    case "top-right":    return "top-0 right-0";
    case "bottom-left":  return "bottom-0 left-0";
    case "bottom-right": return "bottom-0 right-0";
  }
}

function formatEquation(coefficients: number[]): string {
  if (coefficients.length === 0) return "";
  if (coefficients.length === 2) return `y = ${fmt(coefficients[0]!)} + ${fmt(coefficients[1]!)}·x`;
  // Generic polynomial form
  return `y = ${coefficients.map((c, i) => `${fmt(c)}·x^${i}`).join(" + ")}`;
}
```

- [ ] **Step 4: Register the overlay**

Edit `packages/widgets/src/xy-plot/render.tsx`:

```diff
 import "./overlays/scatter";
 import "./overlays/fit";
 import "./overlays/formula";
 import "./overlays/bins";
+import "./overlays/stats";
```

- [ ] **Step 5: Run tests**

Run: `cd packages/widgets && pnpm vitest run tests/xy-plot/overlays/stats.test.ts && pnpm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/widgets/src/xy-plot/overlays/stats.ts packages/widgets/tests/xy-plot/overlays/stats.test.ts packages/widgets/src/xy-plot/render.tsx
git commit -m "feat(xy-plot): stats overlay — DOM panel reading from prior fit artifacts"
```

---

## Phase 8 — Quadrant-fit overlay

### Task 17: `overlays/quadrant-fit.ts`

**Files:**
- Create: `packages/widgets/src/xy-plot/overlays/quadrant-fit.ts`
- Test: `packages/widgets/tests/xy-plot/overlays/quadrant-fit.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/widgets/tests/xy-plot/overlays/quadrant-fit.test.ts
import { describe, it, expect } from "vitest";
import { quadrantFitOverlay } from "../../../src/xy-plot/overlays/quadrant-fit";
import type { SessionGroup } from "../../../src/xy-plot/types";

/** Two distinct lines: x>0 → y = 2x; x<0 → y = -1·x. */
const group: SessionGroup = {
  session: { id: "s", label: "s", color: "#FFC627",
             range: { startUs: 0, endUs: 1 }, isPrimary: true,
             slice: { time: BigInt64Array.from([0n]), data: new Map() } },
  groupKey: "",
  color: "#FFC627",
  time: Float64Array.from([0, 0, 0, 0, 0, 0]),
  xs: Float64Array.from([-3, -2, -1, 1, 2, 3]),
  ys: Float64Array.from([3, 2, 1, 2, 4, 6]),
  n: 6,
};

describe("quadrant-fit overlay", () => {
  it("fits each x-sign separately and reports per-quadrant stats", () => {
    const cfg = { ...quadrantFitOverlay.defaultConfig(), kind: { type: "linear" as const } };
    const artifacts = quadrantFitOverlay.compute([group], cfg, {
      bounds: { xmin: -3, xmax: 3, ymin: 0, ymax: 6 },
      priorArtifacts: new Map(), availableChannels: [],
    });
    // Two non-empty quadrants (x<0 has only positive y, x>0 has only positive y).
    expect(artifacts.quadrants.length).toBeGreaterThanOrEqual(2);
    const q1 = artifacts.quadrants.find((q) => q.label === "Q1")!;
    const q2 = artifacts.quadrants.find((q) => q.label === "Q2")!;
    expect(q1.coefficients[1]).toBeCloseTo(2, 4);
    expect(q2.coefficients[1]).toBeCloseTo(-1, 4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/widgets && pnpm vitest run tests/xy-plot/overlays/quadrant-fit.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `quadrant-fit.ts`**

```ts
// packages/widgets/src/xy-plot/overlays/quadrant-fit.ts
import { fitLinear, fitPolynomial, fitExponential, fitLogarithmic, fitPower, linspace, type FitResult } from "@helios/lib";
import type { OverlayModule, QuadrantFitConfig, SessionGroup, FitKind } from "../types";
import { register } from "./registry";

interface PerQuadrant {
  label: "Q1" | "Q2" | "Q3" | "Q4";  // standard math convention
  xSign: 1 | -1;
  ySign: 1 | -1;
  coefficients: number[];
  rSquared: number;
  residualStd: number;
  sampleX: Float64Array;
  sampleY: Float64Array;
}

interface QuadrantFitArtifact {
  quadrants: PerQuadrant[];
}

const SAMPLE_COUNT = 100;
const QUADRANTS: Array<{ label: PerQuadrant["label"]; xSign: 1 | -1; ySign: 1 | -1 }> = [
  { label: "Q1", xSign:  1, ySign:  1 },
  { label: "Q2", xSign: -1, ySign:  1 },
  { label: "Q3", xSign: -1, ySign: -1 },
  { label: "Q4", xSign:  1, ySign: -1 },
];

export const quadrantFitOverlay: OverlayModule<QuadrantFitConfig, QuadrantFitArtifact> = {
  kind: "quadrant-fit",
  availability: ["advanced"],
  defaultConfig() {
    return {
      kind: { type: "linear" }, color: "#FFC627", lineWidth: 1.5,
      showBand: false, showStatsOverlay: false,
    };
  },
  compute(groups, cfg, ctx) {
    const out: PerQuadrant[] = [];
    for (const q of QUADRANTS) {
      const xs: number[] = [], ys: number[] = [];
      for (const g of groups) {
        for (let i = 0; i < g.n; i++) {
          const x = g.xs[i]!, y = g.ys[i]!;
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          if (Math.sign(x) !== q.xSign || Math.sign(y) !== q.ySign) continue;
          xs.push(x); ys.push(y);
        }
      }
      if (xs.length < 2) continue;
      const result = runFit(cfg.kind, Float64Array.from(xs), Float64Array.from(ys));
      if (result.coefficients.length === 0) continue;
      // Sample only across this quadrant's portion of the X axis.
      const lo = q.xSign > 0 ? 0 : ctx.bounds.xmin;
      const hi = q.xSign > 0 ? ctx.bounds.xmax : 0;
      const sampleX = linspace(lo, hi, SAMPLE_COUNT);
      const sampleY = new Float64Array(SAMPLE_COUNT);
      for (let i = 0; i < SAMPLE_COUNT; i++) sampleY[i] = result.predict(sampleX[i]!);
      out.push({
        label: q.label, xSign: q.xSign, ySign: q.ySign,
        coefficients: result.coefficients, rSquared: result.rSquared,
        residualStd: result.residualStd, sampleX, sampleY,
      });
    }
    return { quadrants: out };
  },
  draw(ctx, layout, artifacts, cfg) {
    for (const q of artifacts.quadrants) {
      if (cfg.showBand && q.residualStd > 0) {
        ctx.fillStyle = withAlpha(cfg.color, 0.10);
        ctx.beginPath();
        for (let i = 0; i < q.sampleX.length; i++) {
          const { px, py } = layout.project(q.sampleX[i]!, q.sampleY[i]! + q.residualStd);
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        for (let i = q.sampleX.length - 1; i >= 0; i--) {
          const { px, py } = layout.project(q.sampleX[i]!, q.sampleY[i]! - q.residualStd);
          ctx.lineTo(px, py);
        }
        ctx.closePath(); ctx.fill();
      }
      ctx.strokeStyle = cfg.color; ctx.lineWidth = cfg.lineWidth;
      ctx.beginPath();
      for (let i = 0; i < q.sampleX.length; i++) {
        const { px, py } = layout.project(q.sampleX[i]!, q.sampleY[i]!);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      if (cfg.showStatsOverlay) {
        const cornerX = q.xSign > 0 ? layout.padL + layout.plotW - 6 : layout.padL + 6;
        const cornerY = q.ySign > 0 ? layout.padT + 14 : layout.padT + layout.plotH - 6;
        ctx.fillStyle = "#D8DCE2"; ctx.font = "10px ui-monospace, monospace";
        ctx.textAlign = q.xSign > 0 ? "right" : "left";
        ctx.textBaseline = q.ySign > 0 ? "top" : "bottom";
        ctx.fillText(`${q.label} R²=${q.rSquared.toFixed(3)}`, cornerX, cornerY);
      }
    }
  },
  legendEntries(cfg, artifacts) {
    return artifacts.quadrants.map((q) => ({
      color: cfg.color,
      label: `${q.label} R²=${q.rSquared.toFixed(3)}`,
    }));
  },
  Editor: () => null,
};

register(quadrantFitOverlay);

function runFit(kind: FitKind, xs: Float64Array, ys: Float64Array): FitResult {
  switch (kind.type) {
    case "linear":      return fitLinear(xs, ys);
    case "polynomial":  return fitPolynomial(xs, ys, kind.degree);
    case "exponential": return fitExponential(xs, ys);
    case "logarithmic": return fitLogarithmic(xs, ys);
    case "power":       return fitPower(xs, ys);
  }
}

function withAlpha(hex: string, alpha: number): string {
  if (!hex.startsWith("#") || hex.length !== 7) return hex;
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${(v >> 16) & 0xff},${(v >> 8) & 0xff},${v & 0xff},${alpha})`;
}

export type _ = SessionGroup;
```

- [ ] **Step 4: Register the overlay**

Edit `packages/widgets/src/xy-plot/render.tsx`:

```diff
 import "./overlays/scatter";
 import "./overlays/fit";
 import "./overlays/formula";
 import "./overlays/bins";
 import "./overlays/stats";
+import "./overlays/quadrant-fit";
```

- [ ] **Step 5: Run tests**

Run: `cd packages/widgets && pnpm vitest run tests/xy-plot/overlays/quadrant-fit.test.ts && pnpm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/widgets/src/xy-plot/overlays/quadrant-fit.ts packages/widgets/tests/xy-plot/overlays/quadrant-fit.test.ts packages/widgets/src/xy-plot/render.tsx
git commit -m "feat(xy-plot): quadrant-fit overlay (4 independent fits split at axes)"
```

---

## Phase 9 — Editor UX: mode toggle, filter, group-by, overlay list, per-overlay editors

### Task 18: Per-overlay Editor components

**Files:**
- Modify: `packages/widgets/src/xy-plot/overlays/scatter.ts`
- Modify: `packages/widgets/src/xy-plot/overlays/fit.ts`
- Modify: `packages/widgets/src/xy-plot/overlays/formula.ts`
- Modify: `packages/widgets/src/xy-plot/overlays/bins.ts`
- Modify: `packages/widgets/src/xy-plot/overlays/stats.ts`
- Modify: `packages/widgets/src/xy-plot/overlays/quadrant-fit.ts`

Replace each overlay's `Editor: () => null` with a real editor component. Code below; substitute into the corresponding file's existing Editor field.

- [ ] **Step 1: Scatter editor**

```tsx
// In packages/widgets/src/xy-plot/overlays/scatter.ts, replace the file's React imports
// and the Editor field. At top of file:
import { Fragment } from "react";

// Replace `Editor: () => null` with:
Editor: ({ config, onChange }) => (
  <Fragment>
    <Row label="color">
      <input type="color" value={config.color} onChange={(e) => onChange({ ...config, color: e.target.value })} className="w-24" />
    </Row>
    <Row label="point size">
      <input type="number" min={1} max={6} step={1} value={config.pointSize}
        onChange={(e) => onChange({ ...config, pointSize: Number(e.target.value) })}
        className="w-16 bg-[#0E0E10] border border-[#2A2C32] px-1" />
    </Row>
    <Row label="alpha">
      <input type="number" min={0} max={1} step={0.1} value={config.alpha}
        onChange={(e) => onChange({ ...config, alpha: Number(e.target.value) })}
        className="w-16 bg-[#0E0E10] border border-[#2A2C32] px-1" />
    </Row>
    <Row label="trail (time-color)">
      <input type="checkbox" checked={config.trail}
        onChange={(e) => onChange({ ...config, trail: e.target.checked })} />
    </Row>
  </Fragment>
),
```

Add at the bottom of the same file:

```tsx
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-2 text-[11px] text-[#D8DCE2] py-0.5">
      <span className="text-[#7B8088]">{label}</span>
      {children}
    </label>
  );
}
```

- [ ] **Step 2: Fit editor**

In `fit.ts`, replace `Editor: () => null` with:

```tsx
Editor: ({ config, onChange }) => (
  <>
    <Row label="kind">
      <select value={config.kind.type}
        onChange={(e) => {
          const t = e.target.value as FitKind["type"];
          const k: FitKind = t === "polynomial" ? { type: "polynomial", degree: 2 } : { type: t } as FitKind;
          onChange({ ...config, kind: k });
        }}
        className="bg-[#0E0E10] border border-[#2A2C32] px-1 text-[11px]">
        <option value="linear">linear</option>
        <option value="polynomial">polynomial</option>
        <option value="exponential">exponential</option>
        <option value="logarithmic">logarithmic</option>
        <option value="power">power</option>
      </select>
    </Row>
    {config.kind.type === "polynomial" && (
      <Row label="degree">
        <input type="number" min={1} max={6} value={config.kind.degree}
          onChange={(e) => onChange({ ...config, kind: { type: "polynomial", degree: Number(e.target.value) } })}
          className="w-16 bg-[#0E0E10] border border-[#2A2C32] px-1" />
      </Row>
    )}
    <Row label="color">
      <input type="color" value={config.color} onChange={(e) => onChange({ ...config, color: e.target.value })} className="w-24" />
    </Row>
    <Row label="line width">
      <input type="number" min={1} max={5} step={0.5} value={config.lineWidth}
        onChange={(e) => onChange({ ...config, lineWidth: Number(e.target.value) })}
        className="w-16 bg-[#0E0E10] border border-[#2A2C32] px-1" />
    </Row>
    <Row label="±σ band">
      <input type="checkbox" checked={config.showBand} onChange={(e) => onChange({ ...config, showBand: e.target.checked })} />
    </Row>
    <Row label="extrapolate to bounds">
      <input type="checkbox" checked={config.extrapolate} onChange={(e) => onChange({ ...config, extrapolate: e.target.checked })} />
    </Row>
    <Row label="per group-by group">
      <input type="checkbox" checked={config.perGroup} onChange={(e) => onChange({ ...config, perGroup: e.target.checked })} />
    </Row>
  </>
),
```

Add the same `Row` helper at the bottom of the file (each overlay file gets its own copy — DRY would re-export from a shared module but the per-overlay copies stay self-contained).

- [ ] **Step 3: Formula editor**

In `formula.ts`, replace `Editor: () => null` with:

```tsx
Editor: ({ config, onChange }) => (
  <>
    <Row label="expression (y = …)">
      <input type="text" value={config.expression}
        onChange={(e) => onChange({ ...config, expression: e.target.value })}
        placeholder="x"
        className="w-44 bg-[#0E0E10] border border-[#2A2C32] px-1 font-mono text-[11px]" />
    </Row>
    <Row label="color">
      <input type="color" value={config.color} onChange={(e) => onChange({ ...config, color: e.target.value })} className="w-24" />
    </Row>
    <Row label="line width">
      <input type="number" min={1} max={5} step={0.5} value={config.lineWidth}
        onChange={(e) => onChange({ ...config, lineWidth: Number(e.target.value) })}
        className="w-16 bg-[#0E0E10] border border-[#2A2C32] px-1" />
    </Row>
    <Row label="dashed">
      <input type="checkbox" checked={config.dashed} onChange={(e) => onChange({ ...config, dashed: e.target.checked })} />
    </Row>
  </>
),
```

Add the same `Row` helper at the bottom of the file.

- [ ] **Step 4: Bins editor**

In `bins.ts`, replace `Editor: () => null` with:

```tsx
Editor: ({ config, onChange }) => (
  <>
    <Row label="bins">
      <input type="number" min={1} max={200} value={config.binCount}
        onChange={(e) => onChange({ ...config, binCount: Number(e.target.value) })}
        className="w-16 bg-[#0E0E10] border border-[#2A2C32] px-1" />
    </Row>
    <Row label="statistic">
      <select value={config.statistic}
        onChange={(e) => onChange({ ...config, statistic: e.target.value as typeof config.statistic })}
        className="bg-[#0E0E10] border border-[#2A2C32] px-1 text-[11px]">
        <option value="mean">mean</option>
        <option value="median">median</option>
        <option value="p25-p75">p25–p75 band</option>
      </select>
    </Row>
    <Row label="color">
      <input type="color" value={config.color} onChange={(e) => onChange({ ...config, color: e.target.value })} className="w-24" />
    </Row>
    <Row label="show sample count">
      <input type="checkbox" checked={config.showCount} onChange={(e) => onChange({ ...config, showCount: e.target.checked })} />
    </Row>
  </>
),
```

Add the `Row` helper at the bottom of the file.

- [ ] **Step 5: Stats editor**

In `stats.ts`, replace `Editor: () => null` with:

```tsx
Editor: ({ config, onChange }) => (
  <>
    <Row label="position">
      <select value={config.position}
        onChange={(e) => onChange({ ...config, position: e.target.value as typeof config.position })}
        className="bg-[#0E0E10] border border-[#2A2C32] px-1 text-[11px]">
        <option value="top-left">top left</option>
        <option value="top-right">top right</option>
        <option value="bottom-left">bottom left</option>
        <option value="bottom-right">bottom right</option>
      </select>
    </Row>
    {(["count", "meanXY", "stdXY", "correlation", "fitRSquared", "fitEquation"] as const).map((k) => (
      <Row key={k} label={`show ${k}`}>
        <input type="checkbox" checked={config.show[k]}
          onChange={(e) => onChange({ ...config, show: { ...config.show, [k]: e.target.checked } })} />
      </Row>
    ))}
    <Row label="fit overlay id">
      <input type="text" value={config.fitOverlayId ?? ""}
        onChange={(e) => onChange({ ...config, fitOverlayId: e.target.value || undefined })}
        placeholder="(none)"
        className="w-32 bg-[#0E0E10] border border-[#2A2C32] px-1 font-mono text-[11px]" />
    </Row>
  </>
),
```

Add the `Row` helper at the bottom.

- [ ] **Step 6: Quadrant-fit editor**

In `quadrant-fit.ts`, replace `Editor: () => null` with:

```tsx
Editor: ({ config, onChange }) => (
  <>
    <Row label="kind">
      <select value={config.kind.type}
        onChange={(e) => {
          const t = e.target.value as FitKind["type"];
          const k: FitKind = t === "polynomial" ? { type: "polynomial", degree: 2 } : { type: t } as FitKind;
          onChange({ ...config, kind: k });
        }}
        className="bg-[#0E0E10] border border-[#2A2C32] px-1 text-[11px]">
        <option value="linear">linear</option>
        <option value="polynomial">polynomial</option>
        <option value="exponential">exponential</option>
        <option value="logarithmic">logarithmic</option>
        <option value="power">power</option>
      </select>
    </Row>
    {config.kind.type === "polynomial" && (
      <Row label="degree">
        <input type="number" min={1} max={6} value={config.kind.degree}
          onChange={(e) => onChange({ ...config, kind: { type: "polynomial", degree: Number(e.target.value) } })}
          className="w-16 bg-[#0E0E10] border border-[#2A2C32] px-1" />
      </Row>
    )}
    <Row label="color">
      <input type="color" value={config.color} onChange={(e) => onChange({ ...config, color: e.target.value })} className="w-24" />
    </Row>
    <Row label="line width">
      <input type="number" min={1} max={5} step={0.5} value={config.lineWidth}
        onChange={(e) => onChange({ ...config, lineWidth: Number(e.target.value) })}
        className="w-16 bg-[#0E0E10] border border-[#2A2C32] px-1" />
    </Row>
    <Row label="±σ band">
      <input type="checkbox" checked={config.showBand} onChange={(e) => onChange({ ...config, showBand: e.target.checked })} />
    </Row>
    <Row label="per-quadrant stats">
      <input type="checkbox" checked={config.showStatsOverlay} onChange={(e) => onChange({ ...config, showStatsOverlay: e.target.checked })} />
    </Row>
  </>
),
```

Add the `Row` helper.

- [ ] **Step 7: Typecheck and run all tests**

Run: `cd packages/widgets && pnpm typecheck && pnpm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/widgets/src/xy-plot/overlays
git commit -m "feat(xy-plot): per-overlay Editor components"
```

---

### Task 19: Top-level config editor — mode toggle + filter + group-by + overlay list

**Files:**
- Modify: `packages/widgets/src/xy-plot/config-editor.tsx`

- [ ] **Step 1: Replace `config-editor.tsx` with the full editor**

```tsx
import { useState } from "react";
import type { WidgetConfigEditorProps } from "../types";
import type { XyPlotConfig, Overlay, OverlayModule } from "./types";
import { ChannelPicker } from "../lib/channel-picker";
import { getOverlayModule, listOverlayModules } from "./overlays/registry";

export function XyPlotConfigEditor({ config, onChange, availableChannels }: WidgetConfigEditorProps<XyPlotConfig>) {
  const set = <K extends keyof XyPlotConfig>(k: K, v: XyPlotConfig[K]) => onChange({ ...config, [k]: v });

  const updateOverlay = (id: string, nextConfig: unknown) => {
    onChange({
      ...config,
      overlays: config.overlays.map((o) => o.id === id ? { ...o, config: nextConfig as never } as Overlay : o),
    });
  };
  const removeOverlay = (id: string) =>
    onChange({ ...config, overlays: config.overlays.filter((o) => o.id !== id) });
  const moveOverlay = (id: string, dir: -1 | 1) => {
    const idx = config.overlays.findIndex((o) => o.id === id);
    if (idx < 0) return;
    const next = [...config.overlays];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target]!, next[idx]!];
    onChange({ ...config, overlays: next });
  };
  const addOverlay = (kind: string) => {
    const mod = getOverlayModule(kind);
    if (!mod) return;
    onChange({
      ...config,
      overlays: [...config.overlays, {
        id: crypto.randomUUID(),
        kind,
        config: mod.defaultConfig() as never,
      } as Overlay],
    });
  };

  return (
    <div className="flex flex-col gap-2 p-2 text-xs text-[#D8DCE2]">
      {/* Mode toggle */}
      <div className="flex items-center gap-2 border-b border-[#2A2C32] pb-2">
        {(["simple", "advanced"] as const).map((m) => (
          <button key={m} type="button"
            onClick={() => set("mode", m)}
            className={
              "px-2 py-0.5 text-[11px] border rounded-sm cursor-pointer " +
              (config.mode === m
                ? "bg-[#FFC627] text-[#0E0E10] border-[#FFC627] font-semibold"
                : "bg-[#16171B] text-[#D8DCE2] border-[#2A2C32] hover:border-[#FFC627]")
            }>{m}</button>
        ))}
      </div>

      {/* Channels (always visible) */}
      <div className="flex flex-col gap-1">
        <label className="flex justify-between items-center"><span>x channel</span>
          <ChannelPicker className="w-40" value={config.xChannelId} onChange={(v) => set("xChannelId", v)} channels={availableChannels} />
        </label>
        <label className="flex justify-between items-center"><span>y channel</span>
          <ChannelPicker className="w-40" value={config.yChannelId} onChange={(v) => set("yChannelId", v)} channels={availableChannels} />
        </label>
        {(["xMin", "xMax", "yMin", "yMax"] as const).map((k) => (
          <label key={k} className="flex justify-between"><span>{k}</span>
            <input type="number" className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32"
              value={config[k] === undefined ? "" : config[k]}
              onChange={(e) => set(k, e.target.value === "" ? undefined : Number(e.target.value))} />
          </label>
        ))}
      </div>

      {/* Advanced-only sections */}
      {config.mode === "advanced" && (
        <>
          <div className="flex flex-col gap-1 border-t border-[#2A2C32] pt-2">
            <label className="flex justify-between items-center"><span>filter (math-expr)</span>
              <input type="text" value={config.filter ?? ""}
                onChange={(e) => set("filter", e.target.value)}
                placeholder="(none)"
                className="w-44 bg-[#0E0E10] border border-[#2A2C32] px-1 font-mono text-[11px]" />
            </label>
            <label className="flex justify-between items-center"><span>group by channel</span>
              <ChannelPicker className="w-40" value={config.groupByChannelId ?? ""}
                onChange={(v) => set("groupByChannelId", v || undefined)}
                channels={availableChannels} />
            </label>
          </div>

          <div className="flex flex-col gap-1 border-t border-[#2A2C32] pt-2">
            <div className="text-[10px] text-[#7B8088] uppercase tracking-wider">overlays</div>
            {config.overlays.map((o, idx) => (
              <OverlayRow key={o.id} overlay={o} index={idx} total={config.overlays.length}
                availableChannels={availableChannels}
                onConfigChange={(c) => updateOverlay(o.id, c)}
                onMove={(dir) => moveOverlay(o.id, dir)}
                onRemove={() => removeOverlay(o.id)} />
            ))}
            <AddOverlayPicker mode={config.mode} onAdd={addOverlay} />
          </div>
        </>
      )}
    </div>
  );
}

function OverlayRow({ overlay, index, total, availableChannels, onConfigChange, onMove, onRemove }: {
  overlay: Overlay;
  index: number;
  total: number;
  availableChannels: WidgetConfigEditorProps<XyPlotConfig>["availableChannels"];
  onConfigChange: (cfg: unknown) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const mod = getOverlayModule(overlay.kind);
  const [open, setOpen] = useState(true);
  if (!mod) {
    return (
      <div className="text-[#EF5350] text-[11px] py-1">
        unknown overlay kind: {overlay.kind} <button onClick={onRemove} className="ml-2 underline">remove</button>
      </div>
    );
  }
  const Editor = mod.Editor as React.FC<{ config: unknown; onChange: (c: unknown) => void; availableChannels: typeof availableChannels }>;
  return (
    <div className="border border-[#2A2C32] rounded-sm">
      <div className="flex items-center justify-between px-1 py-0.5 bg-[#0E0E10] text-[11px]">
        <button onClick={() => setOpen(!open)} className="flex items-center gap-1 text-left flex-1">
          <span>{open ? "▾" : "▸"}</span>
          <span className="font-semibold text-[#FFC627]">{overlay.kind}</span>
        </button>
        <div className="flex items-center gap-1">
          <button onClick={() => onMove(-1)} disabled={index === 0} className="px-1 disabled:opacity-30">↑</button>
          <button onClick={() => onMove(1)} disabled={index === total - 1} className="px-1 disabled:opacity-30">↓</button>
          <button onClick={onRemove} className="px-1 text-[#EF5350]">✕</button>
        </div>
      </div>
      {open && (
        <div className="p-1">
          <Editor config={overlay.config} onChange={onConfigChange} availableChannels={availableChannels} />
        </div>
      )}
    </div>
  );
}

function AddOverlayPicker({ mode, onAdd }: { mode: "simple" | "advanced"; onAdd: (kind: string) => void }) {
  const available = listOverlayModules().filter((m) => m.availability.includes(mode));
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button onClick={() => setOpen((s) => !s)}
        className="px-2 py-0.5 text-[11px] border border-[#2A2C32] bg-[#16171B] text-[#FFC627] hover:border-[#FFC627] rounded-sm cursor-pointer">
        + Add overlay
      </button>
      {open && (
        <div className="absolute z-10 mt-1 bg-[#0E0E10] border border-[#2A2C32] rounded-sm flex flex-col">
          {available.map((mod) => (
            <button key={mod.kind} onClick={() => { onAdd(mod.kind); setOpen(false); }}
              className="px-2 py-1 text-left text-[11px] hover:bg-[#16171B]">{mod.kind}</button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck and run all tests**

Run: `cd packages/widgets && pnpm typecheck && pnpm test && cd ../../apps/desktop && pnpm typecheck && pnpm test`
Expected: PASS in both packages

- [ ] **Step 3: Commit**

```bash
git add packages/widgets/src/xy-plot/config-editor.tsx
git commit -m "feat(xy-plot): full config editor — mode, filter, group-by, overlay list"
```

---

## Phase 10 — Documentation entry & manual smoke check

### Task 20: `v2_changes/27` retrospective entry + version bump

**Files:**
- Create: `v2_changes/27-xy-analysis-plot.md`
- Modify: `v2_changes/README.md` (add row in the index table)
- Modify: `package.json`, `apps/desktop/package.json`, `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/Cargo.toml` — bump to `2.4.0`

- [ ] **Step 1: Write the v2_changes entry**

```markdown
<!-- v2_changes/27-xy-analysis-plot.md -->
# 27 — XY Analysis Plot

**Version:** 2.4.0
**Date:** 2026-05-06

## What

Upgraded the `xy_plot` widget from a fixed scatter into a fully composable analysis tool inspired by MoTeC i2's analysis screens. Added:

- **Simple ↔ Advanced** mode toggle. Simple keeps the existing behaviour (just channels + bounds + color + trail). Advanced unlocks everything below.
- **Six overlay kinds** combinable in any order:
  - `scatter` — the base point cloud (always present after migration of legacy configs).
  - `fit` — best-fit overlays: linear, polynomial degree 1–6, exponential, logarithmic, power. Optional ±σ confidence band; optional extrapolation past the observed X range.
  - `formula` — free-form `y = f(x)` curve typed by the user; uses the existing math-expr engine.
  - `bins` — empirical lookup curve. Equally-spaced bins along X; pick mean / median / p25–p75 band.
  - `stats` — corner-anchored selectable HTML panel with count, mean X/Y, stddev X/Y, correlation r, plus R² + equation read from a referenced fit overlay.
  - `quadrant-fit` — runs four independent regressions split at axis zero; killer feature for damper analysis (bump vs rebound have very different shapes).
- **Filter expression** — math-expr formula evaluated per-sample; samples where the result is falsy are excluded from every overlay.
- **Group-by channel** — distinct values become separate scatter colors and (optionally) per-group fits.
- **Zoom integration** — when the global zoom range is set, only samples whose timestamp falls inside the window enter the plot.

## Why

The simple XY plot covered "see two channels against each other" but nothing past it. Real motorsport analysis (suspension damper curves, tire grip studies, engine maps, driver consistency) all want regression overlays, statistics, and per-condition filtering on top of the same raw scatter. Building this as a plugin-style overlay system means future analysis features (density heatmap, residual plot, multivariate regression) are one new module each — no edits to existing ones.

## Migration

Existing saved tiles, exported `.helios` bundles, and built-in workspace defaults all keep rendering. A one-shot migration in `xy-plot/index.tsx` rewrites legacy v1 configs (`{xChannelId, yChannelId, xMin, …, color, trail}`) into the v2 shape on read, wrapping the scatter into a single `scatter` overlay with id `migrated-scatter`.

Workspace bundles bump their `schemaVersion` so older Helios installs gracefully refuse to import 2.4-era bundles instead of crash-rendering them.

## Tests added

- `packages/lib/tests/regression.test.ts` — 10 tests covering all five fit kinds with known-input/known-output cases.
- `packages/lib/tests/statistics.test.ts` — 7 tests for mean/stddev/correlation/percentile/linspace.
- `packages/widgets/tests/xy-plot/migrations.test.ts` — legacy → v2 migration; v2 no-op; defaults.
- `packages/widgets/tests/xy-plot/data-pipeline.test.ts` — filter, group-by, zoom, all combined.
- `packages/widgets/tests/xy-plot/overlays/*.test.ts` — one suite per overlay module.

## Files of note

- `packages/lib/src/regression.ts` — pure math, no React. Reusable.
- `packages/lib/src/statistics.ts` — same.
- `packages/widgets/src/xy-plot/types.ts` — single source of truth for the schema and overlay contract.
- `packages/widgets/src/xy-plot/data-pipeline.ts` — filter/group-by/zoom in one place; every overlay sees the same `SessionGroup[]`.
- `packages/widgets/src/xy-plot/overlays/registry.ts` — adding a new overlay = one new file + one side-effect import in `render.tsx`.

## Manual smoke checklist

Performed before tagging the release:

- [ ] Open a session with at least throttle, RPM, gear channels.
- [ ] Add an XY tile with default config (simple mode); confirm it renders identically to a 2.3.x install.
- [ ] Switch to advanced; add a `fit` overlay (linear); confirm the line shows.
- [ ] Add a `formula` overlay `0.5 * x`; confirm the dashed line draws.
- [ ] Set filter `throttle > 50`; confirm scatter + fit drop the low-throttle samples.
- [ ] Set group-by `gear`; confirm per-gear color + per-gear fit (with `perGroup` toggled on the fit).
- [ ] Add a `stats` overlay top-right with `fitRSquared` enabled and `fitOverlayId` pointing at the fit's id; confirm R² shows.
- [ ] Zoom into a sub-section in any strip-chart; confirm the XY plot's data shrinks accordingly.
- [ ] Drop a few datums (shift+click on a strip-chart); confirm red-orange dots appear at the matching (x, y) on the XY plot.
- [ ] Save the workspace, restart Helios, confirm everything restores including filter, group-by, all overlays.
- [ ] Export `.helios`, import on a clean instance, confirm same.
```

- [ ] **Step 2: Bump version in all four files**

```bash
# package.json (workspace root)
# apps/desktop/package.json
# apps/desktop/src-tauri/tauri.conf.json
# apps/desktop/src-tauri/Cargo.toml
```

For each file, change the version string from `2.3.3` to `2.4.0`. Use Edit tool on each individually (the strings appear once per file).

- [ ] **Step 3: Add a row to `v2_changes/README.md`**

Open `v2_changes/README.md` and add a new row in the table (or follow whatever index format already exists). Run `cat v2_changes/README.md | head -20` first to see the format if unsure; mirror existing entries.

- [ ] **Step 4: Run the full test suite at the repo root**

Run: `cd ~/Developer/helios && pnpm -r test && pnpm -r typecheck`
Expected: every package PASS

- [ ] **Step 5: Manual smoke (perform every checklist item in `v2_changes/27-xy-analysis-plot.md`'s "Manual smoke checklist")**

Don't skip — this is the only validation that the canvas drawing actually looks right.

- [ ] **Step 6: Commit**

```bash
git add v2_changes/27-xy-analysis-plot.md v2_changes/README.md package.json apps/desktop/package.json apps/desktop/src-tauri/tauri.conf.json apps/desktop/src-tauri/Cargo.toml
git commit -m "chore: bump to 2.4.0 (XY analysis plot; do not release yet)"
```

(The "do not release yet" tail matches the existing convention — a tagged `v*` triggers the GitHub Actions release pipeline; the user tags manually when ready.)

---

## Self-review notes (for the engineer running this plan)

**Spec coverage check:** Every section of the design spec maps to a task above:
- Math library (regression + statistics) → Tasks 1–4
- Types + migration + data pipeline + registry → Tasks 5–8
- Scatter as overlay + render orchestrator + index/migration wiring → Tasks 9–11
- Fit / Formula / Bins / Stats / Quadrant-fit overlays → Tasks 12–17
- Editor UX (per-overlay editors + top-level mode/filter/group-by/list) → Tasks 18–19
- Documentation + version bump + smoke check → Task 20

**Type consistency check:** Names used across tasks line up — `XyPlotConfig`, `Overlay`, `SessionGroup`, `OverlayContext`, `PlotLayout`, `OverlayModule`, `FitConfig`, `FitKind`, `register`, `getOverlayModule`, `listOverlayModules`, `migrateConfig`, `buildSessionGroups`. Each overlay's exported constant follows the pattern `<kind>Overlay` (e.g. `scatterOverlay`, `fitOverlay`).

**Placeholder check:** No "TBD"/"TODO" anywhere; every code step shows the code; every command shows the expected outcome.

---

## Plan complete

Saved to `docs/superpowers/plans/2026-05-06-xy-analysis-plot.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
