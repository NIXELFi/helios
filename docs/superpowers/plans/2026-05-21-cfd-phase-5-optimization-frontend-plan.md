# CFD Tab — Phase 5 Optimization (Frontend) Implementation Plan

> Executed autonomously by Claude per user instruction (per `feedback_autonomous_execution` memory). Tasks below are the work items I'm tracking; subagent-driven execution per `superpowers:subagent-driven-development`. Depends on the backend plan `2026-05-21-cfd-phase-5-optimization-backend-plan.md` being merged first.

**Goal:** Add an "Optimization" study type with a parameter-tree picker (every numeric config leaf is opt-in tunable with min/max/step), an objective builder (any `CycleStats` metric × aggregator × RPM list × direction), live per-trial progress, and a results view dominated by a brushable parallel-coordinates plot plus a trial inspector.

**Architecture:** Extend the existing `CfdContext` reducer with `OptimizationStudy` state and four new actions. Subscribe to the new `cfd:job-progress` event variants. Studies screen gets a third "New Optimization" button → multi-step modal: (1) parameters, (2) objective, (3) sampling/cycles. Results screen routes `kind === "optimization"` to a new `OptimizationResults` component built around a hand-rolled SVG `ParallelCoordsPlot` (no D3 dep — uPlot is for time-series, parallel-coords is small enough to write directly).

**Tech Stack:** React 18 · TypeScript · uPlot (existing, for trial-detail curves) · pure-SVG parallel coords (no D3) · Vitest · pnpm/Turbo.

---

## Wave 1 — Types & Tauri bridge

### Task 1: Extend types.ts

**Files:**
- Modify `apps/desktop/src/modules/cfd/state/types.ts`

- [ ] Extend `StudyKind`:

```ts
export type StudyKind = "single-rpm" | "sweep" | "optimization";
```

- [ ] Add parameter schema type (matches Rust `ParameterMeta`):

```ts
export type ParameterType = "scalar" | "array";

export interface ParameterMeta {
  path: string;
  kind: ParameterType;
  arrayLen: number;
  unit: string;
  default: number;
  suggestedMin: number;
  suggestedMax: number;
  group: string;
}
```

- [ ] Add bounds and objective types:

```ts
export interface ParameterBoundsUI {
  /// Backend path (with optional [N] suffix for per-element).
  path: string;
  /// Whether this row is enabled (sent to backend only when true).
  enabled: boolean;
  /// null = uniform; integer = per-element index.
  perElement: number | null;
  min: number;
  max: number;
  step: number | null;
}

export type ObjectiveAggregator =
  | { kind: "max" }
  | { kind: "min" }
  | { kind: "mean" }
  | { kind: "auc" }
  | { kind: "sum" }
  | { kind: "at-rpm"; rpmInt: number };

export type ObjectiveDirection = "maximize" | "minimize";

export interface ObjectiveSpec {
  metric: keyof CycleStats | string; // snake_case in backend
  aggregator: ObjectiveAggregator;
  rpmList: number[];
  direction: ObjectiveDirection;
}

export type SamplerKind = "lhs" | "random";

export interface OptimizationParams {
  tunables: { path: string; min: number; max: number; step: number | null }[];
  objective: ObjectiveSpec;
  nTrials: number;
  sampler: SamplerKind;
  seed: number | null;
  nCyclesMax: number;
  imepRelTol: number;
  minCyclesBeforeCheck: number;
}
```

- [ ] Add trial and study types:

```ts
export type TrialStatus = "pending" | "running" | "done" | "error";

export interface OptimizationTrial {
  trialIdx: number;
  /// path -> physical value (snapped to step grid)
  parameterValues: Record<string, number>;
  status: TrialStatus;
  objectiveValue: number | null;
  sweepPoints: SweepPoint[] | null;
  wallTimeS: number | null;
}

export interface OptimizationStudy {
  id: string;
  kind: "optimization";
  configPath: string;
  params: OptimizationParams;
  status: StudyStatus;
  trials: OptimizationTrial[];
  bestTrialIdx: number | null;
  bestObjectiveValue: number | null;
  parameterPaths: string[];
  objectiveDirection: ObjectiveDirection;
  startedAt: string;
  finishedAt: string | null;
  errorMessage?: string;
}
```

- [ ] Extend the `Study` union type that already exists in this file:

```ts
export type Study = SingleRpmStudy | SweepStudy | OptimizationStudy;
```

- [ ] Run `pnpm --filter helios-desktop typecheck` (or `tsc --noEmit` for the desktop app). Expected: no new errors. Existing code that switches on `study.kind` may need exhaustiveness fixes — leave those for later tasks if they pop up.

- [ ] Commit:

```bash
git add apps/desktop/src/modules/cfd/state/types.ts
git commit -m "feat(cfd-types): OptimizationStudy + ParameterBoundsUI + ObjectiveSpec"
```

### Task 2: Tauri bridge — startOptimization + getParameterSchema

**Files:**
- Modify `apps/desktop/src/modules/cfd/lib/tauriBridge.ts`

- [ ] Add bridge functions matching the existing `startSingleRpm`/`startSweep` style:

```ts
import type { OptimizationParams, ParameterMeta } from "../state/types";

export async function getParameterSchema(configPath: string): Promise<ParameterMeta[]> {
  return invoke<ParameterMeta[]>("cfd_get_parameter_schema", { configPath });
}

export async function startOptimization(
  configPath: string,
  params: OptimizationParams,
): Promise<{ jobId: string }> {
  return invoke<{ jobId: string }>("cfd_start_job", {
    request: {
      kind: "optimization",
      configPath,
      params,
    },
  });
}
```

- [ ] Run `pnpm --filter helios-desktop typecheck`. Expected: clean.

- [ ] Commit:

```bash
git add apps/desktop/src/modules/cfd/lib/tauriBridge.ts
git commit -m "feat(cfd-bridge): startOptimization + getParameterSchema"
```

---

## Wave 2 — Context state machine

### Task 3: Optimization reducer actions

**Files:**
- Modify `apps/desktop/src/modules/cfd/state/CfdContext.tsx`

- [ ] Add four new action types to the existing `CfdAction` discriminated union:

```ts
type CfdAction =
  /* ...existing variants... */
  | { type: "ADD_OPTIMIZATION_STUDY"; study: OptimizationStudy }
  | { type: "OPTIMIZATION_TRIAL_STARTED"; studyId: string; trialIdx: number; parameterValues: Record<string, number> }
  | { type: "OPTIMIZATION_TRIAL_DONE"; studyId: string; trialIdx: number; objectiveValue: number; sweepPoints: SweepPoint[]; wallTimeS: number }
  | { type: "OPTIMIZATION_FINISHED"; studyId: string; bestTrialIdx: number | null; bestObjectiveValue: number | null; status: StudyStatus; finishedAt: string; errorMessage?: string };
```

- [ ] Extend the reducer switch:

```ts
case "ADD_OPTIMIZATION_STUDY":
  return { ...state, studies: { ...state.studies, [action.study.id]: action.study }, activeStudyId: action.study.id };

case "OPTIMIZATION_TRIAL_STARTED": {
  const s = state.studies[action.studyId];
  if (!s || s.kind !== "optimization") return state;
  // Replace the placeholder trial at idx with a running one.
  const trials = [...s.trials];
  trials[action.trialIdx] = {
    trialIdx: action.trialIdx,
    parameterValues: action.parameterValues,
    status: "running",
    objectiveValue: null,
    sweepPoints: null,
    wallTimeS: null,
  };
  return { ...state, studies: { ...state.studies, [action.studyId]: { ...s, trials } } };
}

case "OPTIMIZATION_TRIAL_DONE": {
  const s = state.studies[action.studyId];
  if (!s || s.kind !== "optimization") return state;
  const trials = s.trials.map((t) =>
    t.trialIdx === action.trialIdx
      ? { ...t, status: "done" as const, objectiveValue: action.objectiveValue, sweepPoints: action.sweepPoints, wallTimeS: action.wallTimeS }
      : t,
  );
  return { ...state, studies: { ...state.studies, [action.studyId]: { ...s, trials } } };
}

case "OPTIMIZATION_FINISHED": {
  const s = state.studies[action.studyId];
  if (!s || s.kind !== "optimization") return state;
  return {
    ...state,
    studies: {
      ...state.studies,
      [action.studyId]: {
        ...s,
        status: action.status,
        bestTrialIdx: action.bestTrialIdx,
        bestObjectiveValue: action.bestObjectiveValue,
        finishedAt: action.finishedAt,
        errorMessage: action.errorMessage,
      },
    },
  };
}
```

- [ ] Run `pnpm --filter helios-desktop typecheck`. Expected: clean.

- [ ] Commit:

```bash
git add apps/desktop/src/modules/cfd/state/CfdContext.tsx
git commit -m "feat(cfd-state): optimization reducer actions"
```

### Task 4: Tauri event subscriptions

**Files:**
- Modify `apps/desktop/src/modules/cfd/state/CfdContext.tsx`

- [ ] In the `useEffect` block that already subscribes to `cfd:job-progress`/`cfd:job-done`/etc., add handlers for the new payload variants. The existing dispatcher receives a tagged payload — switch on `payload.kind`:

```ts
const unlistenProgress = await listen<JobProgressPayload>("cfd:job-progress", (e) => {
  const p = e.payload as JobProgressPayload & { kind: string };
  switch (p.kind) {
    case "single-rpm": /* existing */ break;
    case "sweep-rpm-started": /* existing */ break;
    case "sweep-cycle": /* existing */ break;
    case "sweep-rpm-done": /* existing */ break;
    case "optimization-trial-started": {
      const study = findStudyByJobId(state.studies, p.jobId);
      if (study) dispatch({ type: "OPTIMIZATION_TRIAL_STARTED", studyId: study.id, trialIdx: p.trialIdx, parameterValues: p.parameterValues });
      break;
    }
    case "optimization-trial-done": {
      const study = findStudyByJobId(state.studies, p.jobId);
      if (study) dispatch({ type: "OPTIMIZATION_TRIAL_DONE", studyId: study.id, trialIdx: p.trialIdx, objectiveValue: p.objectiveValue, sweepPoints: p.sweepPoints, wallTimeS: p.wallTimeS });
      break;
    }
  }
});
```

- [ ] In the `cfd:job-done` handler, switch on `summary.kind === "optimization"` and dispatch `OPTIMIZATION_FINISHED` with `bestTrialIdx` and `bestObjectiveValue`.

- [ ] In the `cfd:job-cancelled` and `cfd:job-error` handlers, also dispatch `OPTIMIZATION_FINISHED` (status `cancelled` / `error`).

- [ ] Helper at top of file:

```ts
function findStudyByJobId(studies: Record<string, Study>, jobId: string): Study | undefined {
  return Object.values(studies).find((s) => s.id === jobId);
}
```

(Job IDs and study IDs are the same — that's the existing convention.)

- [ ] Run `pnpm --filter helios-desktop typecheck`. Expected: clean.

- [ ] Commit:

```bash
git add apps/desktop/src/modules/cfd/state/CfdContext.tsx
git commit -m "feat(cfd-state): subscribe to optimization-trial-* events"
```

### Task 5: startOptimization public method

**Files:**
- Modify `apps/desktop/src/modules/cfd/state/CfdContext.tsx`

- [ ] Add the public method on the context value, mirroring `startSingleRpm`/`startSweep`:

```ts
async function startOptimization(configPath: string, params: OptimizationParams): Promise<void> {
  const { jobId } = await bridge.startOptimization(configPath, params);
  const study: OptimizationStudy = {
    id: jobId,
    kind: "optimization",
    configPath,
    params,
    status: "running",
    trials: Array.from({ length: params.nTrials }, (_, i) => ({
      trialIdx: i,
      parameterValues: {},
      status: "pending",
      objectiveValue: null,
      sweepPoints: null,
      wallTimeS: null,
    })),
    bestTrialIdx: null,
    bestObjectiveValue: null,
    parameterPaths: params.tunables.map((t) => t.path),
    objectiveDirection: params.objective.direction,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  dispatch({ type: "ADD_OPTIMIZATION_STUDY", study });
}
```

- [ ] Export it on the context value object alongside `startSingleRpm` and `startSweep`. Also export it from the `CfdContextValue` type at the top of the file.

- [ ] Run `pnpm --filter helios-desktop typecheck`. Expected: clean.

- [ ] Commit:

```bash
git add apps/desktop/src/modules/cfd/state/CfdContext.tsx
git commit -m "feat(cfd-state): startOptimization public method"
```

### Task 6: Reducer unit tests

**Files:**
- Modify `apps/desktop/src/modules/cfd/__tests__/CfdContext.test.tsx`

- [ ] Add four tests:

```ts
import { describe, it, expect } from "vitest";
import { reducer, initialState } from "../state/CfdContext"; // export these if not already

describe("optimization reducer", () => {
  const baseStudy = (overrides = {}) => ({
    id: "opt-1", kind: "optimization" as const, configPath: "/x.json",
    params: {} as any, status: "running" as const, trials: [
      { trialIdx: 0, parameterValues: {}, status: "pending" as const, objectiveValue: null, sweepPoints: null, wallTimeS: null },
      { trialIdx: 1, parameterValues: {}, status: "pending" as const, objectiveValue: null, sweepPoints: null, wallTimeS: null },
    ],
    bestTrialIdx: null, bestObjectiveValue: null, parameterPaths: ["restrictor.cd"],
    objectiveDirection: "maximize" as const,
    startedAt: "2026-05-21T00:00:00Z", finishedAt: null, ...overrides,
  });

  it("ADD_OPTIMIZATION_STUDY puts study in registry and activates it", () => {
    const s = reducer(initialState, { type: "ADD_OPTIMIZATION_STUDY", study: baseStudy() });
    expect(s.studies["opt-1"]).toBeDefined();
    expect(s.activeStudyId).toBe("opt-1");
  });

  it("TRIAL_STARTED transitions pending → running with parameterValues", () => {
    const s0 = reducer(initialState, { type: "ADD_OPTIMIZATION_STUDY", study: baseStudy() });
    const s1 = reducer(s0, { type: "OPTIMIZATION_TRIAL_STARTED", studyId: "opt-1", trialIdx: 1, parameterValues: { "restrictor.cd": 0.88 } });
    expect((s1.studies["opt-1"] as any).trials[1].status).toBe("running");
    expect((s1.studies["opt-1"] as any).trials[1].parameterValues["restrictor.cd"]).toBe(0.88);
  });

  it("TRIAL_DONE populates objective and sweep points", () => {
    const s0 = reducer(initialState, { type: "ADD_OPTIMIZATION_STUDY", study: baseStudy() });
    const s1 = reducer(s0, { type: "OPTIMIZATION_TRIAL_DONE", studyId: "opt-1", trialIdx: 0, objectiveValue: 9.4, sweepPoints: [], wallTimeS: 1.23 });
    expect((s1.studies["opt-1"] as any).trials[0].status).toBe("done");
    expect((s1.studies["opt-1"] as any).trials[0].objectiveValue).toBe(9.4);
  });

  it("FINISHED sets bestTrialIdx and final status", () => {
    const s0 = reducer(initialState, { type: "ADD_OPTIMIZATION_STUDY", study: baseStudy() });
    const s1 = reducer(s0, { type: "OPTIMIZATION_FINISHED", studyId: "opt-1", bestTrialIdx: 1, bestObjectiveValue: 9.7, status: "done", finishedAt: "2026-05-21T00:01:00Z" });
    expect((s1.studies["opt-1"] as any).status).toBe("done");
    expect((s1.studies["opt-1"] as any).bestTrialIdx).toBe(1);
  });
});
```

- [ ] If `reducer` and `initialState` aren't exported, export them from `CfdContext.tsx`.

- [ ] Run `pnpm --filter helios-desktop test -- CfdContext`. Expected: existing + 4 new tests pass.

- [ ] Commit:

```bash
git add apps/desktop/src/modules/cfd/state/CfdContext.tsx apps/desktop/src/modules/cfd/__tests__/CfdContext.test.tsx
git commit -m "test(cfd-state): optimization reducer transitions"
```

---

## Wave 3 — Parameter panel

### Task 7: useParameterSchema hook

**Files:**
- Create `apps/desktop/src/modules/cfd/lib/useParameterSchema.ts`

- [ ] Hook:

```ts
import { useEffect, useState } from "react";
import { getParameterSchema } from "./tauriBridge";
import type { ParameterMeta } from "../state/types";

export interface ParameterSchemaState {
  schema: ParameterMeta[] | null;
  loading: boolean;
  error: string | null;
}

export function useParameterSchema(configPath: string | null): ParameterSchemaState {
  const [state, setState] = useState<ParameterSchemaState>({ schema: null, loading: false, error: null });
  useEffect(() => {
    if (!configPath) { setState({ schema: null, loading: false, error: null }); return; }
    let cancelled = false;
    setState({ schema: null, loading: true, error: null });
    getParameterSchema(configPath)
      .then((s) => { if (!cancelled) setState({ schema: s, loading: false, error: null }); })
      .catch((e) => { if (!cancelled) setState({ schema: null, loading: false, error: String(e) }); });
    return () => { cancelled = true; };
  }, [configPath]);
  return state;
}
```

- [ ] No tests for this — it's a thin wrapper. Run `pnpm --filter helios-desktop typecheck`. Expected: clean.

- [ ] Commit:

```bash
git add apps/desktop/src/modules/cfd/lib/useParameterSchema.ts
git commit -m "feat(cfd-lib): useParameterSchema hook"
```

### Task 8: ParameterRow component (single leaf)

**Files:**
- Create `apps/desktop/src/modules/cfd/components/optimization/ParameterRow.tsx`

- [ ] Component renders one row in the parameter table:

```tsx
import React from "react";
import type { ParameterMeta, ParameterBoundsUI } from "../../state/types";

interface Props {
  meta: ParameterMeta;
  bounds: ParameterBoundsUI;
  onChange: (next: ParameterBoundsUI) => void;
}

export function ParameterRow({ meta, bounds, onChange }: Props) {
  const setField = <K extends keyof ParameterBoundsUI>(k: K, v: ParameterBoundsUI[K]) =>
    onChange({ ...bounds, [k]: v });

  return (
    <tr className={bounds.enabled ? "" : "opacity-50"}>
      <td className="px-2 py-1">
        <input
          type="checkbox"
          checked={bounds.enabled}
          onChange={(e) => setField("enabled", e.target.checked)}
          aria-label={`Enable ${meta.path} as tunable`}
        />
      </td>
      <td className="px-2 py-1 font-mono text-sm">
        {meta.path}
        {meta.kind === "array" && bounds.perElement !== null && <span className="text-zinc-500">[{bounds.perElement}]</span>}
      </td>
      <td className="px-2 py-1 text-xs text-zinc-500">{meta.unit}</td>
      <td className="px-2 py-1 text-xs text-zinc-500 font-mono">{meta.default.toPrecision(4)}</td>
      <td className="px-2 py-1">
        <NumberInput value={bounds.min} disabled={!bounds.enabled} onChange={(v) => setField("min", v)} />
      </td>
      <td className="px-2 py-1">
        <NumberInput value={bounds.max} disabled={!bounds.enabled} onChange={(v) => setField("max", v)} />
      </td>
      <td className="px-2 py-1">
        <NumberInput value={bounds.step ?? 0} disabled={!bounds.enabled} placeholder="continuous" onChange={(v) => setField("step", v > 0 ? v : null)} />
      </td>
      {meta.kind === "array" && (
        <td className="px-2 py-1">
          <select
            value={bounds.perElement ?? "uniform"}
            disabled={!bounds.enabled}
            onChange={(e) => setField("perElement", e.target.value === "uniform" ? null : Number(e.target.value))}
            className="text-xs bg-zinc-800 border border-zinc-700 rounded px-1"
          >
            <option value="uniform">uniform</option>
            {Array.from({ length: meta.arrayLen }, (_, i) => (
              <option key={i} value={i}>cyl {i}</option>
            ))}
          </select>
        </td>
      )}
    </tr>
  );
}

function NumberInput({ value, onChange, disabled, placeholder }: { value: number; onChange: (n: number) => void; disabled?: boolean; placeholder?: string }) {
  return (
    <input
      type="number"
      value={Number.isFinite(value) ? value : ""}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-24 bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-sm font-mono disabled:opacity-50"
      step="any"
    />
  );
}
```

- [ ] No test for this thin presentational component yet — covered by panel-level test in Task 9.

- [ ] Commit:

```bash
git add apps/desktop/src/modules/cfd/components/optimization/ParameterRow.tsx
git commit -m "feat(cfd-ui): ParameterRow with enable + min/max/step/per-element"
```

### Task 9: ParameterPanel — full tree grouped by category

**Files:**
- Create `apps/desktop/src/modules/cfd/components/optimization/ParameterPanel.tsx`
- Create `apps/desktop/src/modules/cfd/__tests__/ParameterPanel.test.tsx`

- [ ] Panel:

```tsx
import React from "react";
import type { ParameterMeta, ParameterBoundsUI } from "../../state/types";
import { ParameterRow } from "./ParameterRow";

interface Props {
  schema: ParameterMeta[];
  bounds: ParameterBoundsUI[];
  onChange: (next: ParameterBoundsUI[]) => void;
}

export function ParameterPanel({ schema, bounds, onChange }: Props) {
  // Group meta by group label.
  const byGroup = new Map<string, ParameterMeta[]>();
  for (const m of schema) {
    const list = byGroup.get(m.group) ?? [];
    list.push(m);
    byGroup.set(m.group, list);
  }

  // Index bounds by path for fast lookup.
  const idx = new Map(bounds.map((b, i) => [b.path, i]));

  function update(path: string, next: ParameterBoundsUI) {
    const i = idx.get(path);
    if (i === undefined) {
      onChange([...bounds, next]);
    } else {
      const copy = bounds.slice();
      copy[i] = next;
      onChange(copy);
    }
  }

  return (
    <div className="space-y-4">
      {Array.from(byGroup.entries()).map(([group, metas]) => (
        <section key={group}>
          <h3 className="text-sm font-semibold text-zinc-300 mb-1">{group}</h3>
          <table className="w-full text-sm">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="text-left px-2">on</th>
                <th className="text-left px-2">path</th>
                <th className="text-left px-2">unit</th>
                <th className="text-left px-2">default</th>
                <th className="text-left px-2">min</th>
                <th className="text-left px-2">max</th>
                <th className="text-left px-2">step</th>
                <th className="text-left px-2">scope</th>
              </tr>
            </thead>
            <tbody>
              {metas.map((m) => {
                const existing = bounds.find((b) => b.path === m.path);
                const b: ParameterBoundsUI = existing ?? {
                  path: m.path,
                  enabled: false,
                  perElement: null,
                  min: m.suggestedMin,
                  max: m.suggestedMax,
                  step: null,
                };
                return <ParameterRow key={m.path} meta={m} bounds={b} onChange={(next) => update(m.path, next)} />;
              })}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
```

- [ ] Test:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ParameterPanel } from "../components/optimization/ParameterPanel";

const schema = [
  { path: "restrictor.cd", kind: "scalar" as const, arrayLen: 1, unit: "-", default: 0.9, suggestedMin: 0.7, suggestedMax: 1.0, group: "Restrictor" },
  { path: "intake.runner_length", kind: "array" as const, arrayLen: 4, unit: "m", default: 0.25, suggestedMin: 0.1, suggestedMax: 0.5, group: "Intake" },
];

describe("ParameterPanel", () => {
  it("renders one row per schema entry grouped by category", () => {
    render(<ParameterPanel schema={schema} bounds={[]} onChange={vi.fn()} />);
    expect(screen.getByText("Restrictor")).toBeInTheDocument();
    expect(screen.getByText("Intake")).toBeInTheDocument();
    expect(screen.getByText("restrictor.cd")).toBeInTheDocument();
    expect(screen.getByText("intake.runner_length")).toBeInTheDocument();
  });

  it("toggling enabled fires onChange with enabled=true", () => {
    const onChange = vi.fn();
    render(<ParameterPanel schema={schema} bounds={[]} onChange={onChange} />);
    const checkbox = screen.getByLabelText("Enable restrictor.cd as tunable");
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next.find((b: any) => b.path === "restrictor.cd").enabled).toBe(true);
  });
});
```

- [ ] Run `pnpm --filter helios-desktop test -- ParameterPanel`. Expected: 2 tests pass.

- [ ] Commit:

```bash
git add apps/desktop/src/modules/cfd/components/optimization/ apps/desktop/src/modules/cfd/__tests__/ParameterPanel.test.tsx
git commit -m "feat(cfd-ui): ParameterPanel with grouped tables + per-element scope picker"
```

---

## Wave 4 — Objective builder

### Task 10: ObjectiveBuilder component

**Files:**
- Create `apps/desktop/src/modules/cfd/components/optimization/ObjectiveBuilder.tsx`
- Create `apps/desktop/src/modules/cfd/__tests__/ObjectiveBuilder.test.tsx`

- [ ] Component:

```tsx
import React from "react";
import type { ObjectiveSpec, ObjectiveAggregator } from "../../state/types";
import { parseRpmList } from "../../lib/rpmList";

const METRICS: { value: string; label: string }[] = [
  { value: "imep_bar", label: "IMEP (bar)" },
  { value: "bmep_bar", label: "BMEP (bar)" },
  { value: "fmep_bar", label: "FMEP (bar)" },
  { value: "ve_atm", label: "VE_atm (-)" },
  { value: "indicated_power_k_w", label: "Indicated power (kW)" },
  { value: "brake_power_k_w", label: "Brake power (kW)" },
  { value: "wheel_power_k_w", label: "Wheel power (kW)" },
  { value: "indicated_torque_nm", label: "Indicated torque (Nm)" },
  { value: "brake_torque_nm", label: "Brake torque (Nm)" },
  { value: "wheel_torque_nm", label: "Wheel torque (Nm)" },
  { value: "egt_mean", label: "EGT mean (K)" },
  { value: "intake_mass_per_cycle_g", label: "Intake mass/cycle (g)" },
  { value: "f_residual", label: "Residual fraction (-)" },
  { value: "mass_total", label: "Mass total (kg)" },
  { value: "nonconservation", label: "Non-conservation (kg)" },
];

interface Props {
  value: ObjectiveSpec;
  rpmListText: string;
  onRpmListTextChange: (t: string) => void;
  onChange: (next: ObjectiveSpec) => void;
}

export function ObjectiveBuilder({ value, rpmListText, onRpmListTextChange, onChange }: Props) {
  const setAggregator = (kind: ObjectiveAggregator["kind"]) => {
    const next: ObjectiveAggregator = kind === "at-rpm"
      ? { kind: "at-rpm", rpmInt: value.rpmList[0] ? Math.round(value.rpmList[0]) : 6000 }
      : { kind } as ObjectiveAggregator;
    onChange({ ...value, aggregator: next });
  };

  const rpmParse = parseRpmList(rpmListText);

  return (
    <div className="space-y-3">
      <label className="block">
        <span className="text-xs text-zinc-400">Metric</span>
        <select
          value={value.metric}
          onChange={(e) => onChange({ ...value, metric: e.target.value })}
          className="block w-full mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm"
        >
          {METRICS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </label>

      <label className="block">
        <span className="text-xs text-zinc-400">Aggregator</span>
        <select
          value={value.aggregator.kind}
          onChange={(e) => setAggregator(e.target.value as ObjectiveAggregator["kind"])}
          className="block w-full mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm"
        >
          <option value="max">Max across RPM list</option>
          <option value="min">Min across RPM list</option>
          <option value="mean">Mean across RPM list</option>
          <option value="auc">Area under curve (trapezoidal)</option>
          <option value="sum">Sum across RPM list</option>
          <option value="at-rpm">At specific RPM</option>
        </select>
      </label>

      {value.aggregator.kind === "at-rpm" && (
        <label className="block">
          <span className="text-xs text-zinc-400">RPM</span>
          <input
            type="number"
            value={value.aggregator.rpmInt}
            onChange={(e) => onChange({ ...value, aggregator: { kind: "at-rpm", rpmInt: Number(e.target.value) } })}
            className="block w-32 mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm font-mono"
          />
        </label>
      )}

      <label className="block">
        <span className="text-xs text-zinc-400">RPM list (e.g. 4000, 6000:12000:1000)</span>
        <input
          type="text"
          value={rpmListText}
          onChange={(e) => onRpmListTextChange(e.target.value)}
          className="block w-full mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm font-mono"
        />
        {rpmParse.error
          ? <p className="text-xs text-red-400 mt-1">{rpmParse.error}</p>
          : <p className="text-xs text-zinc-500 mt-1">{rpmParse.values.length} RPMs: {rpmParse.values.slice(0, 6).join(", ")}{rpmParse.values.length > 6 ? "…" : ""}</p>
        }
      </label>

      <fieldset className="flex gap-3">
        <legend className="text-xs text-zinc-400">Direction</legend>
        <label className="flex items-center gap-1 text-sm">
          <input type="radio" checked={value.direction === "maximize"} onChange={() => onChange({ ...value, direction: "maximize" })} /> maximize
        </label>
        <label className="flex items-center gap-1 text-sm">
          <input type="radio" checked={value.direction === "minimize"} onChange={() => onChange({ ...value, direction: "minimize" })} /> minimize
        </label>
      </fieldset>
    </div>
  );
}
```

- [ ] Test:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ObjectiveBuilder } from "../components/optimization/ObjectiveBuilder";

const baseValue = {
  metric: "imep_bar",
  aggregator: { kind: "max" as const },
  rpmList: [6000],
  direction: "maximize" as const,
};

describe("ObjectiveBuilder", () => {
  it("switching aggregator to at-rpm renders rpm input", () => {
    const onChange = vi.fn();
    render(<ObjectiveBuilder value={baseValue} rpmListText="6000" onRpmListTextChange={vi.fn()} onChange={onChange} />);
    fireEvent.change(screen.getByDisplayValue("Max across RPM list"), { target: { value: "at-rpm" } });
    expect(onChange).toHaveBeenCalled();
  });

  it("invalid rpm list surfaces error message", () => {
    render(<ObjectiveBuilder value={baseValue} rpmListText="hi" onRpmListTextChange={vi.fn()} onChange={vi.fn()} />);
    expect(screen.getByText(/.+/, { selector: ".text-red-400" })).toBeInTheDocument();
  });
});
```

- [ ] Run `pnpm --filter helios-desktop test -- ObjectiveBuilder`. Expected: 2 tests pass.

- [ ] Commit:

```bash
git add apps/desktop/src/modules/cfd/components/optimization/ObjectiveBuilder.tsx apps/desktop/src/modules/cfd/__tests__/ObjectiveBuilder.test.tsx
git commit -m "feat(cfd-ui): ObjectiveBuilder — metric/aggregator/rpm-list/direction"
```

---

## Wave 5 — Optimization modal + Studies integration

### Task 11: OptimizationParamsModal

**Files:**
- Create `apps/desktop/src/modules/cfd/components/optimization/OptimizationParamsModal.tsx`

- [ ] Modal with three vertical sections (no tabs — just scrollable, simpler):

```tsx
import React, { useState, useMemo } from "react";
import type { OptimizationParams, ParameterBoundsUI, ObjectiveSpec } from "../../state/types";
import { useParameterSchema } from "../../lib/useParameterSchema";
import { parseRpmList } from "../../lib/rpmList";
import { ParameterPanel } from "./ParameterPanel";
import { ObjectiveBuilder } from "./ObjectiveBuilder";

interface Props {
  configPath: string;
  open: boolean;
  onClose: () => void;
  onSubmit: (params: OptimizationParams) => void;
}

export function OptimizationParamsModal({ configPath, open, onClose, onSubmit }: Props) {
  const { schema, loading, error } = useParameterSchema(open ? configPath : null);
  const [bounds, setBounds] = useState<ParameterBoundsUI[]>([]);
  const [objective, setObjective] = useState<ObjectiveSpec>({
    metric: "imep_bar",
    aggregator: { kind: "max" },
    rpmList: [6000, 8000, 10000],
    direction: "maximize",
  });
  const [rpmListText, setRpmListText] = useState("6000:10000:2000");
  const [nTrials, setNTrials] = useState(32);
  const [sampler, setSampler] = useState<"lhs" | "random">("lhs");
  const [seedText, setSeedText] = useState("");
  const [nCyclesMax, setNCyclesMax] = useState(8);

  const rpmParse = useMemo(() => parseRpmList(rpmListText), [rpmListText]);

  const enabled = bounds.filter((b) => b.enabled);
  const validationErrors: string[] = [];
  if (enabled.length === 0) validationErrors.push("Enable at least 1 tunable parameter.");
  enabled.forEach((b) => {
    if (!(b.min < b.max)) validationErrors.push(`${b.path}: min must be < max.`);
  });
  if (rpmParse.error) validationErrors.push(`RPM list: ${rpmParse.error}`);
  if (objective.aggregator.kind === "at-rpm" && !rpmParse.values.includes(objective.aggregator.rpmInt)) {
    validationErrors.push(`Objective RPM (${objective.aggregator.rpmInt}) not in RPM list.`);
  }
  if (!Number.isInteger(nTrials) || nTrials < 2 || nTrials > 500) validationErrors.push("nTrials must be 2..500.");

  if (!open) return null;

  function submit() {
    if (validationErrors.length > 0) return;
    onSubmit({
      tunables: enabled.map((b) => ({
        path: b.perElement !== null ? `${b.path}[${b.perElement}]` : b.path,
        min: b.min, max: b.max, step: b.step,
      })),
      objective: { ...objective, rpmList: rpmParse.values },
      nTrials,
      sampler,
      seed: seedText.trim() === "" ? null : Number(seedText),
      nCyclesMax,
      imepRelTol: 1e-3,
      minCyclesBeforeCheck: 3,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="dialog" aria-modal="true">
      <div className="bg-zinc-900 border border-zinc-700 rounded-lg w-[1100px] max-h-[85vh] flex flex-col">
        <header className="px-4 py-2 border-b border-zinc-800 flex justify-between items-center">
          <h2 className="text-base font-semibold">New optimization</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-white">✕</button>
        </header>
        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          <section>
            <h3 className="text-sm font-semibold text-zinc-300 mb-2">1. Parameters</h3>
            {loading && <p className="text-sm text-zinc-500">Loading schema…</p>}
            {error && <p className="text-sm text-red-400">{error}</p>}
            {schema && <ParameterPanel schema={schema} bounds={bounds} onChange={setBounds} />}
          </section>

          <section>
            <h3 className="text-sm font-semibold text-zinc-300 mb-2">2. Objective</h3>
            <ObjectiveBuilder
              value={objective}
              rpmListText={rpmListText}
              onRpmListTextChange={setRpmListText}
              onChange={setObjective}
            />
          </section>

          <section>
            <h3 className="text-sm font-semibold text-zinc-300 mb-2">3. Sampling</h3>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs text-zinc-400">Trials</span>
                <input type="number" value={nTrials} min={2} max={500}
                  onChange={(e) => setNTrials(Number(e.target.value))}
                  className="block w-32 mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm font-mono" />
              </label>
              <label className="block">
                <span className="text-xs text-zinc-400">Sampler</span>
                <select value={sampler} onChange={(e) => setSampler(e.target.value as "lhs"|"random")}
                  className="block w-32 mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm">
                  <option value="lhs">Latin hypercube</option>
                  <option value="random">Uniform random</option>
                </select>
              </label>
              <label className="block">
                <span className="text-xs text-zinc-400">Seed (blank = random)</span>
                <input type="text" value={seedText} onChange={(e) => setSeedText(e.target.value)}
                  className="block w-32 mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm font-mono" />
              </label>
              <label className="block">
                <span className="text-xs text-zinc-400">Max cycles per RPM</span>
                <input type="number" value={nCyclesMax} min={1} max={50}
                  onChange={(e) => setNCyclesMax(Number(e.target.value))}
                  className="block w-32 mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm font-mono" />
              </label>
            </div>
          </section>
        </div>
        <footer className="px-4 py-2 border-t border-zinc-800 flex justify-between items-center">
          <ul className="text-xs text-red-400 list-disc ml-4">
            {validationErrors.slice(0, 3).map((e, i) => <li key={i}>{e}</li>)}
          </ul>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1 text-sm rounded border border-zinc-700 hover:bg-zinc-800">Cancel</button>
            <button onClick={submit} disabled={validationErrors.length > 0}
              className="px-3 py-1 text-sm rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed">
              Start optimization ({enabled.length} params × {nTrials} trials × {rpmParse.values.length} RPMs)
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
```

- [ ] Skip a dedicated test — coverage by Studies-screen integration test in Task 12.

- [ ] Commit:

```bash
git add apps/desktop/src/modules/cfd/components/optimization/OptimizationParamsModal.tsx
git commit -m "feat(cfd-ui): OptimizationParamsModal — parameters + objective + sampling"
```

### Task 12: Wire modal into StudiesScreen

**Files:**
- Modify `apps/desktop/src/modules/cfd/screens/StudiesScreen.tsx`

- [ ] Add third button + modal state alongside the existing single-rpm and sweep buttons:

```tsx
const [optimizationOpen, setOptimizationOpen] = useState(false);

// ...inside the "New study" toolbar group, after the existing "Sweep" button:
<button onClick={() => setOptimizationOpen(true)}
  disabled={!loadedConfig}
  className="px-3 py-1 text-sm rounded border border-zinc-700 hover:bg-zinc-800 disabled:opacity-50">
  Optimization…
</button>

// ...near the bottom of the component's JSX:
{loadedConfig && (
  <OptimizationParamsModal
    configPath={loadedConfig.path}
    open={optimizationOpen}
    onClose={() => setOptimizationOpen(false)}
    onSubmit={(params) => {
      setOptimizationOpen(false);
      void startOptimization(loadedConfig.path, params);
    }}
  />
)}
```

- [ ] Pull `startOptimization` from `useCfd()` context destructure.

- [ ] Run `pnpm --filter helios-desktop typecheck`. Expected: clean.

- [ ] Commit:

```bash
git add apps/desktop/src/modules/cfd/screens/StudiesScreen.tsx
git commit -m "feat(cfd-ui): Optimization button + modal wired into Studies screen"
```

---

## Wave 6 — Results: parallel coordinates + inspector

### Task 13: ParallelCoordsPlot — pure SVG

**Files:**
- Create `apps/desktop/src/modules/cfd/components/charts/ParallelCoordsPlot.tsx`
- Create `apps/desktop/src/modules/cfd/__tests__/ParallelCoordsPlot.test.tsx`

- [ ] Component (hand-rolled SVG; no D3):

```tsx
import React, { useMemo } from "react";

export interface ParallelCoordsTrial {
  trialIdx: number;
  values: number[]; // length = axes.length - 1 (last is objective)
  objective: number;
  highlighted?: boolean;
  bestTrial?: boolean;
}

interface Props {
  axes: { label: string; min: number; max: number }[]; // last axis is the objective
  trials: ParallelCoordsTrial[];
  height?: number;
  onTrialClick?: (trialIdx: number) => void;
  selectedTrialIdx?: number | null;
}

export function ParallelCoordsPlot({ axes, trials, height = 360, onTrialClick, selectedTrialIdx }: Props) {
  const width = Math.max(600, axes.length * 120);
  const padLeft = 40, padRight = 40, padTop = 24, padBottom = 24;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const axisX = (i: number) => padLeft + (axes.length === 1 ? plotW / 2 : (plotW * i) / (axes.length - 1));

  const yOf = (axisIdx: number, value: number) => {
    const ax = axes[axisIdx];
    if (ax.max === ax.min) return padTop + plotH / 2;
    const t = (value - ax.min) / (ax.max - ax.min);
    return padTop + plotH * (1 - t);
  };

  const objMin = axes[axes.length - 1].min;
  const objMax = axes[axes.length - 1].max;
  const colorFor = (obj: number) => {
    if (objMax === objMin) return "rgba(99,102,241,0.6)"; // indigo-500
    const t = (obj - objMin) / (objMax - objMin);
    // viridis-ish, simple lerp from blue → yellow
    const r = Math.round(68 + (253 - 68) * t);
    const g = Math.round(1 + (231 - 1) * t);
    const b = Math.round(84 + (37 - 84) * t);
    return `rgba(${r},${g},${b},0.7)`;
  };

  const allValues = useMemo(() => trials.map((t) => [...t.values, t.objective]), [trials]);

  return (
    <svg width={width} height={height} role="img" aria-label="Parallel coordinates of trials">
      {/* Axes */}
      {axes.map((ax, i) => (
        <g key={i}>
          <line x1={axisX(i)} y1={padTop} x2={axisX(i)} y2={padTop + plotH} stroke="#3f3f46" />
          <text x={axisX(i)} y={padTop - 6} fontSize="10" fill="#a1a1aa" textAnchor="middle">{ax.label}</text>
          <text x={axisX(i)} y={padTop} fontSize="9" fill="#71717a" textAnchor="middle" dy="-12">{ax.max.toPrecision(3)}</text>
          <text x={axisX(i)} y={padTop + plotH + 12} fontSize="9" fill="#71717a" textAnchor="middle">{ax.min.toPrecision(3)}</text>
        </g>
      ))}

      {/* Trials */}
      {trials.map((t, idx) => {
        const points = allValues[idx].map((v, i) => `${axisX(i)},${yOf(i, v)}`).join(" ");
        const isSel = selectedTrialIdx === t.trialIdx;
        return (
          <polyline
            key={t.trialIdx}
            points={points}
            fill="none"
            stroke={isSel ? "#fafafa" : t.bestTrial ? "#fbbf24" : colorFor(t.objective)}
            strokeWidth={isSel ? 2 : t.bestTrial ? 2 : 1}
            style={{ cursor: onTrialClick ? "pointer" : "default" }}
            onClick={() => onTrialClick?.(t.trialIdx)}
          />
        );
      })}
    </svg>
  );
}
```

- [ ] Test:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ParallelCoordsPlot } from "../components/charts/ParallelCoordsPlot";

describe("ParallelCoordsPlot", () => {
  it("renders one polyline per trial", () => {
    const { container } = render(<ParallelCoordsPlot
      axes={[{ label: "x", min: 0, max: 1 }, { label: "y", min: 0, max: 10 }]}
      trials={[
        { trialIdx: 0, values: [0.2], objective: 5 },
        { trialIdx: 1, values: [0.7], objective: 8 },
      ]}
    />);
    expect(container.querySelectorAll("polyline")).toHaveLength(2);
  });

  it("clicking polyline fires onTrialClick with trialIdx", () => {
    const onClick = vi.fn();
    const { container } = render(<ParallelCoordsPlot
      axes={[{ label: "x", min: 0, max: 1 }, { label: "y", min: 0, max: 10 }]}
      trials={[{ trialIdx: 7, values: [0.5], objective: 6 }]}
      onTrialClick={onClick}
    />);
    fireEvent.click(container.querySelector("polyline")!);
    expect(onClick).toHaveBeenCalledWith(7);
  });

  it("handles empty trials without crashing", () => {
    const { container } = render(<ParallelCoordsPlot
      axes={[{ label: "x", min: 0, max: 1 }]}
      trials={[]}
    />);
    expect(container.querySelectorAll("polyline")).toHaveLength(0);
  });
});
```

- [ ] Run `pnpm --filter helios-desktop test -- ParallelCoordsPlot`. Expected: 3 tests pass.

- [ ] Commit:

```bash
git add apps/desktop/src/modules/cfd/components/charts/ParallelCoordsPlot.tsx apps/desktop/src/modules/cfd/__tests__/ParallelCoordsPlot.test.tsx
git commit -m "feat(cfd-ui): ParallelCoordsPlot SVG primitive"
```

### Task 14: TrialInspector

**Files:**
- Create `apps/desktop/src/modules/cfd/results/TrialInspector.tsx`

- [ ] Inspector showing one selected trial's parameter values + its sweep result curve (reusing existing `LinePlot`):

```tsx
import React from "react";
import type { OptimizationTrial } from "../state/types";
import { LinePlot } from "../components/charts/LinePlot";

interface Props {
  trial: OptimizationTrial;
  parameterPaths: string[];
}

export function TrialInspector({ trial, parameterPaths }: Props) {
  const rpms = trial.sweepPoints?.map((p) => p.rpm) ?? [];
  const torque = trial.sweepPoints?.map((p) => p.lastCycle.brakeTorqueNm) ?? [];
  const power  = trial.sweepPoints?.map((p) => p.lastCycle.brakePowerKW) ?? [];
  const imep   = trial.sweepPoints?.map((p) => p.lastCycle.imepBar) ?? [];

  return (
    <div className="space-y-3">
      <header className="text-sm">
        <span className="font-semibold">Trial #{trial.trialIdx}</span>
        <span className="ml-2 text-zinc-500">obj = {trial.objectiveValue?.toPrecision(5) ?? "—"}</span>
        <span className="ml-2 text-zinc-500">{trial.wallTimeS?.toFixed(2) ?? "—"} s</span>
      </header>

      <div>
        <h4 className="text-xs text-zinc-400 mb-1">Parameter values</h4>
        <table className="text-xs font-mono">
          <tbody>
            {parameterPaths.map((p) => (
              <tr key={p}><td className="pr-3 text-zinc-500">{p}</td><td>{trial.parameterValues[p]?.toPrecision(5) ?? "—"}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      {trial.sweepPoints && trial.sweepPoints.length > 0 && (
        <div className="space-y-2">
          <LinePlot xs={rpms} ys={[torque]} labels={["brake torque (Nm)"]} xLabel="RPM" height={140} />
          <LinePlot xs={rpms} ys={[power]} labels={["brake power (kW)"]} xLabel="RPM" height={140} />
          <LinePlot xs={rpms} ys={[imep]} labels={["IMEP (bar)"]} xLabel="RPM" height={140} />
        </div>
      )}
    </div>
  );
}
```

- [ ] The exact signature of `LinePlot` may differ — read `apps/desktop/src/modules/cfd/components/charts/LinePlot.tsx` and adapt the call (it's used in SweepResults.tsx as a reference).

- [ ] Run `pnpm --filter helios-desktop typecheck`. Expected: clean.

- [ ] Commit:

```bash
git add apps/desktop/src/modules/cfd/results/TrialInspector.tsx
git commit -m "feat(cfd-ui): TrialInspector — params + per-trial sweep curves"
```

### Task 15: OptimizationResults

**Files:**
- Create `apps/desktop/src/modules/cfd/results/OptimizationResults.tsx`

- [ ] Top-level results container:

```tsx
import React, { useMemo, useState } from "react";
import type { OptimizationStudy } from "../state/types";
import { ParallelCoordsPlot, type ParallelCoordsTrial } from "../components/charts/ParallelCoordsPlot";
import { TrialInspector } from "./TrialInspector";

interface Props {
  study: OptimizationStudy;
}

export function OptimizationResults({ study }: Props) {
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);

  const doneTrials = study.trials.filter((t) => t.status === "done" && t.objectiveValue !== null);

  // Axes: one per parameter + one for objective.
  const axes = useMemo(() => {
    const paramAxes = study.parameterPaths.map((p) => {
      const vals = doneTrials.map((t) => t.parameterValues[p]).filter((v) => Number.isFinite(v));
      const min = vals.length ? Math.min(...vals) : 0;
      const max = vals.length ? Math.max(...vals) : 1;
      return { label: p, min, max };
    });
    const objVals = doneTrials.map((t) => t.objectiveValue!).filter((v) => Number.isFinite(v));
    const objMin = objVals.length ? Math.min(...objVals) : 0;
    const objMax = objVals.length ? Math.max(...objVals) : 1;
    return [...paramAxes, { label: `objective (${study.objectiveDirection})`, min: objMin, max: objMax }];
  }, [study, doneTrials]);

  const trialsForPlot: ParallelCoordsTrial[] = doneTrials.map((t) => ({
    trialIdx: t.trialIdx,
    values: study.parameterPaths.map((p) => t.parameterValues[p] ?? Number.NaN),
    objective: t.objectiveValue!,
    bestTrial: study.bestTrialIdx === t.trialIdx,
  }));

  const selectedTrial = selectedIdx !== null ? study.trials.find((t) => t.trialIdx === selectedIdx) : null;

  return (
    <div className="grid grid-cols-[1fr_360px] gap-4 h-full">
      <div className="flex flex-col gap-3 overflow-auto">
        <header className="text-sm">
          <span className="font-semibold">Optimization</span>
          <span className="ml-2 text-zinc-500">
            {doneTrials.length}/{study.params.nTrials} trials done
            {study.bestTrialIdx !== null && ` · best #${study.bestTrialIdx} = ${study.bestObjectiveValue?.toPrecision(5)}`}
          </span>
        </header>

        {doneTrials.length === 0 ? (
          <div className="text-sm text-zinc-500 p-8 text-center border border-dashed border-zinc-800 rounded">
            Waiting for first trial…
          </div>
        ) : (
          <ParallelCoordsPlot axes={axes} trials={trialsForPlot} onTrialClick={setSelectedIdx} selectedTrialIdx={selectedIdx} />
        )}

        {/* Trial table */}
        <table className="w-full text-xs font-mono">
          <thead className="text-zinc-500">
            <tr>
              <th className="text-left px-2">#</th>
              <th className="text-left px-2">status</th>
              <th className="text-left px-2">obj</th>
              <th className="text-left px-2">wall</th>
              {study.parameterPaths.map((p) => <th key={p} className="text-left px-2">{p}</th>)}
            </tr>
          </thead>
          <tbody>
            {study.trials.map((t) => (
              <tr key={t.trialIdx}
                onClick={() => setSelectedIdx(t.trialIdx)}
                className={`cursor-pointer hover:bg-zinc-800 ${selectedIdx === t.trialIdx ? "bg-zinc-800" : ""} ${study.bestTrialIdx === t.trialIdx ? "text-amber-400" : ""}`}>
                <td className="px-2">{t.trialIdx}</td>
                <td className="px-2">{t.status}</td>
                <td className="px-2">{t.objectiveValue?.toPrecision(5) ?? "—"}</td>
                <td className="px-2">{t.wallTimeS?.toFixed(2) ?? "—"}</td>
                {study.parameterPaths.map((p) => <td key={p} className="px-2">{t.parameterValues[p]?.toPrecision(4) ?? "—"}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <aside className="border-l border-zinc-800 pl-3 overflow-auto">
        {selectedTrial
          ? <TrialInspector trial={selectedTrial} parameterPaths={study.parameterPaths} />
          : <p className="text-xs text-zinc-500">Click a trial to inspect.</p>
        }
      </aside>
    </div>
  );
}
```

- [ ] Run `pnpm --filter helios-desktop typecheck`. Expected: clean.

- [ ] Commit:

```bash
git add apps/desktop/src/modules/cfd/results/OptimizationResults.tsx
git commit -m "feat(cfd-ui): OptimizationResults with parallel-coords + trial table + inspector"
```

### Task 16: Route from ResultsScreen

**Files:**
- Modify `apps/desktop/src/modules/cfd/screens/ResultsScreen.tsx`

- [ ] Extend the existing `switch (study.kind)` (or `if`-cascade) to route the new variant:

```tsx
import { OptimizationResults } from "../results/OptimizationResults";

// inside ResultsScreen's render:
if (study.kind === "optimization") return <OptimizationResults study={study} />;
```

- [ ] Run `pnpm --filter helios-desktop typecheck`. Expected: clean (exhaustiveness satisfied).

- [ ] Commit:

```bash
git add apps/desktop/src/modules/cfd/screens/ResultsScreen.tsx
git commit -m "feat(cfd-ui): route optimization studies to OptimizationResults"
```

---

## Wave 7 — End-to-end + polish

### Task 17: Storage round-trip

**Files:**
- Modify `apps/desktop/src/modules/cfd/lib/cfdStorage.ts`

- [ ] The existing storage layer persists studies to localStorage. Verify `OptimizationStudy` round-trips cleanly:

```ts
// In whatever (de)serialize step exists — likely no change needed if it serializes
// the union via JSON.stringify/parse. If there's a discriminator switch, add the
// "optimization" arm.
```

- [ ] Add a quick test if the storage module has tests, otherwise sanity check by running the app and seeing the study survive reload.

- [ ] No commit if no changes needed; otherwise:

```bash
git commit -m "feat(cfd-storage): persist optimization studies"
```

### Task 18: Sanity test the desktop test suite

- [ ] Run `pnpm --filter helios-desktop test`. Expected: all existing + new tests pass.

- [ ] Run `pnpm --filter helios-desktop typecheck`. Expected: clean.

### Task 19: Manual smoke test

- [ ] Add to PATH and start the Tauri dev build:

```bash
export PATH="$HOME/.cargo/bin:$PATH"
pnpm --filter helios-desktop tauri dev
```

- [ ] Smoke test path:
  1. Load `examples/cfd/sdm26.json`.
  2. Click "Optimization…" on the Studies screen.
  3. In the modal, enable `restrictor.cd` and `intake.plenum_volume`. Set sensible bounds.
  4. Objective: `imep_bar` × `mean` × `6000:10000:2000` × `maximize`.
  5. Sampling: 8 trials, LHS, seed 42, max cycles 4.
  6. Click "Start optimization". The Results screen should show parallel-coords filling in as trials complete.
  7. Click a trial — the inspector shows its parameter values and per-RPM brake torque curve.
  8. Best trial is highlighted in amber.

- [ ] If any step fails, fix in-place and iterate; do NOT push until smoke passes.

---

## Self-Review Checklist

- [ ] **Spec coverage:**
  - "every numeric leaf optimizable, OFF by default, min/max/step" → backend schema (Task 7 hook) + ParameterPanel (Task 9)
  - "as flexible as possible — IMEP at one band, VE at another" → ObjectiveBuilder lets any metric × aggregator × RPM list × direction (Task 10)
  - "uniform by default, opt-in per-element" → ParameterRow scope dropdown (Task 8)
  - "parallel-coords + scatter (industry standard, done well)" → ParallelCoordsPlot + selected-trial inspector (Tasks 13–15)
  - "shows current spec, current state" → TrialInspector + trial table (Tasks 14–15)
- [ ] **No placeholders.** ✓
- [ ] **Type consistency:** `OptimizationStudy`, `OptimizationTrial`, `ParameterBoundsUI`, `ObjectiveSpec` consistent end-to-end. ✓
- [ ] **Backend handoff:** see `2026-05-21-cfd-phase-5-optimization-backend-plan.md`. Frontend depends on backend Tasks 1, 2, 10, 11.
