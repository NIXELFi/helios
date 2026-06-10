# CFD Phase 4 — Post-hoc Sensitivity / Tornado Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a post-hoc "Parameter sensitivity" tornado chart to the optimization results screen that ranks each tunable parameter by how strongly it drives a chosen metric (the backend objective or any FSAE event metric), using Spearman rank-correlation mined from the trials already stored in a completed study.

**Architecture:** Pure-frontend, zero backend. Three pieces: (1) a pure stats module `lib/analytics/sensitivityStats.ts` (tie-corrected Spearman + an approximate significance p-value + a `computeSensitivity` selector), built on the existing Pearson `correlation()` from `@helios/lib`; (2) a hand-rolled SVG `components/charts/TornadoChart.tsx` mirroring `ScatterPlot.tsx`/`ParallelCoordsPlot.tsx` (no chart library exists or is allowed); (3) wiring a new gated-on-`status==='done'` section into `results/OptimizationResults.tsx` with its own metric selector, reusing the existing per-trial `computeEvents` scoring path. No changes to Rust, the reducer, `types.ts`, or storage — every input (`parameterValues`, `objectiveValue`, `sweepPoints`) is already persisted on the study.

**Tech Stack:** TypeScript, React, Vitest + @testing-library/react, inline SVG, `@helios/lib` (`correlation`), existing `lib/performance` (`computeEvents`, `EVENT_RANK_METRICS`).

---

## Design decisions (read before coding)

1. **Why this reverses the analytics veto.** The v4.1.0 analytics-export spec (`docs/superpowers/specs/2026-06-05-cfd-analytics-export-design.md:17`) deliberately *vetoed* on-screen correlation/sensitivity stats as "meaningless at 20–40 trials." The newer competition-events design (`docs/superpowers/specs/2026-06-08-cfd-competition-events-design.md:75`) re-sanctions P4 as planned work, so the reversal is blessed — but this plan must **answer** the original concern, not ignore it. We do that three ways: **(a)** the panel is gated to `study.status === 'done'` (post-hoc only, never mid-run noise); **(b)** every estimate carries an explicit **n** and a **low-n caveat** below n=12; **(c)** statistically **non-significant bars are visually faded** (approximate two-sided p ≥ 0.05) so a noisy correlation reads as noise, not signal.

2. **Spearman, not Pearson.** The sampler is space-filling (LHS/random) and parameter→metric relationships are monotonic-but-nonlinear; rank correlation is the honest choice and needs no model fit. `@helios/lib` only ships Pearson `correlation()`; Spearman = Pearson on **tie-averaged ranks** (tie-averaging matters because backend snaps parameters to a step grid → repeated values).

3. **Sign convention.** A bar is the **raw signed Spearman ρ of (parameter value, raw metric value)** — honest and direction-agnostic. We do **not** flip the sign for "lower-is-better" metrics. Instead the caption states the metric's better-direction ("Lower is better." / "Higher is better.") so the sign is interpretable. Positive ρ → bar right (gold `#FFC627`), negative ρ → bar left (blue `#4FC3F7`).

4. **Reuse, don't reinvent.** Per-trial event scores come from the *exact* existing path (`computeEvents(torqueCurveFromSweep(t.sweepPoints), vehicle, baseline)`), but computed **unconditionally** — the existing `eventsByTrial` memo short-circuits to an empty map when `rankDim === 'objective'`, so the panel needs its own memo.

5. **Graceful degradation.** Points metrics (`endurancePts`/`efficiencyPts`/`totalPts`) are `null` without a reference baseline → those columns show the existing "needs baselines (Performance tab)" message. `sweepPoints` can be quota-stripped on reload → event metrics become uncomputable for that trial (skip it); objective correlation still works because `parameterValues`/`objectiveValue` always survive. Constant param columns or <3 finite pairs → ρ is `NaN` → bar omitted.

## File structure

- **Create** `apps/desktop/src/modules/cfd/lib/analytics/sensitivityStats.ts` — pure stats (no React/Tauri), sibling to `optimizationStats.ts`.
- **Create** `apps/desktop/src/modules/cfd/__tests__/analytics/sensitivityStats.test.ts` — pure-function vitest.
- **Create** `apps/desktop/src/modules/cfd/components/charts/TornadoChart.tsx` — hand-rolled SVG chart.
- **Create** `apps/desktop/src/modules/cfd/__tests__/TornadoChart.test.tsx` — RTL SVG test.
- **Modify** `apps/desktop/src/modules/cfd/results/OptimizationResults.tsx` — new gated section + metric selector + memo (insert after the parallel-coords charts block, before the "Rank by" control at line ~462).
- **Modify** `apps/desktop/src/modules/cfd/__tests__/OptimizationResults.test.tsx` — add a sensitivity-section render test.
- **Create** `v2_changes/50-cfd-phase-4-sensitivity-tornado.md` — changelog entry (follows the v2_changes convention).

---

### Task 1: Spearman core (`rankAverage` + `spearman`)

**Files:**
- Create: `apps/desktop/src/modules/cfd/lib/analytics/sensitivityStats.ts`
- Test: `apps/desktop/src/modules/cfd/__tests__/analytics/sensitivityStats.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/modules/cfd/__tests__/analytics/sensitivityStats.test.ts
import { describe, it, expect } from "vitest";

import { rankAverage, spearman } from "../../lib/analytics/sensitivityStats";

describe("rankAverage", () => {
  it("ranks ascending, 1-based", () => {
    expect(rankAverage([10, 30, 20])).toEqual([1, 3, 2]);
  });
  it("averages tied ranks", () => {
    expect(rankAverage([5, 5, 9])).toEqual([1.5, 1.5, 3]);
    expect(rankAverage([7, 7, 7])).toEqual([2, 2, 2]);
  });
});

describe("spearman", () => {
  it("is +1 for a perfectly increasing monotonic relation", () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 8);
  });
  it("is -1 for a perfectly decreasing relation", () => {
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 8);
  });
  it("is tie-corrected (rank, not raw, correlation)", () => {
    // raw values are nonlinear but rank-monotonic → ρ = 1
    expect(spearman([1, 2, 3, 4], [1, 4, 9, 16])).toBeCloseTo(1, 8);
  });
  it("returns NaN with fewer than 3 paired samples", () => {
    expect(spearman([1, 2], [3, 4])).toBeNaN();
  });
  it("returns NaN when a column has zero variance", () => {
    expect(spearman([2, 2, 2], [1, 2, 3])).toBeNaN();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run src/modules/cfd/__tests__/analytics/sensitivityStats.test.ts`
Expected: FAIL — cannot resolve module `../../lib/analytics/sensitivityStats`.

- [ ] **Step 3: Write the minimal implementation**

```ts
// apps/desktop/src/modules/cfd/lib/analytics/sensitivityStats.ts
//
// Pure, display-side sensitivity analysis for COMPLETED optimization studies.
// No React / Tauri imports — unit-testable in isolation and safe to import
// anywhere. Spearman rank-correlation = Pearson on tie-averaged ranks; we reuse
// the Pearson `correlation()` from @helios/lib rather than reimplementing it.

import { correlation } from "@helios/lib";

/** 1-based ranks with ties averaged (the standard tie-correction for Spearman).
 *  Length and order match the input. */
export function rankAverage(xs: number[]): number[] {
  const n = xs.length;
  const order = xs.map((_, i) => i).sort((a, b) => xs[a]! - xs[b]!);
  const ranks = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && xs[order[j + 1]!]! === xs[order[i]!]!) j++;
    const avg = (i + j) / 2 + 1; // average of the 1-based positions i+1..j+1
    for (let k = i; k <= j; k++) ranks[order[k]!] = avg;
    i = j + 1;
  }
  return ranks;
}

/** Tie-corrected Spearman ρ. Returns NaN for <3 paired samples or zero variance
 *  in either column (delegated to correlation()'s own NaN behavior). */
export function spearman(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 3) return NaN;
  return correlation(rankAverage(xs), rankAverage(ys));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/desktop && pnpm exec vitest run src/modules/cfd/__tests__/analytics/sensitivityStats.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/modules/cfd/lib/analytics/sensitivityStats.ts apps/desktop/src/modules/cfd/__tests__/analytics/sensitivityStats.test.ts
git commit -m "feat(cfd): tie-corrected Spearman core for sensitivity analysis"
```

---

### Task 2: Significance + `computeSensitivity` selector

**Files:**
- Modify: `apps/desktop/src/modules/cfd/lib/analytics/sensitivityStats.ts`
- Test: `apps/desktop/src/modules/cfd/__tests__/analytics/sensitivityStats.test.ts`

- [ ] **Step 1: Write the failing test (append to the existing test file)**

```ts
import { spearmanPValue, computeSensitivity } from "../../lib/analytics/sensitivityStats";

describe("spearmanPValue", () => {
  it("is ~1 for ρ near 0", () => {
    expect(spearmanPValue(0, 30)).toBeCloseTo(1, 6);
  });
  it("flags a strong correlation at decent n as significant (<0.05)", () => {
    expect(spearmanPValue(1, 10)).toBeLessThan(0.05);
  });
  it("treats a weak correlation at small n as not significant (>=0.05)", () => {
    expect(spearmanPValue(0.3, 10)).toBeGreaterThan(0.05);
  });
  it("is NaN for ρ NaN or n<3", () => {
    expect(spearmanPValue(NaN, 30)).toBeNaN();
    expect(spearmanPValue(0.9, 2)).toBeNaN();
  });
});

describe("computeSensitivity", () => {
  const samples = [
    { params: { a: 1, b: 5 }, metric: 10 },
    { params: { a: 2, b: 4 }, metric: 20 },
    { params: { a: 3, b: 3 }, metric: 30 },
    { params: { a: 4, b: 2 }, metric: 40 },
  ];

  it("returns a signed ρ per parameter, sorted by |ρ| descending", () => {
    const rows = computeSensitivity(["a", "b"], samples);
    const a = rows.find((r) => r.path === "a")!;
    const b = rows.find((r) => r.path === "b")!;
    expect(a.rho).toBeCloseTo(1, 8);
    expect(b.rho).toBeCloseTo(-1, 8);
    expect(a.n).toBe(4);
    expect(b.n).toBe(4);
  });

  it("drops pairs where the metric is null and counts the rest", () => {
    const withNull = [...samples, { params: { a: 5, b: 1 }, metric: null }];
    const rows = computeSensitivity(["a"], withNull);
    expect(rows[0]!.n).toBe(4); // the null-metric sample excluded
  });

  it("drops pairs where the parameter value is missing/non-finite", () => {
    const sparse = [
      { params: { a: 1 }, metric: 10 },
      { params: {}, metric: 20 },
      { params: { a: 3 }, metric: 30 },
      { params: { a: 4 }, metric: 40 },
    ];
    expect(computeSensitivity(["a"], sparse)[0]!.n).toBe(3);
  });

  it("yields NaN ρ for a constant parameter and sorts it last", () => {
    const rows = computeSensitivity(["a", "const"], [
      { params: { a: 1, const: 7 }, metric: 10 },
      { params: { a: 2, const: 7 }, metric: 20 },
      { params: { a: 3, const: 7 }, metric: 30 },
    ]);
    expect(rows[0]!.path).toBe("a");
    expect(rows[1]!.path).toBe("const");
    expect(rows[1]!.rho).toBeNaN();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run src/modules/cfd/__tests__/analytics/sensitivityStats.test.ts`
Expected: FAIL — `spearmanPValue`/`computeSensitivity` are not exported.

- [ ] **Step 3: Write the minimal implementation (append to `sensitivityStats.ts`)**

```ts
// --- Significance --------------------------------------------------------------

// Normal CDF via the Abramowitz & Stegun 7.1.26 erf approximation. Adequate for
// a *visual* significance cue (faded vs solid bars); we are not reporting exact
// p-values.
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Approximate two-sided p-value for a Spearman ρ under H0 (no association),
 *  using the large-sample result ρ·√(n−1) ~ N(0,1). NaN if ρ is non-finite or
 *  n<3. */
export function spearmanPValue(rho: number, n: number): number {
  if (!Number.isFinite(rho) || n < 3) return NaN;
  const z = Math.abs(rho) * Math.sqrt(n - 1);
  return 2 * (1 - normalCdf(z));
}

// --- Selector ------------------------------------------------------------------

export interface SensitivityRow {
  /** Parameter path (may carry a `[N]` per-element suffix). */
  path: string;
  /** Tie-corrected Spearman ρ of (parameter, metric); NaN if undefined. */
  rho: number;
  /** Number of finite paired samples used. */
  n: number;
  /** Approximate two-sided p-value; NaN when ρ is NaN. */
  pValue: number;
}

export interface SensitivitySample {
  /** A trial's sampled parameter values (path → value). */
  params: Record<string, number>;
  /** The chosen metric's value for this trial, or null when unavailable. */
  metric: number | null;
}

/** One sensitivity row per parameter path, sorted by |ρ| descending with NaN
 *  rows (constant columns / too few pairs) pushed to the end. Pairs where either
 *  side is non-finite/null are dropped per parameter, so n can differ by row. */
export function computeSensitivity(
  paths: string[],
  samples: SensitivitySample[],
): SensitivityRow[] {
  const rows = paths.map((path) => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const s of samples) {
      const x = s.params[path];
      const y = s.metric;
      if (x !== undefined && Number.isFinite(x) && y !== null && Number.isFinite(y)) {
        xs.push(x);
        ys.push(y);
      }
    }
    const rho = spearman(xs, ys);
    return { path, rho, n: xs.length, pValue: spearmanPValue(rho, xs.length) };
  });

  return rows.sort((a, b) => {
    const aa = Number.isFinite(a.rho) ? Math.abs(a.rho) : -1;
    const bb = Number.isFinite(b.rho) ? Math.abs(b.rho) : -1;
    return bb - aa;
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/desktop && pnpm exec vitest run src/modules/cfd/__tests__/analytics/sensitivityStats.test.ts`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/modules/cfd/lib/analytics/sensitivityStats.ts apps/desktop/src/modules/cfd/__tests__/analytics/sensitivityStats.test.ts
git commit -m "feat(cfd): sensitivity selector + approximate Spearman significance"
```

---

### Task 3: `TornadoChart` SVG component

**Files:**
- Create: `apps/desktop/src/modules/cfd/components/charts/TornadoChart.tsx`
- Test: `apps/desktop/src/modules/cfd/__tests__/TornadoChart.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/desktop/src/modules/cfd/__tests__/TornadoChart.test.tsx
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import { TornadoChart, type TornadoBar } from "../components/charts/TornadoChart";

const BARS: TornadoBar[] = [
  { label: "runner_length", rho: 0.82, n: 30, significant: true },
  { label: "plenum_volume", rho: -0.41, n: 30, significant: false },
];

describe("TornadoChart", () => {
  it("draws one bar rect per parameter with no NaN coordinates", () => {
    const { container } = render(<TornadoChart bars={BARS} />);
    const rects = Array.from(container.querySelectorAll("rect"));
    expect(rects).toHaveLength(2);
    for (const r of rects) {
      expect(r.getAttribute("x")).not.toMatch(/NaN/);
      expect(r.getAttribute("width")).not.toMatch(/NaN/);
    }
  });

  it("colors positive ρ gold and negative ρ blue", () => {
    const { container } = render(<TornadoChart bars={BARS} />);
    const rects = container.querySelectorAll("rect");
    expect(rects[0]!.getAttribute("fill")).toBe("#FFC627"); // +0.82
    expect(rects[1]!.getAttribute("fill")).toBe("#4FC3F7"); // -0.41
  });

  it("fades non-significant bars", () => {
    const { container } = render(<TornadoChart bars={BARS} />);
    const groups = container.querySelectorAll("g[data-bar]");
    expect(groups[0]!.getAttribute("opacity")).toBe("1");
    expect(groups[1]!.getAttribute("opacity")).toBe("0.4");
  });

  it("omits bars with non-finite ρ", () => {
    const { container } = render(
      <TornadoChart bars={[...BARS, { label: "x", rho: NaN, n: 1, significant: false }]} />,
    );
    expect(container.querySelectorAll("rect")).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run src/modules/cfd/__tests__/TornadoChart.test.tsx`
Expected: FAIL — cannot resolve `../components/charts/TornadoChart`.

- [ ] **Step 3: Write the minimal implementation**

```tsx
// apps/desktop/src/modules/cfd/components/charts/TornadoChart.tsx
//
// Horizontal diverging "tornado" bar chart, hand-rolled SVG (NOT uPlot / no
// chart lib). One row per parameter, bars centered on a ρ=0 line over the fixed
// correlation domain [-1, 1]: positive ρ extends right (gold), negative left
// (blue). Bars arrive pre-sorted by |ρ| descending; non-finite ρ rows are
// skipped. Mirrors ScatterPlot/ParallelCoordsPlot idioms: useElementWidth,
// role="img" aria-label, the dark palette, defensive finite guards.

import { useRef } from "react";

import { useElementWidth } from "./useElementWidth";

export interface TornadoBar {
  /** Display label (parameter path). */
  label: string;
  /** Signed Spearman ρ in [-1, 1]. */
  rho: number;
  /** Sample count behind this ρ (for the tooltip title). */
  n: number;
  /** Whether |ρ| clears the ~95% significance threshold. */
  significant: boolean;
}

interface Props {
  bars: TornadoBar[];
  /** Per-row height in px. */
  rowHeight?: number;
}

const POS = "#FFC627"; // gold — positive ρ
const NEG = "#4FC3F7"; // blue — negative ρ
const AXIS = "#3f3f46";
const ZERO = "#D8DCE2";
const TICK = "#71717a";
const LABEL = "#D8DCE2";

export function TornadoChart({ bars, rowHeight = 22 }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const width = Math.max(useElementWidth(hostRef, 600), 280);

  const rows = bars.filter((b) => Number.isFinite(b.rho));
  const padTop = 8;
  const padBottom = 22;
  const padLeft = 160;
  const padRight = 44;
  const height = padTop + padBottom + Math.max(rows.length, 1) * rowHeight;
  const plotW = Math.max(width - padLeft - padRight, 10);
  const center = padLeft + plotW / 2;
  // Fixed correlation domain [-1, 1] → honest, comparable across metrics.
  const xOf = (rho: number) => center + rho * (plotW / 2);
  const ticks = [-1, -0.5, 0, 0.5, 1];

  return (
    <div ref={hostRef} className="w-full">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`Parameter sensitivity tornado, ${rows.length} parameters`}
        className="block"
      >
        {ticks.map((g) => (
          <g key={g}>
            <line
              x1={xOf(g)}
              x2={xOf(g)}
              y1={padTop}
              y2={height - padBottom}
              stroke={g === 0 ? ZERO : AXIS}
              strokeWidth={g === 0 ? 1 : 0.5}
            />
            <text x={xOf(g)} y={height - padBottom + 14} textAnchor="middle" fontSize={9} fill={TICK}>
              {g}
            </text>
          </g>
        ))}

        {rows.map((b, i) => {
          const y = padTop + i * rowHeight;
          const x1 = xOf(b.rho);
          const bx = Math.min(center, x1);
          const bw = Math.abs(x1 - center);
          return (
            <g key={b.label} data-bar opacity={b.significant ? 1 : 0.4}>
              <title>{`${b.label}: ρ=${b.rho.toFixed(2)} (n=${b.n})`}</title>
              <text
                x={padLeft - 8}
                y={y + rowHeight / 2}
                textAnchor="end"
                dominantBaseline="middle"
                fontSize={10}
                fill={LABEL}
                fontFamily="ui-monospace, monospace"
              >
                {b.label}
              </text>
              <rect x={bx} y={y + 4} width={Math.max(bw, 0)} height={rowHeight - 8} fill={b.rho >= 0 ? POS : NEG} />
              <text
                x={b.rho >= 0 ? x1 + 4 : x1 - 4}
                y={y + rowHeight / 2}
                textAnchor={b.rho >= 0 ? "start" : "end"}
                dominantBaseline="middle"
                fontSize={9}
                fill={TICK}
              >
                {b.rho.toFixed(2)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/desktop && pnpm exec vitest run src/modules/cfd/__tests__/TornadoChart.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/modules/cfd/components/charts/TornadoChart.tsx apps/desktop/src/modules/cfd/__tests__/TornadoChart.test.tsx
git commit -m "feat(cfd): TornadoChart hand-rolled SVG component"
```

---

### Task 4: Wire the Sensitivity panel into `OptimizationResults`

**Files:**
- Modify: `apps/desktop/src/modules/cfd/results/OptimizationResults.tsx`
- Test: `apps/desktop/src/modules/cfd/__tests__/OptimizationResults.test.tsx`

- [ ] **Step 1: Write the failing test (append to the existing suite)**

```tsx
describe("OptimizationResults — sensitivity", () => {
  it("renders the sensitivity tornado for a completed study", () => {
    const study = makeOptimizationStudy(); // status 'done', 3 trials, 2 params
    render(<OptimizationResults study={study} />);
    // The metric selector for the new panel.
    expect(screen.getByLabelText("Sensitivity metric")).toBeInTheDocument();
    // The tornado SVG with one bar per varied parameter (runner_length, plenum_volume_l).
    const chart = screen.getByLabelText(/Parameter sensitivity tornado/);
    expect(chart.querySelectorAll("rect")).toHaveLength(2);
  });

  it("omits the sensitivity panel while a study is still running", () => {
    const study = makeOptimizationStudy({ status: "running" });
    render(<OptimizationResults study={study} />);
    expect(screen.queryByLabelText("Sensitivity metric")).not.toBeInTheDocument();
  });
});
```

> Note: `makeOptimizationStudy()`'s three trials have `runner_length` `[0.25, 0.32, 0.30]` and `objectiveValue` `[55, 64, 60]` — both rank as `[1, 3, 2]`, so each parameter yields ρ = 1 against the objective (two finite bars). The default metric is `"objective"`, which needs no `sweepPoints`, so the fixture (sweepPoints null) is sufficient.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run src/modules/cfd/__tests__/OptimizationResults.test.tsx -t sensitivity`
Expected: FAIL — no element with label "Sensitivity metric".

- [ ] **Step 3: Add the imports** (extend the existing `from "../lib/performance"` import and add two new imports) near the top of `OptimizationResults.tsx`:

```tsx
import { computeSensitivity } from "../lib/analytics/sensitivityStats";
import { TornadoChart, type TornadoBar } from "../components/charts/TornadoChart";
```

(`torqueCurveFromSweep`, `computeEvents`, `carKeyForConfig`, `vehiclePresetForKey`, `EMPTY_BASELINE`, `EVENT_RANK_METRICS`, `POINTS_METRIC_KEYS`, `EventScores`, `EventMetricKey` are already imported.)

- [ ] **Step 4: Add panel state + memos** inside `OptimizationResults`, just after the existing `eventsByTrial` memo / `dimDef` block (around line 100–106):

```tsx
  // --- Post-hoc parameter sensitivity (P4) -----------------------------------
  // Independent of rankDim, so it needs its OWN per-trial event scores
  // (eventsByTrial short-circuits to empty when rankDim === "objective").
  const [sensMetric, setSensMetric] = useState<RankDim>("objective");

  const sensVehBase = useMemo(() => {
    const vc = cfd.state?.vehicleConfig;
    const vehicle = vc && vc.name === carKey ? vc : vehiclePresetForKey(carKey);
    const baseline = cfd.state?.referenceBaseline ?? EMPTY_BASELINE;
    return { vehicle, baseline };
  }, [carKey, cfd.state?.vehicleConfig, cfd.state?.referenceBaseline]);

  const sensEvents = useMemo(() => {
    const map = new Map<number, EventScores>();
    for (const t of study.trials) {
      if (t.status === "done" && t.sweepPoints && t.sweepPoints.length > 0) {
        map.set(
          t.trialIdx,
          computeEvents(torqueCurveFromSweep(t.sweepPoints), sensVehBase.vehicle, sensVehBase.baseline),
        );
      }
    }
    return map;
  }, [study.trials, sensVehBase]);

  const sensRows = useMemo(() => {
    const metricDef =
      sensMetric === "objective" ? null : EVENT_RANK_METRICS.find((m) => m.key === sensMetric) ?? null;
    const samples = study.trials
      .filter((t) => t.status === "done")
      .map((t) => {
        let metric: number | null;
        if (sensMetric === "objective") {
          metric = t.objectiveValue;
        } else {
          const e = sensEvents.get(t.trialIdx);
          metric = e && metricDef ? metricDef.get(e) : null;
        }
        return { params: t.parameterValues, metric };
      });
    return computeSensitivity(study.parameterPaths, samples);
  }, [study.trials, study.parameterPaths, sensMetric, sensEvents]);

  const sensBars: TornadoBar[] = sensRows
    .filter((r) => Number.isFinite(r.rho))
    .map((r) => ({
      label: r.path,
      rho: r.rho,
      n: r.n,
      significant: Number.isFinite(r.pValue) && r.pValue < 0.05,
    }));

  const sensN = sensRows.reduce((mx, r) => Math.max(mx, r.n), 0);
  const sensLowerBetter =
    sensMetric === "objective"
      ? study.objectiveDirection === "minimize"
      : (EVENT_RANK_METRICS.find((m) => m.key === sensMetric)?.lowerBetter ?? false);
```

- [ ] **Step 5: Add the JSX section** immediately after the charts conditional block closes (after line ~460 `)}`, before the `{/* Rank-by control ... */}` comment at line ~462):

```tsx
          {/* Parameter sensitivity (post-hoc; completed studies only). */}
          {study.status === "done" && (
            <div className="rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#2A2C32] px-2 py-1">
                <span className="text-[10px] uppercase tracking-wider text-[#9097A0]">
                  parameter sensitivity
                </span>
                <select
                  aria-label="Sensitivity metric"
                  value={sensMetric}
                  onChange={(e) => setSensMetric(e.target.value as RankDim)}
                  className="rounded-sm border border-[#2A2C32] bg-[#0B0B0D] px-2 py-1 font-mono text-[11px] text-[#D8DCE2] focus:border-[#FFC627] focus:outline-none"
                >
                  <option value="objective">objective ({study.params.objective.metric})</option>
                  {EVENT_RANK_METRICS.map((m) => (
                    <option key={m.key} value={m.key}>
                      event · {m.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="p-2">
                {sensBars.length === 0 ? (
                  <p className="text-[11px] text-[#9097A0]">
                    {POINTS_METRIC_KEYS.includes(sensMetric as EventMetricKey)
                      ? "Points metrics need a reference baseline (set it on the Performance tab)."
                      : "Not enough varied trials to estimate sensitivity."}
                  </p>
                ) : (
                  <>
                    <TornadoChart bars={sensBars} />
                    <p className="mt-1 text-[10px] text-[#5A5F66]">
                      Spearman rank-correlation of each tunable vs the selected metric (raw value), n=
                      {sensN}. Faded bars are not significant at p&lt;0.05.{" "}
                      {sensLowerBetter ? "Lower is better." : "Higher is better."}
                      {sensN < 12 ? " Low sample count — interpret with caution." : ""}
                    </p>
                  </>
                )}
              </div>
            </div>
          )}
```

- [ ] **Step 6: Run the new tests + the full existing suite for this component**

Run: `cd apps/desktop && pnpm exec vitest run src/modules/cfd/__tests__/OptimizationResults.test.tsx`
Expected: PASS — the two new sensitivity tests AND every pre-existing test (no regressions to podium/table/rank-by assertions).

- [ ] **Step 7: Typecheck**

Run: `cd apps/desktop && pnpm typecheck`
Expected: clean (no errors).

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/modules/cfd/results/OptimizationResults.tsx apps/desktop/src/modules/cfd/__tests__/OptimizationResults.test.tsx
git commit -m "feat(cfd): post-hoc parameter sensitivity tornado in optimization results"
```

---

### Task 5: Changelog + manual verification

**Files:**
- Create: `v2_changes/50-cfd-phase-4-sensitivity-tornado.md`

- [ ] **Step 1: Write the changelog entry**

```markdown
# 50 — CFD Phase 4: post-hoc parameter sensitivity (tornado)

A new "Parameter sensitivity" panel on the optimization results screen ranks
each tunable by how strongly it drives a chosen metric — the backend objective
or any FSAE event metric (accel / autocross / endurance time, endurance /
efficiency / total points). It is **post-hoc** (completed studies only) and
mined entirely from the trials already stored: no extra sim runs, no backend.

- **Spearman rank-correlation** (tie-corrected) of each parameter vs the metric,
  rendered as a horizontal tornado (bars sorted by |ρ|, positive right/gold,
  negative left/blue) over the fixed [-1, 1] correlation domain.
- **Honest about noise** (answering the earlier "meaningless at 20-40 trials"
  concern): every estimate shows its sample count `n`, bars that are not
  significant at p<0.05 are faded, and a low-n caveat appears below n=12.
- Reuses the existing `computeEvents` scoring path; points metrics show the
  standard "needs baselines (Performance tab)" message until a reference
  baseline is set.

Files: `lib/analytics/sensitivityStats.ts`, `components/charts/TornadoChart.tsx`,
`results/OptimizationResults.tsx`.
```

- [ ] **Step 2: Commit**

```bash
git add v2_changes/50-cfd-phase-4-sensitivity-tornado.md
git commit -m "docs(cfd): changelog for Phase 4 sensitivity tornado"
```

- [ ] **Step 3: Manual verification in the running app**

The dev server is already running (`pnpm dev`). In the app:
1. Open the **CFD** tab → run or open a completed **optimization** study (e.g. on `sdm26.json`) with ≥2 varied tunables.
2. Confirm a **"parameter sensitivity"** panel appears below the parallel-coordinates chart with a **Sensitivity metric** selector.
3. Switch the selector between `objective` and the event metrics; confirm bars re-sort and re-sign, and that `endurance pts` / `total pts` show the baseline message until "Load 2026 reference" is set on the Performance tab.
4. Confirm faded bars + the `n=…` caveat line render, and that no `NaN` appears in the chart.

- [ ] **Step 4: Full CFD suite green (pre-merge gate)**

Run: `cd apps/desktop && pnpm exec vitest run src/modules/cfd`
Expected: all CFD tests pass (the prior 354+ plus the new sensitivity/tornado tests).

---

## Self-review checklist (completed)

- **Spec coverage:** the competition-events design's P4 line ("Post-hoc sensitivity tornado — Spearman of each tunable vs any (incl. new event) metric, mined from existing trials") maps to Tasks 1–4; the analytics-veto concern is answered by the gating + significance + low-n caveat (Design decision 1, Task 4 Step 5, Task 5).
- **No placeholders:** every code step contains complete code; commands have expected output.
- **Type consistency:** `SensitivityRow`/`SensitivitySample`/`TornadoBar` field names (`path`, `rho`, `n`, `pValue`, `label`, `significant`) are used identically across Tasks 1–4; `computeSensitivity(paths, samples)` signature matches its callers; `RankDim` (`"objective" | EventMetricKey`) is reused for the new selector exactly as the existing "Rank by" control uses it.
- **Reuse verified against source:** `correlation` (Pearson) exists in `packages/lib/src/statistics.ts` and is exported via `@helios/lib`; `useElementWidth(ref, 600)` signature confirmed; `makeOptimizationStudy`/`makeTrial`/`makeSweepPoint` fixtures and the `vi.mock("../state/CfdContext")` harness confirmed in the existing test files.
