# CFD Track Map + Track Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user pick which competition track is active for autocross and endurance, persist that selection across reloads, feed it into FSAE scoring, and visualize each track as a speed-colored curvature-vs-distance strip ("track map") on the Performance screen.

**Architecture:** Pure-frontend, no Rust. (1) A track **registry** (`lib/performance/trackRegistry.ts`) lists the available bundled tracks per event (real 2026 + synthetic-rules fallback) and resolves a selection id → `Track`. (2) The selection is a tiny `{ autocross, endurance }` **id pair** held in CFD state and persisted to localStorage exactly like `vehicleConfig`/`referenceBaseline` — storing ids (not track JSON) sidesteps the `radius: Infinity`-doesn't-serialize trap entirely. (3) Both `computeEvents` call sites pass the resolved tracks via the already-existing-but-unused `EventOpts.autocrossTrack`/`enduranceTrack`. (4) The map is an honest **curvature-vs-distance strip** (the stored model has no turn direction, so a true overhead is impossible) colored by the lap sim's `v(s)`, exposed via a new `lapSpeedProfile()`.

**Tech Stack:** TypeScript, React, Vitest + @testing-library/react, inline SVG, existing `lib/performance` (`computeEvents`, `simLap`/`solveSpeeds`, `discretizeTrack`, `parseTrack`), CFD reducer + `cfdStorage`.

---

## Design decisions (read before coding)

1. **Curvature strip, not a fake overhead.** `Track` is `{ name, segments: {length, radius}[], closed }` — radius only, **no turn direction and no XY** (deliberate: `track.ts:3` "corner direction is irrelevant"). A geometrically faithful overhead map cannot be reconstructed (the L/R handedness lives only in external overlay PNGs in the Vault). So the map is a **curvature (1/radius) vs cumulative-distance strip**, with straights flat and corners tall, **colored by local speed** from the lap sim — truthful about exactly what we know.

2. **Persist ids, not tracks.** The user selects among **bundled** tracks (real 2026 + synthetic). Persisting the selection as two string ids is trivially JSON-safe and avoids the `Infinity` round-trip bug (a straight's `radius` is `Infinity`, which `JSON.stringify` turns into `null`). `resolveTrack()` maps an id back to the in-memory `Track`; an unknown/removed id falls back to that event's default.

3. **Selection drives scoring.** `computeEvents` already accepts `opts.autocrossTrack`/`enduranceTrack` but **no call site passes them** today (defaults always win). We thread the resolved selection into both call sites (`PerformanceScreen` and `OptimizationResults`) so the map and the FSAE numbers always agree.

4. **Map speed is flat-out reference.** `lapSpeedProfile` runs at `pace = 1` for both events (illustrative "where are the corners / how fast"). The endurance *scoring* still uses `ENDURANCE_PACE` inside `computeEvents`; the map is labeled "flat-out reference speed" so the two aren't conflated. This avoids exporting `ENDURANCE_PACE` and keeps the map a geometry aid.

5. **Mirror the existing persistence triple.** `vehicleConfig`/`referenceBaseline` already thread through State → Action → reducer → CfdContextValue → rehydrate → savePersisted/loadPersisted → persist-effect deps. The track selection clones that path exactly.

## File structure

- **Create** `apps/desktop/src/modules/cfd/lib/performance/trackRegistry.ts` — `TrackOption`, `TrackSelection`, `TrackKind`, `AUTOCROSS_TRACKS`, `ENDURANCE_TRACKS`, `DEFAULT_TRACK_SELECTION`, `tracksFor`, `resolveTrack`.
- **Create** `apps/desktop/src/modules/cfd/__tests__/performance/trackRegistry.test.ts`.
- **Modify** `apps/desktop/src/modules/cfd/lib/performance/index.ts` — re-export the registry.
- **Modify** `apps/desktop/src/modules/cfd/lib/performance/lapSim.ts` — add `lapSpeedProfile()` + `LapSpeedProfile`.
- **Modify** `apps/desktop/src/modules/cfd/lib/performance/__tests__/lapSim.test.ts` — speed-profile tests.
- **Create** `apps/desktop/src/modules/cfd/components/charts/TrackMap.tsx` — curvature-strip SVG.
- **Create** `apps/desktop/src/modules/cfd/__tests__/TrackMap.test.tsx`.
- **Modify** `apps/desktop/src/modules/cfd/lib/cfdStorage.ts` — persist `trackSelection`.
- **Modify** `apps/desktop/src/modules/cfd/state/CfdContext.tsx` — state/action/reducer/context/rehydrate/persist.
- **Create** `apps/desktop/src/modules/cfd/__tests__/trackSelectionState.test.ts` — reducer + storage round-trip.
- **Modify** `apps/desktop/src/modules/cfd/screens/PerformanceScreen.tsx` — Track section (pickers + maps) + thread selection into `computeEvents`.
- **Modify** `apps/desktop/src/modules/cfd/results/OptimizationResults.tsx` — thread selection into the `eventsByTrial` `computeEvents` call.
- **Create** `v2_changes/51-cfd-track-map-and-persistence.md`.

---

### Task 1: Track registry + selection type

**Files:**
- Create: `apps/desktop/src/modules/cfd/lib/performance/trackRegistry.ts`
- Modify: `apps/desktop/src/modules/cfd/lib/performance/index.ts`
- Test: `apps/desktop/src/modules/cfd/__tests__/performance/trackRegistry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/modules/cfd/__tests__/performance/trackRegistry.test.ts
import { describe, it, expect } from "vitest";

import {
  AUTOCROSS_TRACKS,
  ENDURANCE_TRACKS,
  DEFAULT_TRACK_SELECTION,
  tracksFor,
  resolveTrack,
} from "../../lib/performance/trackRegistry";
import { AUTOCROSS_2026, ENDURANCE_2026 } from "../../lib/performance";

describe("trackRegistry", () => {
  it("offers the real 2026 track plus a synthetic fallback per event", () => {
    expect(AUTOCROSS_TRACKS.map((o) => o.id)).toContain("autocross-2026");
    expect(ENDURANCE_TRACKS.map((o) => o.id)).toContain("endurance-2026");
    expect(AUTOCROSS_TRACKS.length).toBeGreaterThanOrEqual(2);
    expect(ENDURANCE_TRACKS.length).toBeGreaterThanOrEqual(2);
  });

  it("tracksFor returns the per-kind option list", () => {
    expect(tracksFor("autocross")).toBe(AUTOCROSS_TRACKS);
    expect(tracksFor("endurance")).toBe(ENDURANCE_TRACKS);
  });

  it("resolves the default ids to the bundled 2026 tracks", () => {
    expect(resolveTrack("autocross", DEFAULT_TRACK_SELECTION.autocross)).toBe(AUTOCROSS_2026);
    expect(resolveTrack("endurance", DEFAULT_TRACK_SELECTION.endurance)).toBe(ENDURANCE_2026);
  });

  it("falls back to the default track for an unknown id", () => {
    expect(resolveTrack("autocross", "does-not-exist")).toBe(AUTOCROSS_2026);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run src/modules/cfd/__tests__/performance/trackRegistry.test.ts`
Expected: FAIL — cannot resolve `../../lib/performance/trackRegistry`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/desktop/src/modules/cfd/lib/performance/trackRegistry.ts
//
// The set of competition tracks the user can choose from, per event. Today these
// are bundled constants (the real traced 2026 courses + a rules-synthesized
// fallback). The user's choice is persisted as a small id pair (TrackSelection)
// rather than serialized track JSON — ids round-trip cleanly through localStorage,
// track JSON does not (a straight's radius is Infinity → null under JSON).

import { AUTOCROSS_2026, ENDURANCE_2026 } from "./tracks2026";
import { synthesizeAutocross, synthesizeEndurance, type Track } from "./track";

export type TrackKind = "autocross" | "endurance";

export interface TrackOption {
  id: string;
  label: string;
  track: Track;
}

/** Which track is active for each event, by registry id. */
export interface TrackSelection {
  autocross: string;
  endurance: string;
}

export const AUTOCROSS_TRACKS: TrackOption[] = [
  { id: "autocross-2026", label: "Autocross 2026 (real)", track: AUTOCROSS_2026 },
  { id: "autocross-synthetic", label: "Autocross (synthetic · rules §D.11)", track: synthesizeAutocross() },
];

export const ENDURANCE_TRACKS: TrackOption[] = [
  { id: "endurance-2026", label: "Endurance 2026 (real)", track: ENDURANCE_2026 },
  { id: "endurance-synthetic", label: "Endurance (synthetic · rules §D.12)", track: synthesizeEndurance() },
];

export const DEFAULT_TRACK_SELECTION: TrackSelection = {
  autocross: "autocross-2026",
  endurance: "endurance-2026",
};

export function tracksFor(kind: TrackKind): TrackOption[] {
  return kind === "autocross" ? AUTOCROSS_TRACKS : ENDURANCE_TRACKS;
}

/** Resolve a selection id to its Track, falling back to the event's default if
 *  the id is unknown (e.g. a persisted id whose track was removed). */
export function resolveTrack(kind: TrackKind, id: string): Track {
  const opts = tracksFor(kind);
  const found = opts.find((o) => o.id === id);
  if (found) return found.track;
  const defId = DEFAULT_TRACK_SELECTION[kind];
  return opts.find((o) => o.id === defId)!.track;
}
```

- [ ] **Step 4: Re-export from the barrel** — add to `apps/desktop/src/modules/cfd/lib/performance/index.ts` (next to the existing `./tracks2026` / `./track` re-exports):

```ts
export {
  AUTOCROSS_TRACKS,
  ENDURANCE_TRACKS,
  DEFAULT_TRACK_SELECTION,
  tracksFor,
  resolveTrack,
  type TrackOption,
  type TrackSelection,
  type TrackKind,
} from "./trackRegistry";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/desktop && pnpm exec vitest run src/modules/cfd/__tests__/performance/trackRegistry.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/modules/cfd/lib/performance/trackRegistry.ts apps/desktop/src/modules/cfd/lib/performance/index.ts apps/desktop/src/modules/cfd/__tests__/performance/trackRegistry.test.ts
git commit -m "feat(cfd): track registry + selection resolution"
```

---

### Task 2: `lapSpeedProfile` — expose v(s) for the map

**Files:**
- Modify: `apps/desktop/src/modules/cfd/lib/performance/lapSim.ts`
- Test: `apps/desktop/src/modules/cfd/lib/performance/__tests__/lapSim.test.ts`

- [ ] **Step 1: Write the failing test (append to the existing lapSim test file)**

```ts
import { lapSpeedProfile } from "../lapSim";
import { AUTOCROSS_2026 } from "../tracks2026";
// Reuse whatever torque-curve + vehicle fixtures the existing lapSim tests use.
// If the file already builds a `curve` and `vehicle`, reuse them; otherwise:
import { SDM26_VEHICLE } from "../vehicle";

const flatCurve = Array.from({ length: 12 }, (_, i) => ({ rpm: 4000 + i * 1000, torqueNm: 55 }));

describe("lapSpeedProfile", () => {
  it("returns aligned distance/radius/speed arrays with positive speeds", () => {
    const p = lapSpeedProfile(flatCurve, SDM26_VEHICLE, AUTOCROSS_2026);
    expect(p.speedMps.length).toBe(p.radius.length);
    expect(p.distance.length).toBe(p.radius.length);
    expect(p.speedMps.every((v) => v > 0)).toBe(true);
  });

  it("distance is monotonically increasing and ends near the lap length", () => {
    const p = lapSpeedProfile(flatCurve, SDM26_VEHICLE, AUTOCROSS_2026);
    for (let i = 1; i < p.distance.length; i++) {
      expect(p.distance[i]!).toBeGreaterThan(p.distance[i - 1]!);
    }
    expect(p.distance[p.distance.length - 1]!).toBeLessThanOrEqual(p.length);
  });

  it("its max speed matches simLap's vMaxMps for the same inputs", () => {
    const p = lapSpeedProfile(flatCurve, SDM26_VEHICLE, AUTOCROSS_2026);
    const lap = simLap(flatCurve, SDM26_VEHICLE, AUTOCROSS_2026);
    expect(Math.max(...p.speedMps)).toBeCloseTo(lap.vMaxMps, 6);
  });
});
```

> Note: `simLap` is already imported in this test file. If `SDM26_VEHICLE` is not exported from `./vehicle`, reuse the vehicle fixture the existing tests already construct.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run src/modules/cfd/lib/performance/__tests__/lapSim.test.ts -t lapSpeedProfile`
Expected: FAIL — `lapSpeedProfile` is not exported.

- [ ] **Step 3: Add the implementation** to `lapSim.ts` (after `simLap`; it reuses the file-private `solveSpeeds` and `discretizeTrack`):

```ts
export interface LapSpeedProfile {
  /** Midpoint distance of each station along the lap (m), ascending. */
  distance: number[];
  /** Local path radius at each station (m); Infinity on straights. */
  radius: number[];
  /** Solved speed v(s) at each station (m/s). */
  speedMps: number[];
  step: number;
  length: number;
}

/** Expose the solved speed profile v(s) (and the radius profile) for a lap,
 *  for visualization. Same solver as simLap; defaults to flat-out (pace 1). */
export function lapSpeedProfile(
  curve: TorqueCurve,
  vehicle: VehicleConfig,
  track: Track,
  opts: LapOpts = {},
): LapSpeedProfile {
  const { radius, step, length } = discretizeTrack(track, opts.ds ?? 2);
  const speedMps = solveSpeeds(curve, vehicle, radius, step, track.closed, opts.pace ?? 1);
  const distance = radius.map((_, i) => (i + 0.5) * step);
  return { distance, radius, speedMps, step, length };
}
```

- [ ] **Step 4: Export from the barrel** — add to `apps/desktop/src/modules/cfd/lib/performance/index.ts` (next to the existing `./lapSim` re-export, or add one):

```ts
export { simLap, lapSpeedProfile, type LapResult, type LapOpts, type LapSpeedProfile } from "./lapSim";
```

> If `index.ts` already re-exports from `./lapSim`, extend that line with `lapSpeedProfile` and `LapSpeedProfile` rather than duplicating.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/desktop && pnpm exec vitest run src/modules/cfd/lib/performance/__tests__/lapSim.test.ts`
Expected: PASS (existing tests + the 3 new ones).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/modules/cfd/lib/performance/lapSim.ts apps/desktop/src/modules/cfd/lib/performance/index.ts apps/desktop/src/modules/cfd/lib/performance/__tests__/lapSim.test.ts
git commit -m "feat(cfd): lapSpeedProfile exposes v(s) for the track map"
```

---

### Task 3: `TrackMap` curvature-strip component

**Files:**
- Create: `apps/desktop/src/modules/cfd/components/charts/TrackMap.tsx`
- Test: `apps/desktop/src/modules/cfd/__tests__/TrackMap.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/desktop/src/modules/cfd/__tests__/TrackMap.test.tsx
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import { TrackMap } from "../components/charts/TrackMap";

// 6 stations: a straight (Infinity radius, fast) then a tight corner (slow).
const distance = [1, 3, 5, 7, 9, 11];
const radius = [Infinity, Infinity, Infinity, 8, 8, 8];
const speedMps = [40, 40, 40, 12, 12, 12];

describe("TrackMap", () => {
  it("draws one column rect per station (when under the column cap) with finite coords", () => {
    const { container } = render(<TrackMap distance={distance} radius={radius} speedMps={speedMps} />);
    const rects = Array.from(container.querySelectorAll("rect"));
    expect(rects).toHaveLength(6);
    for (const r of rects) {
      expect(r.getAttribute("x")).not.toMatch(/NaN/);
      expect(r.getAttribute("height")).not.toMatch(/NaN/);
    }
  });

  it("gives straights (curvature 0) ~zero height and corners positive height", () => {
    const { container } = render(<TrackMap distance={distance} radius={radius} speedMps={speedMps} />);
    const rects = container.querySelectorAll("rect");
    const hStraight = Number(rects[0]!.getAttribute("height"));
    const hCorner = Number(rects[5]!.getAttribute("height"));
    expect(hStraight).toBeCloseTo(0, 5);
    expect(hCorner).toBeGreaterThan(0);
  });

  it("colors columns by speed (slow and fast differ)", () => {
    const { container } = render(<TrackMap distance={distance} radius={radius} speedMps={speedMps} />);
    const rects = container.querySelectorAll("rect");
    expect(rects[0]!.getAttribute("fill")).not.toBe(rects[5]!.getAttribute("fill"));
  });

  it("exposes an accessible label", () => {
    const { container } = render(<TrackMap distance={distance} radius={radius} speedMps={speedMps} />);
    expect(container.querySelector('svg[role="img"]')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run src/modules/cfd/__tests__/TrackMap.test.tsx`
Expected: FAIL — cannot resolve `../components/charts/TrackMap`.

- [ ] **Step 3: Write the implementation**

```tsx
// apps/desktop/src/modules/cfd/components/charts/TrackMap.tsx
//
// Track "map" as a curvature-vs-distance strip, hand-rolled SVG. The stored
// track model has NO turn direction or XY, so a faithful overhead is impossible;
// this is the honest visualization: bar height ∝ curvature (1/radius, straights
// flat, tight corners tall), bar color ∝ local speed (blue slow → gold fast).
// Stations are downsampled to at most MAX_COLS columns for a bounded rect count.
// Mirrors ScatterPlot idioms (useElementWidth, role="img", dark palette).

import { useMemo, useRef } from "react";

import { useElementWidth } from "./useElementWidth";

export interface TrackMapProps {
  /** Ascending station distances (m). */
  distance: number[];
  /** Station radii (m); Infinity for a straight. */
  radius: number[];
  /** Station speeds (m/s) for coloring. */
  speedMps: number[];
  height?: number;
}

const MAX_COLS = 240;
const SLOW: [number, number, number] = [0x4f, 0xc3, 0xf7]; // #4FC3F7 blue
const FAST: [number, number, number] = [0xff, 0xc6, 0x27]; // #FFC627 gold
const AXIS = "#3f3f46";
const TICK = "#71717a";

function lerpColor(t: number): string {
  const c = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const ch = (i: number) => Math.round(SLOW[i]! + (FAST[i]! - SLOW[i]!) * c);
  return `rgb(${ch(0)}, ${ch(1)}, ${ch(2)})`;
}

export function TrackMap({ distance, radius, speedMps, height = 96 }: TrackMapProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const width = Math.max(useElementWidth(hostRef, 600), 240);

  const cols = useMemo(() => {
    const n = Math.min(distance.length, radius.length, speedMps.length);
    if (n === 0) return [] as { curv: number; speed: number }[];
    const stride = Math.max(1, Math.ceil(n / MAX_COLS));
    const out: { curv: number; speed: number }[] = [];
    for (let i = 0; i < n; i += stride) {
      let curvSum = 0;
      let spdSum = 0;
      let cnt = 0;
      for (let j = i; j < Math.min(i + stride, n); j++) {
        const r = radius[j]!;
        curvSum += Number.isFinite(r) && r > 0 ? 1 / r : 0;
        spdSum += speedMps[j]!;
        cnt++;
      }
      out.push({ curv: curvSum / cnt, speed: spdSum / cnt });
    }
    return out;
  }, [distance, radius, speedMps]);

  const maxCurv = cols.reduce((m, c) => Math.max(m, c.curv), 0) || 1;
  const vMin = cols.reduce((m, c) => Math.min(m, c.speed), Infinity);
  const vMax = cols.reduce((m, c) => Math.max(m, c.speed), -Infinity);
  const vSpan = vMax - vMin || 1;

  const padTop = 6;
  const padBottom = 16;
  const padX = 4;
  const plotW = Math.max(width - 2 * padX, 1);
  const plotH = Math.max(height - padTop - padBottom, 1);
  const colW = cols.length > 0 ? plotW / cols.length : plotW;
  const baseY = height - padBottom;

  return (
    <div ref={hostRef} className="w-full">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`Track curvature strip, ${cols.length} stations, speed-colored`}
        className="block"
      >
        <line x1={padX} x2={width - padX} y1={baseY} y2={baseY} stroke={AXIS} strokeWidth={0.5} />
        {cols.map((c, i) => {
          const h = (c.curv / maxCurv) * plotH;
          const x = padX + i * colW;
          const t = (c.speed - vMin) / vSpan;
          return (
            <rect
              key={i}
              x={x}
              y={baseY - h}
              width={Math.max(colW - 0.3, 0.3)}
              height={h}
              fill={lerpColor(t)}
            />
          );
        })}
        <text x={padX} y={height - 4} fontSize={9} fill={TICK}>
          0 m
        </text>
        <text x={width - padX} y={height - 4} textAnchor="end" fontSize={9} fill={TICK}>
          {distance.length > 0 ? `${Math.round(distance[distance.length - 1]!)} m` : ""}
        </text>
      </svg>
    </div>
  );
}
```

> The test uses 6 stations (< `MAX_COLS`) so `stride === 1` and there is exactly one rect per station.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/desktop && pnpm exec vitest run src/modules/cfd/__tests__/TrackMap.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/modules/cfd/components/charts/TrackMap.tsx apps/desktop/src/modules/cfd/__tests__/TrackMap.test.tsx
git commit -m "feat(cfd): TrackMap curvature strip (speed-colored)"
```

---

### Task 4: Persist the track selection (state + storage)

**Files:**
- Modify: `apps/desktop/src/modules/cfd/lib/cfdStorage.ts`
- Modify: `apps/desktop/src/modules/cfd/state/CfdContext.tsx`
- Test: `apps/desktop/src/modules/cfd/__tests__/trackSelectionState.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/modules/cfd/__tests__/trackSelectionState.test.ts
import { describe, it, expect, beforeEach } from "vitest";

import { reducer, initialState } from "../state/CfdContext";
import { loadPersisted, savePersisted, type Persisted } from "../lib/cfdStorage";
import { DEFAULT_TRACK_SELECTION } from "../lib/performance";

describe("track selection — reducer", () => {
  it("defaults to the 2026 tracks", () => {
    expect(initialState.trackSelection).toEqual(DEFAULT_TRACK_SELECTION);
  });

  it("setTrackSelection replaces the selection", () => {
    const next = reducer(initialState, {
      type: "setTrackSelection",
      selection: { autocross: "autocross-synthetic", endurance: "endurance-2026" },
    });
    expect(next.trackSelection).toEqual({
      autocross: "autocross-synthetic",
      endurance: "endurance-2026",
    });
  });

  it("rehydrate carries a persisted selection, keeping state when absent", () => {
    const withSel = reducer(initialState, {
      type: "rehydrate",
      studies: [],
      lastConfigPath: null,
      trackSelection: { autocross: "autocross-synthetic", endurance: "endurance-synthetic" },
    });
    expect(withSel.trackSelection.autocross).toBe("autocross-synthetic");

    const withoutSel = reducer(initialState, {
      type: "rehydrate",
      studies: [],
      lastConfigPath: null,
    });
    expect(withoutSel.trackSelection).toEqual(DEFAULT_TRACK_SELECTION);
  });
});

describe("track selection — storage round-trip", () => {
  beforeEach(() => window.localStorage.clear());

  it("survives savePersisted → loadPersisted", () => {
    const p: Persisted = {
      lastConfigPath: null,
      studies: [],
      trackSelection: { autocross: "autocross-synthetic", endurance: "endurance-2026" },
    };
    savePersisted(p);
    expect(loadPersisted().trackSelection).toEqual({
      autocross: "autocross-synthetic",
      endurance: "endurance-2026",
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run src/modules/cfd/__tests__/trackSelectionState.test.ts`
Expected: FAIL — `initialState.trackSelection` is undefined / `"setTrackSelection"` not handled / `Persisted.trackSelection` missing.

- [ ] **Step 3: Extend `cfdStorage.ts`**

Add the import near the top (next to the existing performance-types import):

```ts
import type { TrackSelection } from "./performance/trackRegistry";
```

Add the field to the `Persisted` interface and `EMPTY`:

```ts
export interface Persisted {
  lastConfigPath: string | null;
  studies: Study[];
  vehicleConfig?: VehicleConfig | null;
  referenceBaseline?: ReferenceBaseline | null;
  trackSelection?: TrackSelection | null;
}

const EMPTY: Persisted = {
  lastConfigPath: null,
  studies: [],
  vehicleConfig: null,
  referenceBaseline: null,
  trackSelection: null,
};
```

In `loadPersisted`, add to the returned object inside the `if (raw)` branch:

```ts
        vehicleConfig: parsed.vehicleConfig ?? null,
        referenceBaseline: parsed.referenceBaseline ?? null,
        trackSelection: parsed.trackSelection ?? null,
```

In `savePersisted`, add to the `trimmed` object built inside the attempts loop:

```ts
      const trimmed: Persisted = {
        lastConfigPath: p.lastConfigPath ?? null,
        studies: strip(baseStudies),
        vehicleConfig: p.vehicleConfig ?? null,
        referenceBaseline: p.referenceBaseline ?? null,
        trackSelection: p.trackSelection ?? null,
      };
```

- [ ] **Step 4: Extend `CfdContext.tsx`**

Add to the performance import (where `SDM26_VEHICLE`/`REFERENCE_2026` are imported):

```ts
import { /* ...existing..., */ DEFAULT_TRACK_SELECTION, type TrackSelection } from "../lib/performance";
```

`State` interface — add the field:

```ts
  vehicleConfig: VehicleConfig;
  referenceBaseline: ReferenceBaseline;
  trackSelection: TrackSelection;
```

`initialState` — add:

```ts
  vehicleConfig: SDM26_VEHICLE,
  referenceBaseline: REFERENCE_2026,
  trackSelection: DEFAULT_TRACK_SELECTION,
```

`Action` union — add the action and extend the `rehydrate` action shape:

```ts
  | { type: "setTrackSelection"; selection: TrackSelection }
```

```ts
  | {
      type: "rehydrate";
      studies: Study[];
      lastConfigPath: string | null;
      vehicleConfig?: VehicleConfig | null;
      referenceBaseline?: ReferenceBaseline | null;
      trackSelection?: TrackSelection | null;
    }
```

`reducer` — add a case (next to `setReferenceBaseline`):

```ts
    case "setTrackSelection":
      return { ...s, trackSelection: a.selection };
```

`reducer` `rehydrate` case — add the field:

```ts
        vehicleConfig: a.vehicleConfig ?? s.vehicleConfig,
        referenceBaseline: a.referenceBaseline ?? s.referenceBaseline,
        trackSelection: a.trackSelection ?? s.trackSelection,
```

`CfdContextValue` interface — add the method:

```ts
  setVehicleConfig: (config: VehicleConfig) => void;
  setReferenceBaseline: (baseline: ReferenceBaseline) => void;
  setTrackSelection: (selection: TrackSelection) => void;
```

The mount-effect `rehydrate` dispatch — add the field:

```ts
      vehicleConfig: persisted.vehicleConfig
        ? { ...SDM26_VEHICLE, ...persisted.vehicleConfig }
        : null,
      referenceBaseline: persisted.referenceBaseline ?? null,
      trackSelection: persisted.trackSelection ?? null,
```

The persist effect — add to the `savePersisted` call and its dep array:

```ts
    savePersisted({
      lastConfigPath: state.loadedConfig?.path ?? null,
      studies,
      vehicleConfig: state.vehicleConfig,
      referenceBaseline: state.referenceBaseline,
      trackSelection: state.trackSelection,
    });
  }, [state.studies, state.loadedConfig, state.hydrated, state.vehicleConfig, state.referenceBaseline, state.trackSelection]);
```

The context `value` methods — add (next to `setReferenceBaseline`):

```ts
      setVehicleConfig: (config) => dispatch({ type: "setVehicleConfig", config }),
      setReferenceBaseline: (baseline) => dispatch({ type: "setReferenceBaseline", baseline }),
      setTrackSelection: (selection) => dispatch({ type: "setTrackSelection", selection }),
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/desktop && pnpm exec vitest run src/modules/cfd/__tests__/trackSelectionState.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck (the State change ripples through the provider)**

Run: `cd apps/desktop && pnpm typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/modules/cfd/lib/cfdStorage.ts apps/desktop/src/modules/cfd/state/CfdContext.tsx apps/desktop/src/modules/cfd/__tests__/trackSelectionState.test.ts
git commit -m "feat(cfd): persist the active track selection"
```

---

### Task 5: Track section on the Performance screen + thread selection into scoring

**Files:**
- Modify: `apps/desktop/src/modules/cfd/screens/PerformanceScreen.tsx`
- Modify: `apps/desktop/src/modules/cfd/results/OptimizationResults.tsx`

- [ ] **Step 1: Add imports to `PerformanceScreen.tsx`** (extend the existing `from "../lib/performance"` import + add the chart):

```ts
import {
  // ...existing: AUTOCROSS_2026, ENDURANCE_2026, trackLength, computeEvents, ...
  lapSpeedProfile,
  tracksFor,
  resolveTrack,
} from "../lib/performance";
import { TrackMap } from "../components/charts/TrackMap";
```

- [ ] **Step 2: Read selection + setter from context, and thread into the existing `computeEvents` memo.** In the component body, `useCfd()` already returns `state` + `setVehicleConfig`/`setReferenceBaseline`; add `setTrackSelection`. Replace the existing events memo (currently `computeEvents(curve, vehicle, baseline)`) with:

```ts
  const trackSelection = cfd.state.trackSelection;

  const events = useMemo(
    () =>
      computeEvents(curve, vehicle, baseline, {
        autocrossTrack: resolveTrack("autocross", trackSelection.autocross),
        enduranceTrack: resolveTrack("endurance", trackSelection.endurance),
      }),
    [curve, vehicle, baseline, trackSelection],
  );
```

> Use the same local names the screen already uses for the torque curve (`curve`), `vehicle`, `baseline`, and the `useCfd()` result (`cfd`). If the screen destructures `setTrackSelection`, add it to that destructure: `const { state, navigateTo, setVehicleConfig, setReferenceBaseline, setTrackSelection } = useCfd();`.

- [ ] **Step 3: Add the Track section** into the section stack (the same place `EventsSection`/vehicle/baseline sections render). Add this component to the file and render `<TrackSection />` in the stack:

```tsx
function TrackSection({
  curve,
  vehicle,
  selection,
  onChange,
}: {
  curve: TorqueCurve;
  vehicle: VehicleConfig;
  selection: TrackSelection;
  onChange: (s: TrackSelection) => void;
}) {
  const ax = resolveTrack("autocross", selection.autocross);
  const en = resolveTrack("endurance", selection.endurance);
  const axProfile = useMemo(() => lapSpeedProfile(curve, vehicle, ax), [curve, vehicle, ax]);
  const enProfile = useMemo(() => lapSpeedProfile(curve, vehicle, en), [curve, vehicle, en]);

  const Row = ({
    kind,
    label,
    activeId,
    profile,
  }: {
    kind: "autocross" | "endurance";
    label: string;
    activeId: string;
    profile: ReturnType<typeof lapSpeedProfile>;
  }) => (
    <div className="mb-3 last:mb-0">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] text-[#D8DCE2]">{label}</span>
        <select
          aria-label={`${label} track`}
          value={activeId}
          onChange={(e) =>
            onChange({ ...selection, [kind]: e.target.value })
          }
          className="rounded-sm border border-[#2A2C32] bg-[#0B0B0D] px-2 py-1 font-mono text-[11px] text-[#D8DCE2] focus:border-[#FFC627] focus:outline-none"
        >
          {tracksFor(kind).map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <TrackMap distance={profile.distance} radius={profile.radius} speedMps={profile.speedMps} />
      <p className="mt-0.5 text-[10px] text-[#5A5F66]">
        {(profile.length / 1000).toFixed(2)} km · curvature (height) · flat-out reference speed (blue→gold)
      </p>
    </div>
  );

  return (
    <section className="rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
      <div className="border-b border-[#2A2C32] px-2 py-1 text-[10px] uppercase tracking-wider text-[#9097A0]">
        tracks
      </div>
      <div className="p-2">
        <Row kind="autocross" label="Autocross" activeId={selection.autocross} profile={axProfile} />
        <Row kind="endurance" label="Endurance" activeId={selection.endurance} profile={enProfile} />
      </div>
    </section>
  );
}
```

Render it in the screen's section stack:

```tsx
            <TrackSection
              curve={curve}
              vehicle={vehicle}
              selection={trackSelection}
              onChange={setTrackSelection}
            />
```

> Add the needed type imports to the file if not present: `import type { TrackSelection } from "../lib/performance";` and `import type { TorqueCurve } from "../lib/performance";` (or wherever `TorqueCurve`/`VehicleConfig` are already imported). The `curve`/`vehicle` passed in are the same values the screen already feeds to `computeEvents`.

- [ ] **Step 4: Thread the selection into the optimizer's event scoring** — in `OptimizationResults.tsx`, the `eventsByTrial` memo calls `computeEvents(torqueCurveFromSweep(t.sweepPoints), vehicle, baseline)`. Add the track opts so the optimizer's FSAE numbers match the active track:

```ts
import { /* ...existing... */ resolveTrack } from "../lib/performance";
```

```ts
    const sel = cfd.state?.trackSelection ?? DEFAULT_TRACK_SELECTION;
    const trackOpts = {
      autocrossTrack: resolveTrack("autocross", sel.autocross),
      enduranceTrack: resolveTrack("endurance", sel.endurance),
    };
    for (const t of study.trials) {
      if (t.sweepPoints && t.sweepPoints.length > 0) {
        map.set(t.trialIdx, computeEvents(torqueCurveFromSweep(t.sweepPoints), vehicle, baseline, trackOpts));
      }
    }
```

Add `cfd.state?.trackSelection` to that memo's dependency array, and import `DEFAULT_TRACK_SELECTION` from `../lib/performance`.

> If the P4 sensitivity plan is also being implemented, apply the same `trackOpts` to its `sensEvents` memo's `computeEvents` call so both panels agree.

- [ ] **Step 5: Typecheck**

Run: `cd apps/desktop && pnpm typecheck`
Expected: clean.

- [ ] **Step 6: Run the CFD suite (no regressions)**

Run: `cd apps/desktop && pnpm exec vitest run src/modules/cfd`
Expected: all pass (existing OptimizationResults/Performance tests still green; track tests pass).

- [ ] **Step 7: Manual verification in the running app**

The dev server is already running. In the app → **CFD** tab → **Performance** screen:
1. Confirm a **"tracks"** section shows two pickers (Autocross / Endurance) each over the 2026 + synthetic options, each with a speed-colored curvature strip below it and a "× km" caption.
2. Switch a picker to the **synthetic** track; confirm the strip redraws (different corner pattern) and the FSAE events table values change (scoring now uses the selected track).
3. **Reload the app** (or restart the dev server) and confirm the selection persists (the previously-chosen track is still active).

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/modules/cfd/screens/PerformanceScreen.tsx apps/desktop/src/modules/cfd/results/OptimizationResults.tsx
git commit -m "feat(cfd): track picker + speed-colored track maps on the Performance screen"
```

---

### Task 6: Changelog

**Files:**
- Create: `v2_changes/51-cfd-track-map-and-persistence.md`

- [ ] **Step 1: Write the changelog entry**

```markdown
# 51 — CFD track map + track persistence

The Performance screen gains a **Tracks** section: pick which course is active for
autocross and endurance (the real traced 2026 courses or the rules-synthesized
fallbacks), see each as a **speed-colored curvature strip**, and the choice now
**persists across reloads** (like the vehicle config and reference baseline).

- The active track feeds FSAE scoring (`computeEvents`) at both the Performance
  screen and the optimizer results, so the map and the numbers agree.
- The map is a curvature-vs-distance strip (bar height = 1/radius, color = local
  speed). The stored track model carries no turn direction, so this is the
  honest visualization rather than a misleading reconstructed overhead.
- Selection persists as a small id pair, sidestepping the `Infinity`-radius JSON
  serialization trap.

Files: `lib/performance/trackRegistry.ts`, `lib/performance/lapSim.ts`
(`lapSpeedProfile`), `components/charts/TrackMap.tsx`, `state/CfdContext.tsx`,
`lib/cfdStorage.ts`, `screens/PerformanceScreen.tsx`.
```

- [ ] **Step 2: Commit**

```bash
git add v2_changes/51-cfd-track-map-and-persistence.md
git commit -m "docs(cfd): changelog for track map + persistence"
```

---

## Self-review checklist (completed)

- **Spec coverage:** "track map" → Tasks 2 (`lapSpeedProfile`) + 3 (`TrackMap`) + 5 (Performance section); "persist loaded tracks" → Tasks 1 (registry/selection) + 4 (state + storage); "selection drives scoring" → Task 5 (both `computeEvents` call sites).
- **Honest-map constraint addressed:** Design decision 1 + Task 3 render a curvature strip, not a fabricated overhead, because the model lacks turn direction/XY (`track.ts:3`, README:16).
- **No placeholders:** every code step has complete code; commands list expected output. The only "use the screen's existing local name" notes are because `curve`/`vehicle`/`baseline`/`cfd` already exist in `PerformanceScreen` and must not be renamed.
- **Type consistency:** `TrackSelection { autocross, endurance }`, `TrackKind`, `TrackOption`, `resolveTrack(kind, id)`, `tracksFor(kind)`, `lapSpeedProfile(...) → { distance, radius, speedMps, step, length }`, and `TrackMap`'s `{ distance, radius, speedMps }` props are used identically across Tasks 1–5. The reducer action `setTrackSelection`/context method `setTrackSelection` names match.
- **Persistence trap avoided:** ids are persisted (not `Track` JSON), so the `radius: Infinity → null` round-trip bug (cfdStorage / track.ts) cannot occur; verified by the Task 4 storage round-trip test.
- **Reuse verified against source:** `EventOpts.autocrossTrack`/`enduranceTrack` exist and default to the 2026 consts (`events.ts:62-69,109-110`); `solveSpeeds`/`discretizeTrack` are in `lapSim.ts`; the `vehicleConfig`/`referenceBaseline` persistence triple in `CfdContext.tsx` (State/Action/reducer/rehydrate/persist-effect/value) is the exact mirrored template; `useElementWidth(ref, 600)` and the dark palette match `ScatterPlot.tsx`.
```
