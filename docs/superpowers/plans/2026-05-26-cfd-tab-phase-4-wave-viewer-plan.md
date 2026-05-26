# CFD Tab — Phase 4 Wave-Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Light up the animated wave-frame viewer that Phase 3 left a placeholder for. Two views in one modal: anatomical engine schematic (cells colored + sized by field, cylinders sized by pressure) and per-pipe x-t waterfall. Sweep studies get an RPM dropdown.

**Architecture:** New JSONL-aware Tauri command (`cfd_load_waves`) sibling to existing `cfd_load_capture`. Frontend reads manifest + frames once, packs into typed arrays, renders to HTML5 Canvas in a `requestAnimationFrame` loop. No backend math changes; no parity test impact.

**Tech Stack:** Rust 1.x · Tauri 2 · React 18 + TypeScript · HTML5 Canvas 2D · Vitest · pnpm/Turbo.

**Spec:** `docs/superpowers/specs/2026-05-26-cfd-tab-phase-4-wave-viewer-design.md` (read this first if unfamiliar).

**Branch policy:** Land directly on the current working branch (`physics-fixes/math-corrections` or a successor); no worktree required for this UI-only work. The pre-commit hook runs the physics parity suite and must stay green on every commit — none of the changes here touch physics math, so this is a free check.

---

## Wave 1 — Foundations (pure logic, no UI, fully TDD)

These four files have zero dependencies on React, Canvas, or Tauri. They get built and unit-tested first so the renderers have a solid base to import from.

### Task 1: Add TypeScript types

**Files:**
- Modify `apps/desktop/src/modules/cfd/state/types.ts`

These types mirror the Rust serde shapes already produced by `WaveFrameWriter`. No new tests for this task — it's pure type definitions consumed by every subsequent task.

- [ ] **Step 1: Open `apps/desktop/src/modules/cfd/state/types.ts`.** Find the `PipeRole` type (already declared from Phase 3's `PipeProfileArtifact`). The new types go in a `// --- Wave viewer (Phase 4) ---` section near the bottom, before any exports of pre-existing study summaries.

- [ ] **Step 2: Append the new types.**

```ts
// --- Wave viewer (Phase 4) ---

export type WaveField = "p" | "u" | "T" | "rho" | "Mach";
export type WaveSizeField = "p" | "u" | "T" | "rho";  // Mach not allowed for size
export type WaveCylField = "x_b" | "p" | "T";

export interface WavePipeMeta {
  role: PipeRole;
  label: string;
  nCells: number;
  lengthM: number;
  index: number;
}

export interface WaveFrameManifest {
  jobId: string;
  rpm: number;
  nPipes: number;
  pipes: WavePipeMeta[];
  nCylinders: number;
  stepStride: number;
  fields: string[];               // always ["rho", "u", "p", "T"]
  frameCount: number;
  thetaStartDeg: number;
  thetaEndDeg: number;
  capturedCycle: number;
  incomplete: boolean;
}

/** Raw on-disk frame shape. Only used during the loader's parse step. */
export interface RawWaveFrame {
  theta: number;
  tMs: number;
  /** pipes[pipeIdx][fieldIdx][cellIdx]; fieldIdx is 0=rho, 1=u, 2=p, 3=T. */
  pipes: [number[], number[], number[], number[]][];
  cyl: { v: number; p: number; t: number; xB: number }[];
}

/** In-memory packed shape consumed by the renderers. Built once per load. */
export interface WaveCapturePacked {
  manifest: WaveFrameManifest;
  /** length = frameCount */
  theta: Float32Array;
  /** length = frameCount */
  tMs: Float32Array;
  /** pipeArr[pipeIdx][fieldIdx] = Float32Array(frameCount * nCells), row-major [frame][cell]. */
  pipeArr: Float32Array[][];
  /** cylArr[cylIdx][fieldIdx] = Float32Array(frameCount). fields: 0=V, 1=p, 2=T, 3=xB. */
  cylArr: Float32Array[][];
  /** Per-(pipe, field) min/max over the whole cycle, for colormap auto-range. */
  pipeRange: { min: number; max: number }[][];
  /** Per-(cyl, field) min/max. */
  cylRange: { min: number; max: number }[][];
}
```

- [ ] **Step 3: Verify it type-checks.**

Run: `pnpm --filter @helios/desktop typecheck` (from repo root).
Expected: zero new errors. If `PipeRole` import shape doesn't match what you expect, grep `apps/desktop/src/modules/cfd/state/types.ts` for the existing `PipeRole` declaration and reuse it as-is.

- [ ] **Step 4: Commit.**

```bash
git add apps/desktop/src/modules/cfd/state/types.ts
git commit -m "feat(cfd): wave-viewer TS types (Phase 4)"
```

---

### Task 2: Colormaps module + tests

**Files:**
- Create `apps/desktop/src/modules/cfd/results/wave-viewer/colormaps.ts`
- Create `apps/desktop/src/modules/cfd/results/wave-viewer/__tests__/colormaps.test.ts`

Three 256-entry RGB LUTs (`RdBu_r`, `inferno`, `viridis`) shared across the five fields per spec §3.4. We hard-code coefficient tables and synthesize the LUTs at module load.

- [ ] **Step 1: Write the failing test.** Create `colormaps.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { COLORMAPS, sampleColormap } from "../colormaps";

describe("colormaps", () => {
  it("ships RdBu_r, inferno, viridis as 256-entry LUTs", () => {
    for (const name of ["RdBu_r", "inferno", "viridis"] as const) {
      const lut = COLORMAPS[name];
      expect(lut).toHaveLength(256);
      for (const rgb of lut) {
        expect(rgb).toHaveLength(3);
        for (const c of rgb) {
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThanOrEqual(255);
        }
      }
    }
  });

  it("RdBu_r is blue at 0, white-ish near 0.5, red at 1", () => {
    const low = sampleColormap("RdBu_r", 0);
    const mid = sampleColormap("RdBu_r", 0.5);
    const high = sampleColormap("RdBu_r", 1);
    // blue end has more blue than red
    expect(low[2]).toBeGreaterThan(low[0]);
    // red end has more red than blue
    expect(high[0]).toBeGreaterThan(high[2]);
    // midpoint is light (all channels high-ish)
    expect(mid[0] + mid[1] + mid[2]).toBeGreaterThan(500);
  });

  it("inferno is dark at 0 and bright at 1", () => {
    const low = sampleColormap("inferno", 0);
    const high = sampleColormap("inferno", 1);
    expect(low[0] + low[1] + low[2]).toBeLessThan(60);
    expect(high[0] + high[1] + high[2]).toBeGreaterThan(500);
  });

  it("viridis is purple at 0 and yellow at 1", () => {
    const low = sampleColormap("viridis", 0);
    const high = sampleColormap("viridis", 1);
    // low: dominant blue
    expect(low[2]).toBeGreaterThan(low[1]);
    // high: dominant green+red (yellow)
    expect(high[0] + high[1]).toBeGreaterThan(2 * high[2]);
  });

  it("clamps out-of-range inputs", () => {
    expect(sampleColormap("viridis", -1)).toEqual(sampleColormap("viridis", 0));
    expect(sampleColormap("viridis", 2)).toEqual(sampleColormap("viridis", 1));
    expect(sampleColormap("viridis", Number.NaN)).toEqual(sampleColormap("viridis", 0));
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `pnpm --filter @helios/desktop test -- colormaps`
Expected: FAIL with "Cannot find module '../colormaps'".

- [ ] **Step 3: Implement `colormaps.ts`.**

Use matplotlib's segmented colormap data. For brevity we use a 4-point spline per channel and interpolate to 256 entries. The simpler alternative is hard-coded 256-entry tables — pick that to avoid floating-point drift between platforms. Source the entries from matplotlib's `_cm.py` (RdBu, inferno, viridis colormap data is BSD-licensed; copying tables is fine; do not copy code). The viridis and inferno data are listed as RGB triples in matplotlib's `_cm_listed.py`. For RdBu_r, reverse the RdBu listing.

If hard-coding 768 floats per map feels heavy, an acceptable alternative is to compute the LUT from a compact 5-9 point control set and linearly interpolate. Pick whichever is cleaner; either approach passes the tests above.

Skeleton:

```ts
// colormaps.ts
//
// Three perceptually-uniform colormaps used by the wave viewer.
// Data ported from matplotlib (BSD); see spec §3.4.
//
// LUTs are 256-entry [R, G, B] arrays with channels in 0..255 (sRGB byte).

export type ColormapName = "RdBu_r" | "inferno" | "viridis";

type RGB = [number, number, number];

// 256-entry LUTs. Build once at module load.
function buildLut(controlPoints: Array<{ t: number; rgb: RGB }>): RGB[] {
  const out: RGB[] = new Array(256);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    // find bracketing control points
    let lo = 0;
    while (lo < controlPoints.length - 1 && controlPoints[lo + 1].t < t) lo++;
    const a = controlPoints[lo];
    const b = controlPoints[Math.min(lo + 1, controlPoints.length - 1)];
    const span = b.t - a.t || 1;
    const f = (t - a.t) / span;
    out[i] = [
      Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f),
      Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f),
      Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f),
    ];
  }
  return out;
}

// Control points from matplotlib defaults. Keep 9 points per map — enough
// fidelity for the test assertions and visually smooth at 256 entries.
const RDBU_R_CTRL: Array<{ t: number; rgb: RGB }> = [
  { t: 0.000, rgb: [ 5,  48,  97] },   // dark blue
  { t: 0.125, rgb: [33, 102, 172] },
  { t: 0.250, rgb: [67, 147, 195] },
  { t: 0.375, rgb: [146, 197, 222] },
  { t: 0.500, rgb: [247, 247, 247] },  // white-ish midpoint
  { t: 0.625, rgb: [253, 219, 199] },
  { t: 0.750, rgb: [244, 165, 130] },
  { t: 0.875, rgb: [214,  96,  77] },
  { t: 1.000, rgb: [103,   0,  31] },  // dark red
];

const INFERNO_CTRL: Array<{ t: number; rgb: RGB }> = [
  { t: 0.000, rgb: [  0,   0,   4] },
  { t: 0.125, rgb: [ 31,  12,  72] },
  { t: 0.250, rgb: [ 85,  15, 109] },
  { t: 0.375, rgb: [136,  34, 106] },
  { t: 0.500, rgb: [186,  54,  85] },
  { t: 0.625, rgb: [227,  89,  51] },
  { t: 0.750, rgb: [249, 140,  10] },
  { t: 0.875, rgb: [249, 201,  50] },
  { t: 1.000, rgb: [252, 255, 164] },
];

const VIRIDIS_CTRL: Array<{ t: number; rgb: RGB }> = [
  { t: 0.000, rgb: [ 68,   1,  84] },
  { t: 0.125, rgb: [ 71,  44, 122] },
  { t: 0.250, rgb: [ 59,  81, 139] },
  { t: 0.375, rgb: [ 44, 113, 142] },
  { t: 0.500, rgb: [ 33, 144, 141] },
  { t: 0.625, rgb: [ 39, 173, 129] },
  { t: 0.750, rgb: [ 92, 200,  99] },
  { t: 0.875, rgb: [170, 220,  50] },
  { t: 1.000, rgb: [253, 231,  37] },
];

export const COLORMAPS: Record<ColormapName, RGB[]> = {
  RdBu_r: buildLut(RDBU_R_CTRL),
  inferno: buildLut(INFERNO_CTRL),
  viridis: buildLut(VIRIDIS_CTRL),
};

/** Sample a colormap at normalized t ∈ [0, 1]. NaN and out-of-range clamp. */
export function sampleColormap(name: ColormapName, t: number): RGB {
  if (Number.isNaN(t)) return COLORMAPS[name][0];
  const clamped = Math.max(0, Math.min(1, t));
  const idx = Math.min(255, Math.max(0, Math.round(clamped * 255)));
  return COLORMAPS[name][idx];
}
```

- [ ] **Step 4: Run tests to verify they pass.**

Run: `pnpm --filter @helios/desktop test -- colormaps`
Expected: all 5 cases PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/modules/cfd/results/wave-viewer/colormaps.ts \
        apps/desktop/src/modules/cfd/results/wave-viewer/__tests__/colormaps.test.ts
git commit -m "feat(cfd): 3 colormaps (RdBu_r, inferno, viridis) for wave viewer"
```

---

### Task 3: Fields module + tests

**Files:**
- Create `apps/desktop/src/modules/cfd/results/wave-viewer/fields.ts`
- Create `apps/desktop/src/modules/cfd/results/wave-viewer/__tests__/fields.test.ts`

Per-field metadata: which colormap, reference centering (pressure→atm, velocity→0), unit labels. Plus `computeMach` and `computeRange` helpers (sequential vs centered).

- [ ] **Step 1: Write the failing test.**

```ts
// fields.test.ts
import { describe, expect, it } from "vitest";
import {
  WAVE_FIELD_META,
  computeMach,
  fieldRange,
  GAMMA_AIR,
  R_AIR,
  P_ATM,
} from "../fields";

describe("WAVE_FIELD_META", () => {
  it("has entries for every WaveField", () => {
    for (const k of ["p", "u", "T", "rho", "Mach"] as const) {
      expect(WAVE_FIELD_META[k]).toBeDefined();
      expect(WAVE_FIELD_META[k].label).toBeTruthy();
      expect(WAVE_FIELD_META[k].unit).toBeTruthy();
      expect(WAVE_FIELD_META[k].colormap).toBeDefined();
    }
  });

  it("centers pressure at atmospheric and velocity at zero", () => {
    expect(WAVE_FIELD_META.p.centerOn).toBe(P_ATM);
    expect(WAVE_FIELD_META.u.centerOn).toBe(0);
    expect(WAVE_FIELD_META.T.centerOn).toBeNull();
    expect(WAVE_FIELD_META.rho.centerOn).toBeNull();
    expect(WAVE_FIELD_META.Mach.centerOn).toBeNull();
  });
});

describe("computeMach", () => {
  it("matches u / sqrt(gamma R T) for known inputs", () => {
    const u = 100; // m/s
    const T = 300; // K
    const c = Math.sqrt(GAMMA_AIR * R_AIR * T);
    expect(computeMach(u, T)).toBeCloseTo(u / c, 6);
  });
  it("returns 0 when T <= 0 (guard)", () => {
    expect(computeMach(100, 0)).toBe(0);
    expect(computeMach(100, -5)).toBe(0);
  });
  it("supports negative velocity (reverse flow)", () => {
    expect(computeMach(-100, 300)).toBeLessThan(0);
  });
});

describe("fieldRange", () => {
  it("returns symmetric ±max(|min-ref|, |max-ref|) for centered fields", () => {
    const r = fieldRange("p", { min: P_ATM - 5000, max: P_ATM + 8000 });
    expect(r.vmin).toBeCloseTo(P_ATM - 8000);
    expect(r.vmax).toBeCloseTo(P_ATM + 8000);
  });
  it("returns [min, max] for sequential fields", () => {
    const r = fieldRange("T", { min: 300, max: 1800 });
    expect(r.vmin).toBe(300);
    expect(r.vmax).toBe(1800);
  });
  it("returns [0, max] for Mach", () => {
    const r = fieldRange("Mach", { min: -0.1, max: 0.6 });
    expect(r.vmin).toBe(0);
    expect(r.vmax).toBe(0.6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `pnpm --filter @helios/desktop test -- fields`
Expected: FAIL "Cannot find module '../fields'".

- [ ] **Step 3: Implement `fields.ts`.**

```ts
// fields.ts
//
// Per-field metadata + derived-field math for the wave viewer.

import type { WaveField } from "../../state/types";
import type { ColormapName } from "./colormaps";

export const GAMMA_AIR = 1.4;
export const R_AIR = 287.0;           // J / (kg·K)
export const P_ATM = 101325.0;        // Pa

export interface WaveFieldMeta {
  label: string;                       // shown in selectors
  unit: string;                        // shown in legend
  colormap: ColormapName;
  /** If non-null, the colormap is centered on this value (RdBu_r-style). */
  centerOn: number | null;
  /** For derived fields like Mach, marks them so the loader knows. */
  derived?: boolean;
}

export const WAVE_FIELD_META: Record<WaveField, WaveFieldMeta> = {
  p:    { label: "pressure",    unit: "Pa",    colormap: "RdBu_r",  centerOn: P_ATM },
  u:    { label: "velocity",    unit: "m/s",   colormap: "RdBu_r",  centerOn: 0 },
  T:    { label: "temperature", unit: "K",     colormap: "inferno", centerOn: null },
  rho:  { label: "density",     unit: "kg/m³", colormap: "viridis", centerOn: null },
  Mach: { label: "Mach",        unit: "-",     colormap: "viridis", centerOn: null, derived: true },
};

/**
 * Mach number from cell-local velocity and temperature.
 * Returns 0 for T ≤ 0 (sentinel) to avoid NaN from sqrt of non-positive T.
 */
export function computeMach(u: number, T: number): number {
  if (T <= 0) return 0;
  return u / Math.sqrt(GAMMA_AIR * R_AIR * T);
}

/**
 * Compute the (vmin, vmax) for a field given its observed min/max.
 * - centered fields (p, u): symmetric around centerOn
 * - Mach: [0, max] (negative Mach is allowed in data but rare; the viewer
 *   shows magnitude on a sequential map. If you want signed Mach, use u.)
 * - everything else: [min, max] as observed
 */
export function fieldRange(
  field: WaveField,
  observed: { min: number; max: number },
): { vmin: number; vmax: number } {
  if (field === "Mach") {
    return { vmin: 0, vmax: observed.max };
  }
  const meta = WAVE_FIELD_META[field];
  if (meta.centerOn != null) {
    const c = meta.centerOn;
    const half = Math.max(Math.abs(observed.min - c), Math.abs(observed.max - c));
    return { vmin: c - half, vmax: c + half };
  }
  return { vmin: observed.min, vmax: observed.max };
}
```

- [ ] **Step 4: Run tests to verify they pass.**

Run: `pnpm --filter @helios/desktop test -- fields`
Expected: all PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/modules/cfd/results/wave-viewer/fields.ts \
        apps/desktop/src/modules/cfd/results/wave-viewer/__tests__/fields.test.ts
git commit -m "feat(cfd): wave-viewer field metadata + Mach derivation"
```

---

### Task 4: Schematic layout module + tests

**Files:**
- Create `apps/desktop/src/modules/cfd/results/wave-viewer/layout.ts`
- Create `apps/desktop/src/modules/cfd/results/wave-viewer/__tests__/layout.test.ts`

Pure function: given a `WaveFrameManifest` and canvas dimensions, return rectangles for each pipe + cylinder column X centers. Drives the `SchematicView` renderer.

- [ ] **Step 1: Write the failing test.**

```ts
// layout.test.ts
import { describe, expect, it } from "vitest";
import { layoutSchematic, type SchematicLayout } from "../layout";
import type { WaveFrameManifest, WavePipeMeta } from "../../../state/types";

function makeManifest(pipes: WavePipeMeta[], nCylinders: number): WaveFrameManifest {
  return {
    jobId: "test",
    rpm: 8000,
    nPipes: pipes.length,
    pipes,
    nCylinders,
    stepStride: 200,
    fields: ["rho", "u", "p", "T"],
    frameCount: 600,
    thetaStartDeg: 0,
    thetaEndDeg: 720,
    capturedCycle: 1,
    incomplete: false,
  };
}

const SDM26_PIPES: WavePipeMeta[] = [
  { role: "plenum",    label: "plenum",      nCells: 60, lengthM: 0.30, index: 0 },
  { role: "runner",    label: "runner_1",    nCells: 20, lengthM: 0.10, index: 1 },
  { role: "runner",    label: "runner_2",    nCells: 20, lengthM: 0.10, index: 2 },
  { role: "runner",    label: "runner_3",    nCells: 20, lengthM: 0.10, index: 3 },
  { role: "runner",    label: "runner_4",    nCells: 20, lengthM: 0.10, index: 4 },
  { role: "primary",   label: "primary_1",   nCells: 30, lengthM: 0.25, index: 5 },
  { role: "primary",   label: "primary_2",   nCells: 30, lengthM: 0.25, index: 6 },
  { role: "primary",   label: "primary_3",   nCells: 30, lengthM: 0.25, index: 7 },
  { role: "primary",   label: "primary_4",   nCells: 30, lengthM: 0.25, index: 8 },
  { role: "secondary", label: "secondary_1", nCells: 30, lengthM: 0.30, index: 9 },
  { role: "secondary", label: "secondary_2", nCells: 30, lengthM: 0.30, index: 10 },
  { role: "collector", label: "collector",   nCells: 40, lengthM: 0.40, index: 11 },
];

describe("layoutSchematic", () => {
  it("produces 6 tiers for SDM26-style 4-2-1", () => {
    const layout = layoutSchematic(makeManifest(SDM26_PIPES, 4), 1600, 900);
    expect(layout.tiers).toHaveLength(6); // plenum, runners, cyl, primaries, secondaries, collector
    expect(layout.cylinderCenters).toHaveLength(4);
  });

  it("aligns cylinder X-centers with runner and primary column centers", () => {
    const layout = layoutSchematic(makeManifest(SDM26_PIPES, 4), 1600, 900);
    const runnerTier = layout.tiers.find((t) => t.kind === "vert-pipes" && t.role === "runner")!;
    const primaryTier = layout.tiers.find((t) => t.kind === "vert-pipes" && t.role === "primary")!;
    expect(runnerTier).toBeDefined();
    expect(primaryTier).toBeDefined();
    if (runnerTier.kind !== "vert-pipes" || primaryTier.kind !== "vert-pipes") throw new Error();
    expect(runnerTier.pipeRects).toHaveLength(4);
    expect(primaryTier.pipeRects).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      const runnerCx = runnerTier.pipeRects[i].x + runnerTier.pipeRects[i].w / 2;
      const primaryCx = primaryTier.pipeRects[i].x + primaryTier.pipeRects[i].w / 2;
      const cylCx = layout.cylinderCenters[i];
      expect(Math.abs(runnerCx - cylCx)).toBeLessThan(1);
      expect(Math.abs(primaryCx - cylCx)).toBeLessThan(1);
    }
  });

  it("collapses missing secondary tier for 1-cyl 1-1 engine", () => {
    const pipes: WavePipeMeta[] = [
      { role: "plenum",    label: "plenum",    nCells: 30, lengthM: 0.15, index: 0 },
      { role: "runner",    label: "runner_1",  nCells: 15, lengthM: 0.10, index: 1 },
      { role: "primary",   label: "primary_1", nCells: 25, lengthM: 0.20, index: 2 },
      { role: "collector", label: "collector", nCells: 25, lengthM: 0.30, index: 3 },
    ];
    const layout = layoutSchematic(makeManifest(pipes, 1), 1600, 900);
    expect(layout.tiers).toHaveLength(5); // no secondary
    expect(layout.cylinderCenters).toHaveLength(1);
  });

  it("returns tier rects that don't overlap and fit in canvas", () => {
    const W = 1600, H = 900;
    const layout = layoutSchematic(makeManifest(SDM26_PIPES, 4), W, H);
    let prevBottom = 0;
    for (const t of layout.tiers) {
      expect(t.bounds.y).toBeGreaterThanOrEqual(prevBottom - 1e-6);
      expect(t.bounds.y + t.bounds.h).toBeLessThanOrEqual(H + 1e-6);
      expect(t.bounds.x).toBeGreaterThanOrEqual(0);
      expect(t.bounds.x + t.bounds.w).toBeLessThanOrEqual(W + 1e-6);
      prevBottom = t.bounds.y + t.bounds.h;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `pnpm --filter @helios/desktop test -- layout`
Expected: FAIL "Cannot find module '../layout'".

- [ ] **Step 3: Implement `layout.ts`.**

```ts
// layout.ts
//
// Pure layout function for the schematic view. Given a manifest +
// canvas size, produces tier-by-tier bounding rects and cylinder column
// X centers. Renderer reads this and draws cells inside each pipe rect.

import type { WaveFrameManifest, WavePipeMeta } from "../../state/types";

export interface Rect { x: number; y: number; w: number; h: number; }

export type SchematicTier =
  | { kind: "horiz-pipe";    role: "plenum" | "collector"; bounds: Rect; pipe: WavePipeMeta; pipeRect: Rect }
  | { kind: "vert-pipes";    role: "runner" | "primary" | "secondary"; bounds: Rect; pipeRects: Rect[]; pipes: WavePipeMeta[] }
  | { kind: "cyl-row";       bounds: Rect };

export interface SchematicLayout {
  tiers: SchematicTier[];
  /** X-center for each cylinder column. Length === nCylinders. */
  cylinderCenters: number[];
  /** Cylinder Y center (where the cyl-row tier sits, vertically centered). */
  cylinderRowY: number;
  /** Radius used as the cylinder "base" radius before pressure scaling. */
  cylinderBaseR: number;
  width: number;
  height: number;
}

const PAD_X = 24;
const PAD_Y = 16;
const PIPE_STROKE = 1;

interface TierWeight { kind: SchematicTier["kind"]; role?: SchematicTier extends { role: infer R } ? R : never; pipes?: WavePipeMeta[]; pipe?: WavePipeMeta; weight: number; }

export function layoutSchematic(
  manifest: WaveFrameManifest,
  width: number,
  height: number,
): SchematicLayout {
  const by = groupByRole(manifest.pipes);
  const plenum = by.plenum[0];
  const collector = by.collector[0];
  const runners = by.runner;
  const primaries = by.primary;
  const secondaries = by.secondary;
  const nCyl = manifest.nCylinders;

  const tierDefs: TierWeight[] = [];
  if (plenum)                tierDefs.push({ kind: "horiz-pipe", pipe: plenum,    weight: 1 });
  if (runners.length > 0)    tierDefs.push({ kind: "vert-pipes", pipes: runners,   weight: 2 });
  /* cyl row */              tierDefs.push({ kind: "cyl-row",                       weight: 1 });
  if (primaries.length > 0)  tierDefs.push({ kind: "vert-pipes", pipes: primaries, weight: 2 });
  if (secondaries.length > 0) tierDefs.push({ kind: "vert-pipes", pipes: secondaries, weight: 2 });
  if (collector)             tierDefs.push({ kind: "horiz-pipe", pipe: collector,  weight: 1 });

  const totalWeight = tierDefs.reduce((s, t) => s + t.weight, 0);
  const innerH = height - 2 * PAD_Y;
  const innerW = width - 2 * PAD_X;

  // Cylinder X centers: nCyl evenly-spaced columns across innerW.
  const colW = innerW / nCyl;
  const cylinderCenters: number[] = [];
  for (let i = 0; i < nCyl; i++) {
    cylinderCenters.push(PAD_X + colW * (i + 0.5));
  }

  const tiers: SchematicTier[] = [];
  let yCursor = PAD_Y;
  let cylinderRowY = height / 2;
  let cylinderBaseR = 16;

  for (const def of tierDefs) {
    const tierH = innerH * (def.weight / totalWeight);
    const bounds: Rect = { x: PAD_X, y: yCursor, w: innerW, h: tierH };

    if (def.kind === "horiz-pipe" && def.pipe) {
      // Horizontal pipe: full width, centered vertically in the tier.
      const pipeH = Math.max(12, tierH * 0.6);
      const pipeRect: Rect = {
        x: PAD_X, y: yCursor + (tierH - pipeH) / 2,
        w: innerW, h: pipeH,
      };
      const role = def.pipe.role as "plenum" | "collector";
      tiers.push({ kind: "horiz-pipe", role, bounds, pipe: def.pipe, pipeRect });
    } else if (def.kind === "vert-pipes" && def.pipes) {
      // Vertical pipes: one per cylinder column (for runner/primary) OR
      // arranged across innerW for secondaries.
      const role = def.pipes[0].role as "runner" | "primary" | "secondary";
      const pipeRects: Rect[] = [];
      if (role === "runner" || role === "primary") {
        // Align with cylinder columns
        const stripW = Math.min(32, colW * 0.4);
        for (let i = 0; i < def.pipes.length; i++) {
          const cx = cylinderCenters[i] ?? (PAD_X + colW * (i + 0.5));
          pipeRects.push({
            x: cx - stripW / 2,
            y: yCursor + tierH * 0.1,
            w: stripW,
            h: tierH * 0.8,
          });
        }
      } else {
        // Secondaries: evenly spaced across the row
        const m = def.pipes.length;
        const stripW = Math.min(32, (innerW / m) * 0.35);
        for (let i = 0; i < m; i++) {
          const cx = PAD_X + (innerW / m) * (i + 0.5);
          pipeRects.push({
            x: cx - stripW / 2,
            y: yCursor + tierH * 0.1,
            w: stripW,
            h: tierH * 0.8,
          });
        }
      }
      tiers.push({ kind: "vert-pipes", role, bounds, pipeRects, pipes: def.pipes });
    } else if (def.kind === "cyl-row") {
      cylinderRowY = yCursor + tierH / 2;
      cylinderBaseR = Math.min(tierH * 0.35, colW * 0.30, 48);
      tiers.push({ kind: "cyl-row", bounds });
    }
    yCursor += tierH;
  }

  return { tiers, cylinderCenters, cylinderRowY, cylinderBaseR, width, height };
}

function groupByRole(pipes: WavePipeMeta[]): {
  plenum: WavePipeMeta[];
  runner: WavePipeMeta[];
  primary: WavePipeMeta[];
  secondary: WavePipeMeta[];
  collector: WavePipeMeta[];
} {
  const acc = { plenum: [], runner: [], primary: [], secondary: [], collector: [] } as ReturnType<typeof groupByRole>;
  for (const p of pipes) {
    (acc[p.role] as WavePipeMeta[]).push(p);
  }
  return acc;
}
```

- [ ] **Step 4: Run tests to verify they pass.**

Run: `pnpm --filter @helios/desktop test -- layout`
Expected: all 4 PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/modules/cfd/results/wave-viewer/layout.ts \
        apps/desktop/src/modules/cfd/results/wave-viewer/__tests__/layout.test.ts
git commit -m "feat(cfd): data-driven schematic tier layout for wave viewer"
```

---

## Wave 2 — Backend Tauri command

### Task 5: `cfd_load_waves` Tauri command + tests

**Files:**
- Modify `crates/cfd-core/src/load.rs` (add `load_waves_from_dir` pure-fn + tests)
- Modify `apps/desktop/src-tauri/src/cfd/commands.rs` (thin Tauri wrapper)
- Modify `apps/desktop/src-tauri/src/lib.rs` (register command)

Read `manifest.json` + `waves.jsonl` from the capture dir, parse line-by-line, return `{ manifest, frames }` as one JSON value. Per spec §1.2, first parse error aborts with the bad line number.

**Why pure-fn in `cfd_core::load` not `commands.rs`:** The existing comment at the bottom of [`commands.rs`](../../apps/desktop/src-tauri/src/cfd/commands.rs) explicitly states *"pure load logic + tests live in `cfd_core::load`. Tauri lib tests don't run on Windows/GNU (Tauri runtime DLL footprint causes STATUS_ENTRYPOINT_NOT_FOUND in the test binary)"*. Putting tests in `commands.rs` will fail to link. Follow the existing `load_config_from_path` pattern at [`load.rs:24`](../../crates/cfd-core/src/load.rs#L24).

- [ ] **Step 1: Write the failing test in `crates/cfd-core/src/load.rs`.** Append a new `#[cfg(test)] mod load_waves_tests` block alongside the existing `tests` module. Tests use `tempfile::tempdir` for the capture root and call the pure function directly.

```rust
// In crates/cfd-core/src/load.rs, alongside the existing tests module:

#[cfg(test)]
mod load_waves_tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use tempfile::TempDir;

    fn setup(job_id: &str, study_kind: &str, rpm_int: u32) -> (TempDir, std::path::PathBuf) {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path()
            .join("Helios").join("cfd").join("captures")
            .join(job_id).join(study_kind).join(rpm_int.to_string());
        fs::create_dir_all(&dir).unwrap();
        (tmp, dir)
    }

    fn write_manifest(dir: &std::path::Path, frame_count: u64) {
        let manifest = serde_json::json!({
            "jobId": "test-job",
            "rpm": 8000.0,
            "nPipes": 2,
            "pipes": [
                { "role": "plenum", "label": "plenum", "nCells": 4, "lengthM": 0.2, "index": 0 },
                { "role": "collector", "label": "collector", "nCells": 4, "lengthM": 0.3, "index": 1 }
            ],
            "nCylinders": 1,
            "stepStride": 100,
            "fields": ["rho", "u", "p", "T"],
            "frameCount": frame_count,
            "thetaStartDeg": 0.0,
            "thetaEndDeg": 720.0,
            "capturedCycle": 1,
            "incomplete": false
        });
        fs::write(dir.join("manifest.json"), serde_json::to_string_pretty(&manifest).unwrap()).unwrap();
    }

    fn write_waves_lines(dir: &std::path::Path, lines: &[&str]) {
        let mut f = fs::File::create(dir.join("waves.jsonl")).unwrap();
        for line in lines {
            writeln!(f, "{}", line).unwrap();
        }
    }

    fn frame_line() -> String {
        // One minimal frame: 2 pipes × 4 cells, 1 cylinder.
        let frame = serde_json::json!({
            "theta": 0.0, "t_ms": 0.0,
            "pipes": [
                [[1.0,1.0,1.0,1.0],[0.0,0.0,0.0,0.0],[101325.0,101325.0,101325.0,101325.0],[300.0,300.0,300.0,300.0]],
                [[1.0,1.0,1.0,1.0],[0.0,0.0,0.0,0.0],[101325.0,101325.0,101325.0,101325.0],[800.0,800.0,800.0,800.0]]
            ],
            "cyl": [{ "v": 5e-5, "p": 101325.0, "t": 300.0, "x_b": 0.0 }]
        });
        serde_json::to_string(&frame).unwrap()
    }

    #[test]
    fn happy_path_returns_manifest_and_frames() {
        let (tmp, dir) = setup("job-1", "single-rpm", 8000);
        write_manifest(&dir, 3);
        let l = frame_line();
        write_waves_lines(&dir, &[&l, &l, &l]);

        let root = tmp.path().join("Helios").join("cfd").join("captures");
        let v = load_waves_from_dir(&root, "job-1", "single-rpm", 8000).expect("ok");
        assert!(v.get("manifest").is_some());
        assert_eq!(v["frames"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn rejects_jsonl_parse_error_with_line_number() {
        let (tmp, dir) = setup("job-2", "single-rpm", 8000);
        write_manifest(&dir, 2);
        let l = frame_line();
        write_waves_lines(&dir, &[&l, "not json", &l]);

        let root = tmp.path().join("Helios").join("cfd").join("captures");
        let err = load_waves_from_dir(&root, "job-2", "single-rpm", 8000).unwrap_err();
        assert!(err.contains("line 2"), "got: {err}");
    }

    #[test]
    fn rejects_manifest_frame_count_mismatch() {
        let (tmp, dir) = setup("job-3", "single-rpm", 8000);
        write_manifest(&dir, 5);     // says 5
        let l = frame_line();
        write_waves_lines(&dir, &[&l, &l]); // only 2

        let root = tmp.path().join("Helios").join("cfd").join("captures");
        let err = load_waves_from_dir(&root, "job-3", "single-rpm", 8000).unwrap_err();
        assert!(err.contains("frame") && err.contains("2") && err.contains("5"), "got: {err}");
    }

    #[test]
    fn rejects_path_traversal_in_job_id() {
        let (tmp, _dir) = setup("job-4", "single-rpm", 8000);
        let root = tmp.path().join("Helios").join("cfd").join("captures");
        let err = load_waves_from_dir(&root, "../escape", "single-rpm", 8000).unwrap_err();
        assert!(err.contains("invalid"), "got: {err}");
    }

    #[test]
    fn rejects_invalid_study_kind() {
        let (tmp, _dir) = setup("job-5", "single-rpm", 8000);
        let root = tmp.path().join("Helios").join("cfd").join("captures");
        let err = load_waves_from_dir(&root, "job-5", "wat", 8000).unwrap_err();
        assert!(err.contains("study_kind"), "got: {err}");
    }

    #[test]
    fn tolerates_blank_jsonl_lines() {
        let (tmp, dir) = setup("job-6", "single-rpm", 8000);
        write_manifest(&dir, 2);
        let l = frame_line();
        // Trailing newline + a blank line in the middle.
        let mut f = fs::File::create(dir.join("waves.jsonl")).unwrap();
        writeln!(f, "{}", l).unwrap();
        writeln!(f, "").unwrap();
        writeln!(f, "{}", l).unwrap();
        let root = tmp.path().join("Helios").join("cfd").join("captures");
        let v = load_waves_from_dir(&root, "job-6", "single-rpm", 8000).expect("ok");
        assert_eq!(v["frames"].as_array().unwrap().len(), 2);
    }
}
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `cargo test -p cfd-core --lib load_waves`
Expected: FAIL "cannot find function `load_waves_from_dir`".

- [ ] **Step 3: Implement the pure function in `crates/cfd-core/src/load.rs`.**

Add to the top of the file (alongside `path_under` and `load_config_from_path`):

```rust
use std::io::{BufRead, BufReader};

/// Read manifest.json + every frame of waves.jsonl for one capture
/// directory under `capture_root`. Returns `{ manifest, frames }` as a
/// single JSON value (manifest passed through, frames as JSON array).
/// First parse error aborts with the 1-based line number; no partial
/// returns. Empty lines are tolerated and skipped.
///
/// `capture_root` is the absolute base — typically
/// `<Documents>/Helios/cfd/captures` — and the inner directory is built
/// as `<capture_root>/<job_id>/<study_kind>/<rpm_int>/`.
pub fn load_waves_from_dir(
    capture_root: &std::path::Path,
    job_id: &str,
    study_kind: &str,
    rpm_int: u32,
) -> Result<serde_json::Value, String> {
    if job_id.contains("..") || job_id.contains('/') || job_id.contains('\\') {
        return Err(format!("invalid job_id: {job_id}"));
    }
    match study_kind {
        "single-rpm" | "sweep" => {}
        _ => return Err(format!("invalid study_kind: {study_kind}")),
    }

    let dir = capture_root.join(job_id).join(study_kind).join(rpm_int.to_string());
    let manifest_path = dir.join("manifest.json");
    let waves_path = dir.join("waves.jsonl");

    if !manifest_path.exists() {
        return Err(format!("manifest not found: {}", manifest_path.display()));
    }
    if !waves_path.exists() {
        return Err(format!("waves.jsonl not found: {}", waves_path.display()));
    }

    let manifest_bytes = std::fs::read(&manifest_path)
        .map_err(|e| format!("read manifest: {e}"))?;
    let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| format!("parse manifest: {e}"))?;

    let frame_count_expected = manifest.get("frameCount")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "manifest missing frameCount".to_string())?;

    let f = std::fs::File::open(&waves_path)
        .map_err(|e| format!("open waves: {e}"))?;
    let reader = BufReader::new(f);
    let mut frames: Vec<serde_json::Value> = Vec::with_capacity(frame_count_expected as usize);

    for (idx, line_result) in reader.lines().enumerate() {
        let line = line_result.map_err(|e| format!("read line {}: {e}", idx + 1))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let v: serde_json::Value = serde_json::from_str(trimmed)
            .map_err(|e| format!("parse waves.jsonl line {}: {e}", idx + 1))?;
        frames.push(v);
    }

    if frames.len() as u64 != frame_count_expected {
        return Err(format!(
            "frame count mismatch: manifest says {frame_count_expected}, file has {}",
            frames.len()
        ));
    }

    Ok(serde_json::json!({ "manifest": manifest, "frames": frames }))
}
```

If `tempfile` isn't already a dev-dependency of `cfd-core`, add it under `[dev-dependencies]` in `crates/cfd-core/Cargo.toml`. (Check first with `grep tempfile crates/cfd-core/Cargo.toml` — it's likely already present from earlier capture tests.)

- [ ] **Step 4: Run tests to verify they pass.**

Run: `cargo test -p cfd-core --lib load_waves`
Expected: all 6 PASS.

- [ ] **Step 5: Add the thin Tauri wrapper to `apps/desktop/src-tauri/src/cfd/commands.rs`.**

Right after the existing `cfd_load_capture` function:

```rust
// ---------------- cfd_load_waves ----------------

/// JSONL-aware sibling of `cfd_load_capture`. Reads manifest + frames
/// from `<Documents>/Helios/cfd/captures/<job_id>/<study_kind>/<rpm_int>/`
/// and returns `{ manifest, frames }`. Pure logic lives in
/// `cfd_core::load::load_waves_from_dir`.
#[tauri::command]
pub fn cfd_load_waves(
    app: AppHandle,
    job_id: String,
    study_kind: String,
    rpm_int: u32,
) -> Result<serde_json::Value, String> {
    let docs = app
        .path()
        .document_dir()
        .map_err(|e| format!("document_dir: {e}"))?;
    let root = docs.join("Helios").join("cfd").join("captures");
    cfd_core::load::load_waves_from_dir(&root, &job_id, &study_kind, rpm_int)
}
```

Register in `apps/desktop/src-tauri/src/lib.rs` next to `cfd_load_capture`:

```rust
            cfd::commands::cfd_load_waves,
```

- [ ] **Step 6: Smoke-build the desktop lib.**

Run: `cargo check -p helios_desktop_lib` (substitute the real crate name from `apps/desktop/src-tauri/Cargo.toml` `[package].name`).
Expected: builds clean. Existing engine-sim 45-parity suite must remain untouched — confirm with `cargo test -p engine-sim --tests` if you're worried.

- [ ] **Step 7: Commit.**

```bash
git add crates/cfd-core/src/load.rs crates/cfd-core/Cargo.toml \
        apps/desktop/src-tauri/src/cfd/commands.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(cfd): load_waves_from_dir (cfd-core) + cfd_load_waves Tauri wrapper (Phase 4)"
```

---

## Wave 3 — Frontend data loader

### Task 6: `loadWaves` on the Tauri bridge + mock bridge

**Files:**
- Modify `apps/desktop/src/modules/cfd/lib/tauriBridge.ts` (real bridge)
- Modify `apps/desktop/src/modules/cfd/__tests__/fakes/tauri.ts` (shared mock — there is exactly one, used by every test that needs a bridge)

- [ ] **Step 1: Open the shared fake at [`__tests__/fakes/tauri.ts`](../../apps/desktop/src/modules/cfd/__tests__/fakes/tauri.ts).** Note how `loadCapture` is implemented (a configurable closure: `setLoadCapture(impl)` at line ~125 swaps the function the bridge returns). Mirror that pattern for `loadWaves`.

- [ ] **Step 2: Add `loadWaves` to the bridge interface (probably in `tauriBridge.ts` itself or a sibling `types.ts`).** Append:

```ts
// In the CfdBridge interface declaration:
loadWaves(
  jobId: string,
  studyKind: "single-rpm" | "sweep",
  rpmInt: number,
): Promise<unknown>;
```

(`unknown` keeps the bridge schema-free; the hook narrows the type.)

- [ ] **Step 3: Implement `loadWaves` on the real bridge.**

```ts
loadWaves: (jobId, studyKind, rpmInt) =>
  invoke<unknown>("cfd_load_waves", { jobId, studyKind, rpmInt }),
```

Sits next to `loadCapture` per pattern in [`tauriBridge.ts:63-69`](../../apps/desktop/src/modules/cfd/lib/tauriBridge.ts#L63-L69).

- [ ] **Step 4: Add `loadWaves` to the shared fake in [`__tests__/fakes/tauri.ts`](../../apps/desktop/src/modules/cfd/__tests__/fakes/tauri.ts).** Following the `loadCapture` pattern at line ~56 and the `setLoadCapture` setter at line ~125, add a sibling `loadWaves` closure + a `setLoadWaves(impl)` setter. The default closure throws `"loadWaves not configured"` so tests that touch it without configuring it get a clear error.

- [ ] **Step 5: Typecheck.**

Run: `pnpm --filter @helios/desktop typecheck`
Expected: zero errors.

Run the existing test suite to confirm no regressions:

Run: `pnpm --filter @helios/desktop test`
Expected: all green (`377+` tests).

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/src/modules/cfd/lib/tauriBridge.ts apps/desktop/src/modules/cfd/**/*.test.{ts,tsx}
git commit -m "feat(cfd): tauriBridge.loadWaves + mock stubs"
```

---

### Task 7: `useWaveCapture` hook + tests

**Files:**
- Create `apps/desktop/src/modules/cfd/results/wave-viewer/useWaveCapture.ts`
- Create `apps/desktop/src/modules/cfd/results/wave-viewer/__tests__/useWaveCapture.test.ts`

Loads + parses + packs `waves.jsonl` into the `WaveCapturePacked` shape. Manages loading state and cancellation.

- [ ] **Step 1: Write the failing test.**

```ts
// useWaveCapture.test.ts
import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useWaveCapture } from "../useWaveCapture";

function makeRawResponse() {
  const manifest = {
    jobId: "test", rpm: 8000, nPipes: 2, pipes: [
      { role: "plenum", label: "plenum", nCells: 3, lengthM: 0.2, index: 0 },
      { role: "collector", label: "collector", nCells: 3, lengthM: 0.3, index: 1 },
    ], nCylinders: 1, stepStride: 100,
    fields: ["rho", "u", "p", "T"], frameCount: 2,
    thetaStartDeg: 0, thetaEndDeg: 720, capturedCycle: 1, incomplete: false,
  };
  const frames = [
    {
      theta: 0, t_ms: 0,
      pipes: [
        [[1.0,1.0,1.0],[0.0,0.0,0.0],[101325,101325,101325],[300,300,300]],
        [[1.0,1.0,1.0],[0.0,0.0,0.0],[101325,101325,101325],[800,800,800]],
      ],
      cyl: [{ v: 5e-5, p: 101325, t: 300, x_b: 0 }],
    },
    {
      theta: 360, t_ms: 7.5,
      pipes: [
        [[1.2,1.1,1.0],[5.0,4.0,3.0],[110000,108000,105000],[320,315,310]],
        [[0.9,0.95,1.0],[-2.0,-1.0,0.0],[99000,100000,101000],[820,810,800]],
      ],
      cyl: [{ v: 4e-5, p: 250000, t: 1200, x_b: 0.5 }],
    },
  ];
  return { manifest, frames };
}

describe("useWaveCapture", () => {
  it("packs frames into typed arrays with correct ranges", async () => {
    const bridge = {
      loadWaves: vi.fn().mockResolvedValue(makeRawResponse()),
    } as any;

    const { result } = renderHook(() => useWaveCapture(bridge, "test", "single-rpm", 8000));

    await waitFor(() => expect(result.current.state).toBe("ready"));
    const d = result.current.data!;
    expect(d.manifest.frameCount).toBe(2);
    expect(d.theta).toBeInstanceOf(Float32Array);
    expect(d.theta).toHaveLength(2);
    expect(d.theta[0]).toBeCloseTo(0);
    expect(d.theta[1]).toBeCloseTo(360);
    // pipeArr[0][2] = pressure field of plenum pipe; row-major [frame][cell] across 2 frames × 3 cells = 6 entries
    expect(d.pipeArr[0][2]).toHaveLength(6);
    expect(d.pipeArr[0][2][0]).toBeCloseTo(101325);
    expect(d.pipeArr[0][2][5]).toBeCloseTo(105000);
    // ranges: pressure min/max across all frames in plenum
    expect(d.pipeRange[0][2].min).toBeCloseTo(101325);
    expect(d.pipeRange[0][2].max).toBeCloseTo(110000);
    // cylinder packed (field 1 = p)
    expect(d.cylArr[0][1]).toHaveLength(2);
    expect(d.cylArr[0][1][1]).toBeCloseTo(250000);
  });

  it("surfaces bridge errors", async () => {
    const bridge = {
      loadWaves: vi.fn().mockRejectedValue(new Error("boom")),
    } as any;
    const { result } = renderHook(() => useWaveCapture(bridge, "x", "single-rpm", 8000));
    await waitFor(() => expect(result.current.state).toBe("error"));
    expect(result.current.error).toContain("boom");
  });

  it("re-loads when (jobId, studyKind, rpmInt) changes", async () => {
    const bridge = {
      loadWaves: vi.fn().mockResolvedValue(makeRawResponse()),
    } as any;
    const { result, rerender } = renderHook(
      ({ rpm }: { rpm: number }) => useWaveCapture(bridge, "test", "single-rpm", rpm),
      { initialProps: { rpm: 8000 } },
    );
    await waitFor(() => expect(result.current.state).toBe("ready"));
    rerender({ rpm: 10000 });
    await waitFor(() => expect(bridge.loadWaves).toHaveBeenCalledTimes(2));
  });

  it("ignores results that arrived after a re-render", async () => {
    let resolveFirst!: (v: unknown) => void;
    const firstPromise = new Promise<unknown>((r) => { resolveFirst = r; });
    const bridge = {
      loadWaves: vi.fn()
        .mockImplementationOnce(() => firstPromise)
        .mockResolvedValueOnce(makeRawResponse()),
    } as any;
    const { result, rerender } = renderHook(
      ({ rpm }: { rpm: number }) => useWaveCapture(bridge, "test", "single-rpm", rpm),
      { initialProps: { rpm: 8000 } },
    );
    // Re-render with new RPM before the first promise resolves.
    rerender({ rpm: 10000 });
    // Now resolve the stale one.
    resolveFirst({ manifest: { ...makeRawResponse().manifest, rpm: 9999 }, frames: [] });
    await waitFor(() => expect(result.current.state).toBe("ready"));
    // Should reflect the second call's data, not the stale first.
    expect(result.current.data?.manifest.rpm).toBe(8000); // second call returns the fixture (rpm 8000)
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `pnpm --filter @helios/desktop test -- useWaveCapture`
Expected: FAIL "Cannot find module '../useWaveCapture'".

- [ ] **Step 3: Implement `useWaveCapture.ts`.**

```ts
// useWaveCapture.ts

import { useEffect, useRef, useState } from "react";

import type {
  RawWaveFrame,
  WaveCapturePacked,
  WaveFrameManifest,
} from "../../state/types";

interface Bridge {
  loadWaves(
    jobId: string,
    studyKind: "single-rpm" | "sweep",
    rpmInt: number,
  ): Promise<unknown>;
}

type LoadState = "idle" | "loading" | "ready" | "error";

interface LoaderResult {
  state: LoadState;
  data: WaveCapturePacked | null;
  error: string | null;
}

export function useWaveCapture(
  bridge: Bridge,
  jobId: string,
  studyKind: "single-rpm" | "sweep",
  rpmInt: number,
): LoaderResult {
  const [state, setState] = useState<LoadState>("loading");
  const [data, setData] = useState<WaveCapturePacked | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Effect-id ref guards against stale-promise races.
  const lastEffectId = useRef(0);

  useEffect(() => {
    const myId = ++lastEffectId.current;
    setState("loading");
    setData(null);
    setError(null);

    bridge.loadWaves(jobId, studyKind, rpmInt)
      .then((raw) => {
        if (myId !== lastEffectId.current) return;
        const packed = packResponse(raw);
        setData(packed);
        setState("ready");
      })
      .catch((err) => {
        if (myId !== lastEffectId.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setState("error");
      });
  }, [bridge, jobId, studyKind, rpmInt]);

  return { state, data, error };
}

function packResponse(raw: unknown): WaveCapturePacked {
  // raw is { manifest, frames }
  const obj = raw as { manifest: WaveFrameManifest; frames: RawWaveFrame[] };
  const m = obj.manifest;
  const nFrames = obj.frames.length;
  if (nFrames !== m.frameCount) {
    throw new Error(`frame count mismatch in client: manifest=${m.frameCount}, payload=${nFrames}`);
  }

  const theta = new Float32Array(nFrames);
  const tMs = new Float32Array(nFrames);
  const pipeArr: Float32Array[][] = m.pipes.map((p) =>
    Array.from({ length: 4 }, () => new Float32Array(nFrames * p.nCells)),
  );
  const cylArr: Float32Array[][] = Array.from({ length: m.nCylinders }, () =>
    Array.from({ length: 4 }, () => new Float32Array(nFrames)),
  );
  const pipeRange = m.pipes.map(() =>
    Array.from({ length: 4 }, () => ({ min: Infinity, max: -Infinity })),
  );
  const cylRange = Array.from({ length: m.nCylinders }, () =>
    Array.from({ length: 4 }, () => ({ min: Infinity, max: -Infinity })),
  );

  for (let f = 0; f < nFrames; f++) {
    const fr = obj.frames[f];
    theta[f] = fr.theta;
    tMs[f] = fr.tMs ?? (fr as unknown as { t_ms: number }).t_ms ?? 0;

    for (let pi = 0; pi < m.pipes.length; pi++) {
      const meta = m.pipes[pi];
      const pipeFrame = fr.pipes[pi];
      for (let field = 0; field < 4; field++) {
        const dest = pipeArr[pi][field];
        const src = pipeFrame[field];
        const offset = f * meta.nCells;
        for (let c = 0; c < meta.nCells; c++) {
          const v = src[c];
          dest[offset + c] = v;
          if (v < pipeRange[pi][field].min) pipeRange[pi][field].min = v;
          if (v > pipeRange[pi][field].max) pipeRange[pi][field].max = v;
        }
      }
    }

    for (let ci = 0; ci < m.nCylinders; ci++) {
      const c = fr.cyl[ci];
      const vals = [c.v, c.p, c.t, c.xB ?? (c as unknown as { x_b: number }).x_b ?? 0];
      for (let field = 0; field < 4; field++) {
        cylArr[ci][field][f] = vals[field];
        if (vals[field] < cylRange[ci][field].min) cylRange[ci][field].min = vals[field];
        if (vals[field] > cylRange[ci][field].max) cylRange[ci][field].max = vals[field];
      }
    }
  }

  // Guard against pipes that never had data: clamp infinities to 0..1.
  for (const pr of pipeRange) {
    for (const r of pr) {
      if (!Number.isFinite(r.min)) r.min = 0;
      if (!Number.isFinite(r.max)) r.max = 1;
    }
  }
  for (const cr of cylRange) {
    for (const r of cr) {
      if (!Number.isFinite(r.min)) r.min = 0;
      if (!Number.isFinite(r.max)) r.max = 1;
    }
  }

  return { manifest: m, theta, tMs, pipeArr, cylArr, pipeRange, cylRange };
}
```

Note: the Rust side serializes per-cylinder fields as `{ v, p, t, x_b }` (snake_case for `x_b`), and the packer reads `c.xB` first with a `c.x_b` fallback for safety. Whichever shape ends up on the wire, this stays correct.

- [ ] **Step 4: Run tests to verify they pass.**

Run: `pnpm --filter @helios/desktop test -- useWaveCapture`
Expected: all 4 PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/modules/cfd/results/wave-viewer/useWaveCapture.ts \
        apps/desktop/src/modules/cfd/results/wave-viewer/__tests__/useWaveCapture.test.ts
git commit -m "feat(cfd): useWaveCapture hook — packs JSONL frames into typed arrays"
```

---

## Wave 4 — Renderers

### Task 8: `SchematicView` (canvas + rAF loop)

**Files:**
- Create `apps/desktop/src/modules/cfd/results/wave-viewer/SchematicView.tsx`

Pure renderer. Owns the canvas + rAF loop. Receives packed data, current frame index, field selections, and forwards user scrub/play state up to the parent.

We do not unit-test pixel output. We do smoke-test that the component mounts and the canvas has a `getContext("2d")` call. Most of the verification is manual (covered in Task 13).

- [ ] **Step 1: Implement `SchematicView.tsx`.**

```tsx
// SchematicView.tsx

import { useEffect, useRef } from "react";

import { sampleColormap } from "./colormaps";
import { computeMach, fieldRange, WAVE_FIELD_META } from "./fields";
import { layoutSchematic, type SchematicLayout } from "./layout";
import type {
  WaveCapturePacked,
  WaveCylField,
  WaveField,
  WaveSizeField,
} from "../../state/types";

interface Props {
  packed: WaveCapturePacked;
  frameIdx: number;
  field: WaveField;
  sizeField: WaveSizeField;
  cylField: WaveCylField;
}

const FIELD_IDX = { rho: 0, u: 1, p: 2, T: 3 } as const;
const CYL_FIELD_IDX = { V: 0, p: 1, T: 2, x_b: 3 } as const;

export function SchematicView({ packed, frameIdx, field, sizeField, cylField }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const layoutRef = useRef<SchematicLayout | null>(null);

  // Compute layout when the canvas size or manifest changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const parent = canvas.parentElement!;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext("2d");
      ctx?.scale(dpr, dpr);
      layoutRef.current = layoutSchematic(packed.manifest, w, h);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement!);
    return () => ro.disconnect();
  }, [packed.manifest]);

  // Redraw on every frameIdx / field / sizeField / cylField change.
  useEffect(() => {
    const canvas = canvasRef.current;
    const layout = layoutRef.current;
    if (!canvas || !layout) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    draw(ctx, layout, packed, frameIdx, field, sizeField, cylField);
  }, [packed, frameIdx, field, sizeField, cylField]);

  return (
    <div className="h-full w-full bg-[#0E0E10]">
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}

function draw(
  ctx: CanvasRenderingContext2D,
  layout: SchematicLayout,
  packed: WaveCapturePacked,
  frameIdx: number,
  field: WaveField,
  sizeField: WaveSizeField,
  cylField: WaveCylField,
) {
  const { width, height, tiers, cylinderCenters, cylinderRowY, cylinderBaseR } = layout;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#0E0E10";
  ctx.fillRect(0, 0, width, height);

  const meta = WAVE_FIELD_META[field];
  const sizeMeta = WAVE_FIELD_META[sizeField];

  for (const tier of tiers) {
    if (tier.kind === "horiz-pipe") {
      drawHorizontalPipe(ctx, packed, frameIdx, tier.pipe.index, field, sizeField, tier.pipeRect, meta.colormap, packed.pipeRange[tier.pipe.index]);
    } else if (tier.kind === "vert-pipes") {
      for (let i = 0; i < tier.pipes.length; i++) {
        drawVerticalPipe(ctx, packed, frameIdx, tier.pipes[i].index, field, sizeField, tier.pipeRects[i], meta.colormap, packed.pipeRange[tier.pipes[i].index]);
      }
    }
    // cyl-row: handled below in single pass
  }

  // Draw cylinders.
  for (let ci = 0; ci < packed.manifest.nCylinders; ci++) {
    drawCylinder(ctx, packed, frameIdx, ci, cylField, cylinderCenters[ci], cylinderRowY, cylinderBaseR);
  }
}

function fieldArr(packed: WaveCapturePacked, pipeIdx: number, field: WaveField): {
  read: (frameIdx: number, cellIdx: number) => number;
  range: { min: number; max: number };
  nCells: number;
} {
  const nCells = packed.manifest.pipes[pipeIdx].nCells;
  if (field === "Mach") {
    const u = packed.pipeArr[pipeIdx][FIELD_IDX.u];
    const T = packed.pipeArr[pipeIdx][FIELD_IDX.T];
    // Compute Mach range on the fly — once-per-draw is OK at our sizes.
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < u.length; i++) {
      const m = computeMach(u[i], T[i]);
      if (m < mn) mn = m;
      if (m > mx) mx = m;
    }
    if (!Number.isFinite(mn)) mn = 0;
    if (!Number.isFinite(mx)) mx = 1;
    return {
      read: (f, c) => computeMach(u[f * nCells + c], T[f * nCells + c]),
      range: { min: mn, max: mx },
      nCells,
    };
  }
  const idx = FIELD_IDX[field as Exclude<WaveField, "Mach">];
  const arr = packed.pipeArr[pipeIdx][idx];
  return {
    read: (f, c) => arr[f * nCells + c],
    range: packed.pipeRange[pipeIdx][idx],
    nCells,
  };
}

function drawHorizontalPipe(
  ctx: CanvasRenderingContext2D,
  packed: WaveCapturePacked,
  frameIdx: number,
  pipeIdx: number,
  field: WaveField,
  sizeField: WaveSizeField,
  rect: { x: number; y: number; w: number; h: number },
  cmap: ReturnType<typeof sampleColormap> extends infer R ? "RdBu_r" | "inferno" | "viridis" : never,
  _pipeRange: any,
) {
  const colorF = fieldArr(packed, pipeIdx, field);
  const sizeF = fieldArr(packed, pipeIdx, sizeField);
  const cmapName = WAVE_FIELD_META[field].colormap;
  const colorRange = fieldRange(field, colorF.range);
  const sizeRange = fieldRange(sizeField, sizeF.range);
  const cellW = rect.w / colorF.nCells;
  const midY = rect.y + rect.h / 2;
  const baseH = rect.h * 0.30;
  const swing = rect.h * 0.55;

  // Pipe outline
  ctx.strokeStyle = "#2A2C32";
  ctx.lineWidth = 1;
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);

  for (let c = 0; c < colorF.nCells; c++) {
    const v = colorF.read(frameIdx, c);
    const s = sizeF.read(frameIdx, c);
    const tC = clamp01((v - colorRange.vmin) / (colorRange.vmax - colorRange.vmin || 1));
    const tS = clamp01((s - sizeRange.vmin) / (sizeRange.vmax - sizeRange.vmin || 1));
    const h = baseH + tS * swing;
    const [r, g, b] = sampleColormap(cmapName, tC);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(rect.x + c * cellW, midY - h / 2, cellW, h);
  }
}

function drawVerticalPipe(
  ctx: CanvasRenderingContext2D,
  packed: WaveCapturePacked,
  frameIdx: number,
  pipeIdx: number,
  field: WaveField,
  sizeField: WaveSizeField,
  rect: { x: number; y: number; w: number; h: number },
  _cmap: any,
  _pipeRange: any,
) {
  const colorF = fieldArr(packed, pipeIdx, field);
  const sizeF = fieldArr(packed, pipeIdx, sizeField);
  const cmapName = WAVE_FIELD_META[field].colormap;
  const colorRange = fieldRange(field, colorF.range);
  const sizeRange = fieldRange(sizeField, sizeF.range);
  const cellH = rect.h / colorF.nCells;
  const midX = rect.x + rect.w / 2;
  const baseW = rect.w * 0.30;
  const swing = rect.w * 0.55;

  ctx.strokeStyle = "#2A2C32";
  ctx.lineWidth = 1;
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);

  for (let c = 0; c < colorF.nCells; c++) {
    const v = colorF.read(frameIdx, c);
    const s = sizeF.read(frameIdx, c);
    const tC = clamp01((v - colorRange.vmin) / (colorRange.vmax - colorRange.vmin || 1));
    const tS = clamp01((s - sizeRange.vmin) / (sizeRange.vmax - sizeRange.vmin || 1));
    const w = baseW + tS * swing;
    const [r, g, b] = sampleColormap(cmapName, tC);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(midX - w / 2, rect.y + c * cellH, w, cellH);
  }
}

function drawCylinder(
  ctx: CanvasRenderingContext2D,
  packed: WaveCapturePacked,
  frameIdx: number,
  ci: number,
  cylField: WaveCylField,
  cx: number,
  cy: number,
  baseR: number,
) {
  const fIdx = cylField === "x_b" ? CYL_FIELD_IDX.x_b
             : cylField === "p"   ? CYL_FIELD_IDX.p
             : CYL_FIELD_IDX.T;
  const pArr = packed.cylArr[ci][CYL_FIELD_IDX.p];
  const pRange = packed.cylRange[ci][CYL_FIELD_IDX.p];
  const fArr = packed.cylArr[ci][fIdx];
  const fRangeObs = packed.cylRange[ci][fIdx];

  const p = pArr[frameIdx];
  const f = fArr[frameIdx];

  // Pressure-driven radius. Log scale so idle p is still visible.
  const norm = clamp01((Math.log(Math.max(p, 1)) - Math.log(Math.max(pRange.min, 1))) /
                       Math.max(1e-9, Math.log(Math.max(pRange.max, 1)) - Math.log(Math.max(pRange.min, 1))));
  const r = baseR * (0.4 + 0.6 * norm);

  const cmapName =
    cylField === "x_b" ? "viridis" :
    cylField === "p"   ? "RdBu_r"  :
                         "inferno";
  const rangeStruct = fieldRange(
    cylField === "p" ? "p" : cylField === "T" ? "T" : "rho",  // x_b uses sequential range like rho
    fRangeObs,
  );
  const tC = clamp01((f - rangeStruct.vmin) / (rangeStruct.vmax - rangeStruct.vmin || 1));
  const [rr, gg, bb] = sampleColormap(cmapName, tC);
  ctx.fillStyle = `rgb(${rr},${gg},${bb})`;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#2A2C32";
  ctx.lineWidth = 1;
  ctx.stroke();
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
```

- [ ] **Step 2: Typecheck.**

Run: `pnpm --filter @helios/desktop typecheck`
Expected: zero errors. If TypeScript complains about the `_cmap: any` placeholders, just remove the unused params from the function signatures (they're there to document field flow, not for use).

- [ ] **Step 3: Commit.**

```bash
git add apps/desktop/src/modules/cfd/results/wave-viewer/SchematicView.tsx
git commit -m "feat(cfd): SchematicView canvas renderer for wave viewer"
```

---

### Task 9: `WaterfallView` (per-pipe ImageData heatmap)

**Files:**
- Create `apps/desktop/src/modules/cfd/results/wave-viewer/WaterfallView.tsx`

One canvas. Pipe picker + field selector inherited from parent state. Renders an `ImageData` of width = `nCells × scale` and height = `frameCount × scale`, where the colormap is the same one the schematic uses for the chosen field. Click on the canvas jumps the schematic's `frameIdx` via `onScrub`.

- [ ] **Step 1: Implement `WaterfallView.tsx`.**

```tsx
// WaterfallView.tsx

import { useEffect, useMemo, useRef } from "react";

import { COLORMAPS } from "./colormaps";
import { computeMach, fieldRange, WAVE_FIELD_META } from "./fields";
import type {
  WaveCapturePacked,
  WaveField,
} from "../../state/types";

interface Props {
  packed: WaveCapturePacked;
  pipeIdx: number;
  field: WaveField;
  /** Current schematic playhead, 0..frameCount-1. */
  frameIdx: number;
  onScrub(newFrameIdx: number): void;
}

const FIELD_IDX = { rho: 0, u: 1, p: 2, T: 3 } as const;

export function WaterfallView({ packed, pipeIdx, field, frameIdx, onScrub }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);

  const meta = useMemo(() => packed.manifest.pipes[pipeIdx], [packed, pipeIdx]);

  // Build ImageData on (pipeIdx, field) change.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const nCells = meta.nCells;
    const nFrames = packed.manifest.frameCount;

    // Decide pixel scale (each cell gets ≥1 px, frame row gets ≥1 px).
    const targetW = 800;
    const targetH = 600;
    const cellPx = Math.max(1, Math.floor(targetW / nCells));
    const framePx = Math.max(1, Math.floor(targetH / nFrames));
    const W = cellPx * nCells;
    const H = framePx * nFrames;
    canvas.width = W;
    canvas.height = H;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;

    const cmapName = WAVE_FIELD_META[field].colormap;
    const lut = COLORMAPS[cmapName];

    // Compute range for derived Mach on the fly.
    let valueAt: (f: number, c: number) => number;
    let range: { vmin: number; vmax: number };
    if (field === "Mach") {
      const u = packed.pipeArr[pipeIdx][FIELD_IDX.u];
      const T = packed.pipeArr[pipeIdx][FIELD_IDX.T];
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < u.length; i++) {
        const m = computeMach(u[i], T[i]);
        if (m < mn) mn = m;
        if (m > mx) mx = m;
      }
      if (!Number.isFinite(mn)) mn = 0;
      if (!Number.isFinite(mx)) mx = 1;
      range = fieldRange("Mach", { min: mn, max: mx });
      valueAt = (f, c) => computeMach(u[f * nCells + c], T[f * nCells + c]);
    } else {
      const idx = FIELD_IDX[field as Exclude<WaveField, "Mach">];
      const arr = packed.pipeArr[pipeIdx][idx];
      range = fieldRange(field, packed.pipeRange[pipeIdx][idx]);
      valueAt = (f, c) => arr[f * nCells + c];
    }

    const img = ctx.createImageData(W, H);
    const span = range.vmax - range.vmin || 1;

    for (let f = 0; f < nFrames; f++) {
      for (let c = 0; c < nCells; c++) {
        const v = valueAt(f, c);
        const t = Math.max(0, Math.min(1, (v - range.vmin) / span));
        const lutIdx = Math.min(255, Math.max(0, Math.round(t * 255)));
        const [r, g, b] = lut[lutIdx];
        for (let dy = 0; dy < framePx; dy++) {
          for (let dx = 0; dx < cellPx; dx++) {
            const px = (c * cellPx + dx) + (f * framePx + dy) * W;
            const o = px * 4;
            img.data[o] = r;
            img.data[o + 1] = g;
            img.data[o + 2] = b;
            img.data[o + 3] = 255;
          }
        }
      }
    }

    ctx.putImageData(img, 0, 0);
  }, [packed, pipeIdx, field, meta.nCells]);

  // Overlay: a thin horizontal line at the current frame.
  useEffect(() => {
    const canvas = overlayRef.current;
    const base = canvasRef.current;
    if (!canvas || !base) return;
    canvas.width = base.width;
    canvas.height = base.height;
    canvas.style.width = base.style.width;
    canvas.style.height = base.style.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const nFrames = packed.manifest.frameCount;
    const y = (frameIdx / Math.max(1, nFrames - 1)) * canvas.height;
    ctx.fillStyle = "rgba(255, 198, 39, 0.85)"; // ASU gold (helios accent)
    ctx.fillRect(0, y - 1, canvas.width, 2);
  }, [packed.manifest.frameCount, frameIdx]);

  return (
    <div className="relative inline-block">
      <canvas ref={canvasRef} className="block" />
      <canvas
        ref={overlayRef}
        className="absolute inset-0 cursor-crosshair"
        onClick={(e) => {
          const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
          const y = e.clientY - rect.top;
          const t = Math.max(0, Math.min(1, y / rect.height));
          const idx = Math.round(t * (packed.manifest.frameCount - 1));
          onScrub(idx);
        }}
      />
    </div>
  );
}
```

- [ ] **Step 2: Typecheck.**

Run: `pnpm --filter @helios/desktop typecheck`
Expected: zero errors.

- [ ] **Step 3: Commit.**

```bash
git add apps/desktop/src/modules/cfd/results/wave-viewer/WaterfallView.tsx
git commit -m "feat(cfd): WaterfallView per-pipe x-t heatmap (Phase 4)"
```

---

## Wave 5 — Modal + UI integration

### Task 10: `WaveViewerModal` with controls + RPM switcher

**Files:**
- Create `apps/desktop/src/modules/cfd/results/wave-viewer/WaveViewerModal.tsx`
- Create `apps/desktop/src/modules/cfd/results/wave-viewer/index.ts` (barrel re-export)
- Create `apps/desktop/src/modules/cfd/results/wave-viewer/__tests__/WaveViewerModal.test.tsx`

Owns: view toggle (Schematic | Waterfall), field select, size select, cyl select, speed select, play/pause, scrubber, frame-step buttons, pipe picker (waterfall), RPM dropdown (sweep only). Drives `frameIdx` via `requestAnimationFrame`.

- [ ] **Step 1: Write the failing test.**

```tsx
// WaveViewerModal.test.tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { WaveViewerModal } from "../WaveViewerModal";

function makeBridge(loadWaves = vi.fn()) {
  return { loadWaves } as any;
}

const dummyResponse = {
  manifest: {
    jobId: "j1", rpm: 8000, nPipes: 1,
    pipes: [{ role: "plenum", label: "plenum", nCells: 3, lengthM: 0.2, index: 0 }],
    nCylinders: 1, stepStride: 100,
    fields: ["rho", "u", "p", "T"], frameCount: 2,
    thetaStartDeg: 0, thetaEndDeg: 720, capturedCycle: 1, incomplete: false,
  },
  frames: [
    { theta: 0, t_ms: 0, pipes: [[[1,1,1],[0,0,0],[101325,101325,101325],[300,300,300]]], cyl: [{ v: 5e-5, p: 101325, t: 300, x_b: 0 }] },
    { theta: 360, t_ms: 7.5, pipes: [[[1,1,1],[0,0,0],[101325,101325,101325],[300,300,300]]], cyl: [{ v: 5e-5, p: 101325, t: 300, x_b: 0 }] },
  ],
};

describe("WaveViewerModal", () => {
  beforeEach(() => {
    // jsdom canvas mock
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      clearRect: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(),
      beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), stroke: vi.fn(),
      scale: vi.fn(), createImageData: vi.fn(() => ({ data: new Uint8ClampedArray(0) })),
      putImageData: vi.fn(),
      fillStyle: "", strokeStyle: "", lineWidth: 1,
    })) as any;
  });

  it("renders nothing when closed", () => {
    render(
      <WaveViewerModal
        open={false}
        bridge={makeBridge()}
        jobId="j1"
        studyKind="single-rpm"
        rpmInt={8000}
        onClose={() => {}}
      />
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("loads waves on open and renders Schematic by default", async () => {
    const loadWaves = vi.fn().mockResolvedValue(dummyResponse);
    render(
      <WaveViewerModal
        open
        bridge={makeBridge(loadWaves)}
        jobId="j1"
        studyKind="single-rpm"
        rpmInt={8000}
        onClose={() => {}}
      />
    );
    await waitFor(() => expect(loadWaves).toHaveBeenCalledWith("j1", "single-rpm", 8000));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText(/schematic/i)).toBeInTheDocument();
  });

  it("switches to Waterfall view on tab click", async () => {
    const loadWaves = vi.fn().mockResolvedValue(dummyResponse);
    render(
      <WaveViewerModal
        open
        bridge={makeBridge(loadWaves)}
        jobId="j1"
        studyKind="single-rpm"
        rpmInt={8000}
        onClose={() => {}}
      />
    );
    await waitFor(() => expect(loadWaves).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /waterfall/i }));
    expect(screen.getByLabelText(/pipe:/i)).toBeInTheDocument();
  });

  it("calls onClose on close-button click", async () => {
    const onClose = vi.fn();
    const loadWaves = vi.fn().mockResolvedValue(dummyResponse);
    render(
      <WaveViewerModal
        open
        bridge={makeBridge(loadWaves)}
        jobId="j1"
        studyKind="single-rpm"
        rpmInt={8000}
        onClose={onClose}
      />
    );
    await waitFor(() => expect(loadWaves).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("renders RPM dropdown for sweep studies and triggers re-load on change", async () => {
    const loadWaves = vi.fn().mockResolvedValue(dummyResponse);
    render(
      <WaveViewerModal
        open
        bridge={makeBridge(loadWaves)}
        jobId="j1"
        studyKind="sweep"
        rpmInt={8000}
        sweepCapturedRpms={[6000, 8000, 10000]}
        onClose={() => {}}
      />
    );
    await waitFor(() => expect(loadWaves).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText(/rpm:/i), { target: { value: "10000" } });
    await waitFor(() => expect(loadWaves).toHaveBeenCalledWith("j1", "sweep", 10000));
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `pnpm --filter @helios/desktop test -- WaveViewerModal`
Expected: FAIL "Cannot find module '../WaveViewerModal'".

- [ ] **Step 3: Implement `WaveViewerModal.tsx`.**

```tsx
// WaveViewerModal.tsx

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SchematicView } from "./SchematicView";
import { WaterfallView } from "./WaterfallView";
import { useWaveCapture } from "./useWaveCapture";
import type {
  WaveCylField,
  WaveField,
  WaveSizeField,
} from "../../state/types";

interface Bridge {
  loadWaves(
    jobId: string,
    studyKind: "single-rpm" | "sweep",
    rpmInt: number,
  ): Promise<unknown>;
}

interface Props {
  open: boolean;
  bridge: Bridge;
  jobId: string;
  studyKind: "single-rpm" | "sweep";
  rpmInt: number;
  sweepCapturedRpms?: number[];
  onClose(): void;
}

const SPEED_OPTIONS = [0.25, 0.5, 1, 2, 4, 8] as const;

export function WaveViewerModal(props: Props) {
  const { open, bridge, jobId, studyKind, sweepCapturedRpms, onClose } = props;
  const [rpmInt, setRpmInt] = useState(props.rpmInt);

  // Reset rpmInt when modal reopens with a new initial.
  useEffect(() => {
    if (open) setRpmInt(props.rpmInt);
  }, [open, props.rpmInt]);

  const { state, data, error } = useWaveCapture(bridge, jobId, studyKind, rpmInt);

  const [view, setView] = useState<"schematic" | "waterfall">("schematic");
  const [field, setField] = useState<WaveField>("p");
  const [sizeField, setSizeField] = useState<WaveSizeField>("p");
  const [cylField, setCylField] = useState<WaveCylField>("x_b");
  const [speed, setSpeed] = useState<number>(0.25);
  const [isPlaying, setIsPlaying] = useState(false);
  const [frameIdx, setFrameIdx] = useState(0);
  const [waterfallPipeIdx, setWaterfallPipeIdx] = useState(0);

  // Reset scrub on RPM change.
  useEffect(() => { setFrameIdx(0); setIsPlaying(false); }, [rpmInt]);

  // rAF playback loop.
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number>(0);

  useEffect(() => {
    if (!isPlaying || !data) return;
    const nFrames = data.manifest.frameCount;
    const cycleSeconds = Math.max(
      (data.manifest.thetaEndDeg - data.manifest.thetaStartDeg) / Math.max(1, data.manifest.rpm) / 6, // (Δθ/rpm) × 60/360
      1e-3,
    );
    lastTickRef.current = performance.now();

    const tick = (now: number) => {
      const dt = (now - lastTickRef.current) / 1000;
      lastTickRef.current = now;
      setFrameIdx((prev) => {
        const next = prev + (dt * speed * nFrames) / cycleSeconds;
        if (next >= nFrames) return next - nFrames;
        return next;
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [isPlaying, speed, data]);

  // ESC closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const frameInt = Math.max(0, Math.min(data ? data.manifest.frameCount - 1 : 0, Math.floor(frameIdx)));
  const headerInfo = data ? (
    <>
      RPM <span className="text-[#D8DCE2]">{data.manifest.rpm.toFixed(0)}</span>
      &nbsp;· cycle <span className="text-[#D8DCE2]">{data.manifest.capturedCycle}</span>
      &nbsp;· {data.manifest.frameCount} frames
      &nbsp;· θ {data.manifest.thetaStartDeg.toFixed(0)}°→{data.manifest.thetaEndDeg.toFixed(0)}°
      &nbsp;· stride {data.manifest.stepStride}
      {data.manifest.incomplete && <span className="ml-3 text-amber-400">INCOMPLETE</span>}
    </>
  ) : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="wave-viewer-title"
      className="fixed inset-0 z-50 flex flex-col bg-black/70 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex h-full w-full flex-col rounded-md border border-helios-line bg-helios-panel text-helios-text">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-helios-line px-4 py-2">
          <h2 id="wave-viewer-title" className="text-sm font-semibold">Wave viewer</h2>
          <div className="text-[11px] text-helios-dim">{headerInfo}</div>
          <button
            type="button"
            aria-label="Close"
            className="rounded border border-helios-line px-2 py-0.5 text-xs hover:border-asu-gold"
            onClick={onClose}
          >Close ✕</button>
        </div>

        {/* Controls bar */}
        <div className="flex flex-wrap items-center gap-3 border-b border-helios-line px-4 py-2 text-[11px] text-helios-dim">
          <div className="flex gap-1" role="tablist">
            <button
              type="button"
              role="tab"
              aria-label="Schematic"
              aria-selected={view === "schematic"}
              className={tabClass(view === "schematic")}
              onClick={() => setView("schematic")}
            >Schematic</button>
            <button
              type="button"
              role="tab"
              aria-label="Waterfall"
              aria-selected={view === "waterfall"}
              className={tabClass(view === "waterfall")}
              onClick={() => setView("waterfall")}
            >Waterfall</button>
          </div>

          {studyKind === "sweep" && sweepCapturedRpms && (
            <label className="flex items-center gap-1">
              RPM:
              <select
                value={rpmInt}
                onChange={(e) => setRpmInt(parseInt(e.target.value, 10))}
                className="rounded border border-helios-line bg-helios-base px-1 py-0.5"
              >
                {sweepCapturedRpms.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
          )}

          <label className="flex items-center gap-1">
            field:
            <select value={field} onChange={(e) => setField(e.target.value as WaveField)} className="rounded border border-helios-line bg-helios-base px-1 py-0.5">
              <option value="p">pressure</option>
              <option value="u">velocity</option>
              <option value="T">temperature</option>
              <option value="rho">density</option>
              <option value="Mach">Mach</option>
            </select>
          </label>

          {view === "schematic" && (
            <>
              <label className="flex items-center gap-1">
                size:
                <select value={sizeField} onChange={(e) => setSizeField(e.target.value as WaveSizeField)} className="rounded border border-helios-line bg-helios-base px-1 py-0.5">
                  <option value="p">pressure</option>
                  <option value="u">velocity</option>
                  <option value="T">temperature</option>
                  <option value="rho">density</option>
                </select>
              </label>
              <label className="flex items-center gap-1">
                cyl:
                <select value={cylField} onChange={(e) => setCylField(e.target.value as WaveCylField)} className="rounded border border-helios-line bg-helios-base px-1 py-0.5">
                  <option value="x_b">x_b</option>
                  <option value="p">pressure</option>
                  <option value="T">temperature</option>
                </select>
              </label>
            </>
          )}

          {view === "waterfall" && data && (
            <label className="flex items-center gap-1">
              pipe:
              <select value={waterfallPipeIdx} onChange={(e) => setWaterfallPipeIdx(parseInt(e.target.value, 10))} className="rounded border border-helios-line bg-helios-base px-1 py-0.5">
                {data.manifest.pipes.map((p, i) => (
                  <option key={p.index} value={i}>{p.label}</option>
                ))}
              </select>
            </label>
          )}

          <label className="ml-auto flex items-center gap-1">
            speed:
            <select value={speed} onChange={(e) => setSpeed(parseFloat(e.target.value))} className="rounded border border-helios-line bg-helios-base px-1 py-0.5">
              {SPEED_OPTIONS.map((s) => <option key={s} value={s}>{s}×</option>)}
            </select>
          </label>
          <button
            type="button"
            className="rounded border border-helios-line px-2 py-0.5 hover:border-asu-gold"
            onClick={() => setFrameIdx((f) => Math.max(0, f - 1))}
            aria-label="Step back"
          >◀◀</button>
          <button
            type="button"
            className="rounded border border-helios-line px-2 py-0.5 hover:border-asu-gold"
            onClick={() => setIsPlaying((p) => !p)}
            aria-label={isPlaying ? "Pause" : "Play"}
          >{isPlaying ? "⏸" : "⏵"}</button>
          <button
            type="button"
            className="rounded border border-helios-line px-2 py-0.5 hover:border-asu-gold"
            onClick={() => setFrameIdx((f) => data ? Math.min(data.manifest.frameCount - 1, f + 1) : f)}
            aria-label="Step forward"
          >▶▶</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-hidden">
          {state === "loading" && <CenterText>Loading wave frames…</CenterText>}
          {state === "error" && <CenterText tone="error">Failed to load: {error}</CenterText>}
          {state === "ready" && data && view === "schematic" && (
            <SchematicView
              packed={data}
              frameIdx={frameInt}
              field={field}
              sizeField={sizeField}
              cylField={cylField}
            />
          )}
          {state === "ready" && data && view === "waterfall" && (
            <WaterfallView
              packed={data}
              pipeIdx={waterfallPipeIdx}
              field={field}
              frameIdx={frameInt}
              onScrub={(idx) => { setIsPlaying(false); setFrameIdx(idx); }}
            />
          )}
        </div>

        {/* Scrubber */}
        {state === "ready" && data && (
          <div className="flex items-center gap-2 border-t border-helios-line px-4 py-2 text-[11px] text-helios-dim">
            <span>θ {data.theta[frameInt]?.toFixed(0)}°</span>
            <input
              type="range"
              min={0}
              max={data.manifest.frameCount - 1}
              value={frameInt}
              onChange={(e) => setFrameIdx(parseInt(e.target.value, 10))}
              className="flex-1"
            />
            <span>frame {frameInt + 1}/{data.manifest.frameCount}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function tabClass(active: boolean): string {
  return `rounded border px-2 py-0.5 ${active ? "border-asu-gold bg-asu-gold/10 text-asu-gold" : "border-helios-line hover:border-asu-gold"}`;
}

function CenterText({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return (
    <div className={`flex h-full items-center justify-center text-sm ${tone === "error" ? "text-red-300" : "text-helios-dim"}`}>
      {children}
    </div>
  );
}
```

- [ ] **Step 4: Create the barrel `index.ts`.**

```ts
// index.ts
export { WaveViewerModal } from "./WaveViewerModal";
```

- [ ] **Step 5: Run tests to verify they pass.**

Run: `pnpm --filter @helios/desktop test -- WaveViewerModal`
Expected: all 5 PASS.

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/src/modules/cfd/results/wave-viewer/WaveViewerModal.tsx \
        apps/desktop/src/modules/cfd/results/wave-viewer/index.ts \
        apps/desktop/src/modules/cfd/results/wave-viewer/__tests__/WaveViewerModal.test.tsx
git commit -m "feat(cfd): WaveViewerModal with controls, RPM switcher, view toggle"
```

---

### Task 11: Wire `WaveViewerModal` into `SingleRpmResults.tsx`

**Files:**
- Modify `apps/desktop/src/modules/cfd/results/SingleRpmResults.tsx`

Replace the placeholder span at line 217-219 with a button that opens the modal.

- [ ] **Step 1: Add imports.** Near the other Phase 3 imports (`PvLoopView`, `PipeProfileView`):

```tsx
import { WaveViewerModal } from "./wave-viewer";
```

- [ ] **Step 2: Add `bridge` to the `useCfd` destructure.** [`SingleRpmResults.tsx:15`](../../apps/desktop/src/modules/cfd/results/SingleRpmResults.tsx#L15) currently reads:

```tsx
const { cancelStudy } = useCfd();
```

Change to:

```tsx
const { cancelStudy, bridge } = useCfd();
```

(`bridge` is already exposed by `CfdContext` — `PvLoopView.tsx:15` uses the same pattern.)

- [ ] **Step 3: Add state.** Near the existing `showPv` / `showProfiles` declarations:

```tsx
const [showWaveViewer, setShowWaveViewer] = useState(false);
```

- [ ] **Step 4: Replace the placeholder span.** Find the existing block:

```tsx
{study.params.captureWaves && (
  <span className="text-[10px] text-[#5A5F66]">Wave frames captured on disk (viewer in Phase 4).</span>
)}
```

Replace with:

```tsx
{study.params.captureWaves && (
  <button
    type="button"
    className="rounded-sm border border-[#2A2C32] px-2 py-0.5 text-[10px] text-[#9097A0] hover:border-[#FFC627]"
    onClick={() => setShowWaveViewer(true)}
  >
    Open wave viewer ↗
  </button>
)}
```

- [ ] **Step 5: Mount the modal.** At the end of the returned JSX (after the existing modals/sections, but inside the root element), add:

```tsx
{study.params.captureWaves && (
  <WaveViewerModal
    open={showWaveViewer}
    bridge={bridge}
    jobId={study.id}
    studyKind="single-rpm"
    rpmInt={rpmInt}
    onClose={() => setShowWaveViewer(false)}
  />
)}
```

- [ ] **Step 6: Typecheck + tests.**

Run: `pnpm --filter @helios/desktop typecheck && pnpm --filter @helios/desktop test`
Expected: zero new errors, all tests green.

- [ ] **Step 7: Commit.**

```bash
git add apps/desktop/src/modules/cfd/results/SingleRpmResults.tsx
git commit -m "feat(cfd): wire WaveViewerModal into SingleRpmResults (replaces Phase 4 placeholder)"
```

---

### Task 12: Wire `WaveViewerModal` into `SweepResults.tsx`

**Files:**
- Modify `apps/desktop/src/modules/cfd/results/SweepResults.tsx`

In SweepResults the per-RPM expansion row has the Show P-V / Show profiles toggles. Add an "Open wave viewer" button there too, and pass `sweepCapturedRpms` to the modal.

**Schema notes (verified against [`state/types.ts:201-247`](../../apps/desktop/src/modules/cfd/state/types.ts)):**
- `SweepStudy.points: SweepPoint[]` — the array lives on the study itself, **not** under `study.summary`.
- `SweepPoint` has `rpm: number`, `captureDir?: string`. There is **no `rpmInt`** field; convert with `Math.round(p.rpm)`.
- `SweepStudy.summary?: SweepDoneSummary` is only `{ nRpms, nCompleted, totalStepCount, totalWallTimeS }` — it has no per-point data.
- `useCfd()` exposes `bridge` (same source PvLoopView uses).

- [ ] **Step 1: Locate the per-RPM expansion block.**

```bash
grep -n "captureWaves\|capturePvLoops\|capturePipeProfiles\|Math.round(p.rpm)" apps/desktop/src/modules/cfd/results/SweepResults.tsx
```

The existing per-row code already uses `Math.round(p.rpm)` to derive the `rpmInt` it passes to `PvLoopView` / `PipeProfileView`. Reuse that pattern.

- [ ] **Step 2: Add imports + bridge destructure.**

```tsx
import { useMemo, useState } from "react";  // ensure useMemo + useState are imported
import { WaveViewerModal } from "./wave-viewer";
```

If the component currently destructures from `useCfd()`, add `bridge`:

```tsx
const { /* existing */, bridge } = useCfd();
```

- [ ] **Step 3: Compute the list of captured RPMs once at the top of the component.**

```tsx
const sweepCapturedRpms = useMemo(
  () =>
    (study.points ?? [])
      .filter((p) => p.captureDir != null)
      .map((p) => Math.round(p.rpm)),
  [study.points],
);
```

- [ ] **Step 4: Add modal state.**

```tsx
const [waveViewerRpm, setWaveViewerRpm] = useState<number | null>(null);
```

- [ ] **Step 5: Add the button inside the per-RPM expansion's Captures section** (next to the existing Show P-V / Show profiles toggles — inside the same `study.params.captureWaves` branch if there's a placeholder there; otherwise alongside the other capture toggles):

```tsx
{study.params.captureWaves && (
  <button
    type="button"
    className="rounded-sm border border-[#2A2C32] px-2 py-0.5 text-[10px] text-[#9097A0] hover:border-[#FFC627]"
    onClick={() => setWaveViewerRpm(Math.round(p.rpm))}
  >
    Open wave viewer ↗
  </button>
)}
```

`p` here is the `SweepPoint` from the per-row map. Confirm the loop variable name with the grep above — it may be `point` instead of `p`.

- [ ] **Step 6: Mount the modal once at the bottom of the SweepResults JSX** (outside the per-row map):

```tsx
{study.params.captureWaves && waveViewerRpm != null && (
  <WaveViewerModal
    open
    bridge={bridge}
    jobId={study.id}
    studyKind="sweep"
    rpmInt={waveViewerRpm}
    sweepCapturedRpms={sweepCapturedRpms}
    onClose={() => setWaveViewerRpm(null)}
  />
)}
```

- [ ] **Step 7: Typecheck + tests.**

Run: `pnpm --filter @helios/desktop typecheck && pnpm --filter @helios/desktop test`
Expected: zero new errors, all tests green.

- [ ] **Step 8: Commit.**

```bash
git add apps/desktop/src/modules/cfd/results/SweepResults.tsx
git commit -m "feat(cfd): wire WaveViewerModal into SweepResults with RPM switcher"
```

---

## Wave 6 — Manual verification + release notes

### Task 13: Manual smoke test on a real run

**Files:** none (this is a verification gate, not a code change).

Per `CLAUDE.md`'s "For UI or frontend changes, start the dev server and use the feature in a browser before reporting the task as complete" rule.

- [ ] **Step 1: Run a single-RPM SDM26 study with captures enabled.**

```bash
pnpm --filter @helios/desktop tauri dev
```

In the CFD tab, create a single-RPM study at 8000 RPM with `Record waves: true`. Wait for it to complete.

- [ ] **Step 2: Open the wave viewer.** Click "Open wave viewer ↗" in the Captures bar of the result.

- [ ] **Step 3: Verify schematic view.**
  - Schematic renders: plenum at top, 4 runners, 4 cylinder circles, 4 primaries, secondaries, collector at bottom.
  - Pressing ⏵ animates cell colors + sizes. Cells "breathe" with the pressure wave.
  - Switching `field` cycles through pressure / velocity / temperature / density / Mach. Colors change as expected (RdBu_r for p+u; sequential for T/ρ/Mach).
  - Switching `size` changes the cell perpendicular extent.
  - Switching `cyl` changes the cylinder fill color.
  - Speed dropdown changes playback rate.
  - Scrubber drag updates the frame; play/pause/step-fwd/step-back all work.

- [ ] **Step 4: Verify waterfall view.**
  - Click "Waterfall" tab.
  - Pipe picker shows every pipe label from the manifest.
  - Heatmap is solid (no banding artifacts; correct orientation: time runs top-to-bottom, position left-to-right).
  - Field selector inherited from schematic.
  - Click on the heatmap → schematic playhead jumps.

- [ ] **Step 5: Run a 3-RPM sweep with captures.** RPMs `[6000, 8000, 10000]`. Open the viewer from any one of them. Confirm:
  - "RPM:" dropdown appears at the top of the controls bar.
  - Selecting a different RPM re-loads (loading state visible briefly), then the new schematic renders for the new data.
  - `field`, `sizeField`, `cylField`, `speed` persist across RPM switch; scrubber resets to 0.

- [ ] **Step 6: Edge cases.**
  - Close via Esc, backdrop click, and the Close button — all three work.
  - Modal with `captureWaves: false` study does NOT show the "Open wave viewer" button (the button is gated on `study.params.captureWaves`).
  - If the disk file is missing (delete `waves.jsonl` then open), the modal shows "Failed to load: …" without crashing.

- [ ] **Step 7: If any of the above fail**, file a follow-up task in the plan; otherwise mark this task complete.

---

### Task 14: Release notes + index update

**Files:**
- Create `v2_changes/39-cfd-phase-4-wave-viewer.md`
- Modify `v2_changes/README.md`

Per user memory `feedback_v2_changes_log.md`: every issue + fix gets a v2_changes entry.

- [ ] **Step 1: Create `v2_changes/39-cfd-phase-4-wave-viewer.md`.**

```markdown
# 39 — CFD tab Phase 4: animated wave-frame viewer + per-pipe waterfall

Phase 4 lights up the animated wave-frame viewer the Phase 3 plumbing
was waiting on. Open it from the Captures bar in any single-RPM or
sweep result that has "Record waves" enabled.

## What it does

- **Schematic view (default).** Anatomical engine layout — plenum on
  top, runner column, cylinder row (circles), primaries, secondaries
  (when the config has them), collector at bottom. Layout is
  data-driven from the manifest's pipe roles, so any engine
  config renders without code changes.

- **Cells.** Each pipe's cells are colored by a selectable field
  (pressure / velocity / temperature / density / Mach — Mach is
  derived from u and T at view time). The cell's perpendicular extent
  scales with a second selectable field (defaults to pressure), so
  pressure waves visibly breathe through the geometry.

- **Cylinders.** Diameter scales with cylinder pressure (log so idle
  is still visible). Fill follows a cyl-field selector
  (x_b / pressure / temperature).

- **Waterfall sub-view.** Per-pipe x-t heatmap. Pick a pipe + field,
  see the full captured cycle as a 2-D image. Click on it to jump
  the schematic's playhead.

- **Sweep RPM switcher.** For sweep studies, the modal has a dropdown
  of every captured RPM and re-loads on selection. Field / size /
  cylField / speed persist; scrub resets.

## Playback

Speed: 0.25× / 0.5× / 1× / 2× / 4× / 8× (default 0.25× — 1× plays a
real-engine cycle in 15 ms at 8000 rpm, too fast to follow).
Scrubber. Play/pause. Frame-step.

## Backend

One new Tauri command — `cfd_load_waves` — JSONL-aware sibling of
`cfd_load_capture`. Reads `manifest.json` + `waves.jsonl` from
`<Documents>/Helios/cfd/captures/<job_id>/<kind>/<rpm_int>/` and
returns `{ manifest, frames }`. First parse error aborts with the
bad line number — no partial loads.

No backend math changes; no parity test impact. Capture writer
from Phase 3 unchanged.

## Limits / out of scope

- Captures only the **last** cycle. Multi-cycle capture is a separate
  finding.
- No brush-to-scrub on the waterfall (click-to-jump only).
- No side-by-side compare across studies / RPMs.
- No animation export (MP4 / GIF).
- No species (Y) field (no species data on disk today).

## Files

Frontend: `apps/desktop/src/modules/cfd/results/wave-viewer/`
- `WaveViewerModal.tsx`, `SchematicView.tsx`, `WaterfallView.tsx`
- `useWaveCapture.ts`, `colormaps.ts`, `fields.ts`, `layout.ts`

Backend: `apps/desktop/src-tauri/src/cfd/commands.rs`
(`cfd_load_waves` + impl + 6 tests).

Spec: `docs/superpowers/specs/2026-05-26-cfd-tab-phase-4-wave-viewer-design.md`.
Plan: `docs/superpowers/plans/2026-05-26-cfd-tab-phase-4-wave-viewer-plan.md`.
```

- [ ] **Step 2: Add the new entry to `v2_changes/README.md`** in numerical order (after entry 38). Match the existing line style.

- [ ] **Step 3: Commit.**

```bash
git add v2_changes/39-cfd-phase-4-wave-viewer.md v2_changes/README.md
git commit -m "docs(v2_changes): 39 — CFD Phase 4 animated wave-frame viewer"
```

---

## Acceptance criteria recap (mirrors spec §11)

- [ ] `cfd_load_waves` Tauri command works against a real capture directory; returns manifest + frames.
- [ ] `useWaveCapture` packs the data into typed arrays once per load.
- [ ] Schematic renders for SDM26 (4 cyl, 4-2-1) without hard-coded geometry.
- [ ] Schematic renders for a 1-cyl config (no secondaries — tier skipped).
- [ ] All five fields (p, u, T, ρ, Mach) selectable; colors look right.
- [ ] Cell size visibly scales with selected size-field; cylinder circles scale with pressure; fill follows cyl-field.
- [ ] Play/pause, speed select, scrubber, frame-step all work.
- [ ] Waterfall renders one pipe at a time; pipe picker cycles.
- [ ] Clicking waterfall sets schematic frame index.
- [ ] Sweep RPM switcher re-loads correctly; field/size/cyl/speed persist; scrub resets.
- [ ] All new vitest tests pass; existing tests still green.
- [ ] All new Rust tests pass; existing engine-sim 45-parity suite still green.
- [ ] Placeholder text at `SingleRpmResults.tsx:218` replaced with working button.
- [ ] Manual smoke test on a real run validates everything above.

## Notes for the implementer

- This is UI-only work; the pre-commit parity hook should be a no-op (~120 s) on each commit.
- If `pnpm --filter @helios/desktop typecheck` shows errors in files you didn't touch, that's an existing issue unrelated to this plan — flag it but don't fix it in this branch.
- The colormap LUT control-point tables in Task 2 are approximate; if tests fail by 1-2 units of R/G/B at the midpoint, widen the test tolerance rather than chasing matplotlib bit-exactness.
- The `helios-line`, `helios-panel`, `helios-text`, `asu-gold`, `helios-dim`, `helios-base` Tailwind classes are part of the existing design system — they already exist; just use them as in `ConfirmModal.tsx`.
- The actual Tauri crate name (Task 5 step 4) can be confirmed by `grep '^name' apps/desktop/src-tauri/Cargo.toml`.
