# CFD Analytics + Universal Export — Design Spec (v1)

Date: 2026-06-05 · Branch: `feat/cfd-analytics` · Status: approved for implementation
Derived from a 4-design judge panel (winner: minimal-risk skeleton + grafts). Zero Rust changes; zero solver-math changes; vault module untouched.

## Goals
1. **Optimization screen, live**: show trends across parameters while running; highlight current best / 2nd / 3rd; convergence view; sortable ranked table; ETA.
2. **Better analytics on all screens**: sweep summary band + missing torque/knock charts; single-RPM convergence panel + summary; studies-list summary cells.
3. **Universal export**: every study kind exportable (CSV + self-describing JSON) from the Studies list AND each results screen; TSV/clipboard variants; wave-viewer PNG + current-frame CSV.

## Hard rules
- DO NOT touch `crates/**`, `src-tauri/**`, or any solver math. Export is 100% frontend (`save()`/`writeTextFile`/`writeFile` from existing Tauri plugins; permissions already granted).
- DO NOT touch `modules/vault/**` (parallel agent owns it).
- DO NOT modify the CfdContext reducer or `bestTrialIdx` wiring. Live ranking is a pure display-side selector layered on top. After job-done, rank 1 must equal `study.bestTrialIdx` (same comparison direction; ties broken by ascending trialIdx — backend keeps first-best, verify in test).
- DO NOT memoize live selectors on `study.id` — memoize on the `study.trials` array reference (reducer returns new arrays per event).
- DO NOT write exports back into localStorage/context. Write-to-disk only.
- NO on-screen correlation/sensitivity stats (meaningless at 20–40 trials). No AUC, no monotonicity, no rank-change arrows, no Markdown export format in v1.
- knockIntegral is surfaced as raw "knock integral (max)" — never labeled "margin" (normalization unconfirmed).
- New UI hand-rolls inline Tailwind in existing idioms (dark: #0E0E10/#0B0B0D bg, #16171B panel, #2A2C32 border, #FFC627 gold accent, text-[10px]/[11px], font-mono tables). No new npm deps.

## Module contracts (exact)

### `state/types.ts` (one-line edit)
Add to `CycleStats`: `knockIntegral?: number;` — wire sends it (Livengood-Wu), old persisted studies lack it. Optional everywhere it is consumed.

### `lib/metricMeta.ts` (NEW)
Single source of CycleStats metric metadata for charts, CSV headers/units, objective labels.
```ts
export interface MetricMeta { key: keyof CycleStats & string; csvName: string; label: string; unit: string; decimals: number; wireName: string }
export const CYCLE_METRICS: MetricMeta[]            // ordered: cycle, imepBar, bmepBar, fmepBar, veAtm, intakeMassPerCycleG, fResidual, indicatedPowerKW, brakePowerKW, wheelPowerKW, indicatedTorqueNm, brakeTorqueNm, wheelTorqueNm, egtMean, knockIntegral, massTotal, massDrift, massInRestrictor, massOutCollector, netPortFlow, nonconservation (+Hp variants)
export function metricByWire(wire: string): MetricMeta | undefined   // wireName = snake_case serde name; SERDE LANDMINE: powers are `indicated_power_k_w` / `brake_power_k_w` / `wheel_power_k_w` — copy wire names from ObjectiveBuilder METRICS (components/optimization/ObjectiveBuilder.tsx:12-27), do NOT hand-roll camel→snake
export function metricByKey(key: string): MetricMeta | undefined
export function objectiveLabel(spec: ObjectiveSpec): string          // e.g. "max(brake power) over 7 rpm — maximize"
export function objectiveUnit(spec: ObjectiveSpec): string           // unit of the metric ('' if unknown)
```
csvName: readable snake (`indicated_power`, `knock_integral`); unit lives in the CSV units row (`kW`, `bar`, `-`, `K`, `g`, `kg`, `Nm`). Do not change ObjectiveBuilder in v1.

### `lib/analytics/optimizationStats.ts` (NEW, pure, no React/Tauri)
```ts
export interface RankedTrial { trial: OptimizationTrial; rank: number; deltaToBest: number; pctOfBest: number | null }
export function rankTrials(trials: OptimizationTrial[], direction: ObjectiveDirection): RankedTrial[]
// done + Number.isFinite(objectiveValue) only; best-first by direction; ties → ascending trialIdx; sequential ranks 1..n (NO shared ranks)
// deltaToBest = trial.objective − best.objective (signed, 0 for rank 1); pctOfBest = deltaToBest/|best| * 100, null when best === 0
export function runningBest(trials: OptimizationTrial[], direction: ObjectiveDirection): { trialIdx: number; objective: number; bestSoFar: number }[]
// trialIdx ascending over done+finite trials
export function etaSeconds(trials: OptimizationTrial[], nTrials: number): number | null
// null unless ≥3 done trials with finite wallTimeS; mean(wallTimeS) × max(0, nTrials − nDone)
```

### `lib/analytics/sweepStats.ts` (NEW, pure)
```ts
export interface PeakInfo { rpm: number; value: number; rpmInterp: number; valueInterp: number }
export function peakOf(points: SweepPoint[], get: (p: SweepPoint) => number): PeakInfo | null
// sample max; parabolic-vertex interpolation through (rpm,value) neighbors when the peak is interior and ≥3 points; clamp vertex into [left,right] neighbor rpm; else interp = sample
export function powerbandWidth(points: SweepPoint[], frac = 0.95): { fromRpm: number; toRpm: number; widthRpm: number } | null
// rpm span where brakePowerKW ≥ frac × peak (linear-interpolated crossings); null if <2 points
export interface SweepSummary { nPoints: number; peakPower: PeakInfo | null; peakTorque: PeakInfo | null; peakVe: PeakInfo | null; powerband: ReturnType<typeof powerbandWidth>; maxKnockIntegral: number | null }
export function summarizeSweep(points: SweepPoint[]): SweepSummary   // accessors: brakePowerKW, brakeTorqueNm, veAtm; sorts by rpm defensively; maxKnockIntegral null when no point carries knockIntegral
```

### `lib/analytics/cycleStats.ts` (NEW, pure)
```ts
export interface CycleDelta { cycle: number; deltaPct: number }      // |IMEP_i − IMEP_{i−1}| / max(|IMEP_{i−1}|, ε) — DISPLAY ONLY, the authoritative convergence verdict is the backend's summary.convergedCycle
export function imepDeltaSeries(cycles: CycleStats[]): CycleDelta[]
export function covLastN(cycles: CycleStats[], field: keyof CycleStats & string, n = 5): number | null  // stdev/|mean| over last n; null if <n cycles or mean≈0
export function maxKnockIntegral(cycles: CycleStats[]): number | null
```

### `lib/export/io.ts` (NEW — the ONLY file importing Tauri plugins in lib/)
```ts
export function slugify(s: string): string                            // csv-export.ts idiom
export function fileTimestamp(d?: Date): string                       // "20260605-134501"
export async function saveTextFile(defaultName: string, ext: string, contents: string): Promise<string | null>   // save() dialog (filters), writeTextFile; null = cancelled
export async function savePngFile(defaultName: string, bytes: Uint8Array): Promise<string | null>                // writeFile
export async function copyText(text: string): Promise<void>           // navigator.clipboard.writeText
```

### `lib/export/buildCsv.ts` (NEW, pure)
All CSVs: two header rows (names, then units), `csvCell()` quoting, non-finite → empty cell, `\n` joined. Reuse metricMeta for names/units/decimals.
```ts
export function buildSingleRpmCsv(study: SingleRpmStudy): string        // one row/cycle, all CYCLE_METRICS columns (knock_integral only when any cycle has it)
export function buildSweepCsv(study: SweepStudy): string                // one row/completed rpm point: rpm, converged_cycle, n_cycles_run, wall_time_s, step_count, nonconservation_max, then lastCycle metric columns
export function buildSweepCyclesCsv(study: SweepStudy): string | null   // long format: rpm, cycle, metric columns; null when no point has cycles
export function buildOptimizationTrialsCsv(study: OptimizationStudy, schema?: ParameterMeta[] | null): string
// trial, status, rank, objective(unit via objectiveUnit), delta_to_best, pct_of_best, wall_time_s, then one column per parameterPaths entry (unit from schema match when provided)
// ranks via rankTrials; pending/error rows included with empty rank/objective; export is a partial snapshot when study.status === 'running' (no waiting, no warning rows)
export function buildOptimizationCurvesCsv(study: OptimizationStudy): string | null
// long format: trial, rank, rpm, then lastCycle metric columns; rows only for done trials with sweepPoints; null when none
export function buildTrialsTsv(study: OptimizationStudy): string        // tab-separated, single header row, for clipboard paste into sheets
```

### `lib/export/buildJson.ts` (NEW, pure — bundle types live HERE, not in state/types.ts)
```ts
export interface StudyBundleMeta { schemaVersion: 1; exportedAt: string; kind: StudyKind; configPath: string; status: StudyStatus; startedAt: number; finishedAt?: number }
export function buildStudyJson(study: Study, opts?: { schema?: ParameterMeta[] | null }): string
// pretty JSON: meta + full params (optimization: tunables+objective+sampler+seed+lockedPairs ⇒ reproducible) + results (cycles | points | trials) + derived (sweep: summarizeSweep; optimization: ranked top-10 {rank, trialIdx, objectiveValue, deltaToBest, parameterValues}; singleRpm: covLastN + maxKnockIntegral) + parameterSchema when provided. NO appVersion (vetoed hardcode).
export function buildWorkspaceJson(studies: Study[]): string            // { schemaVersion: 1, exportedAt, studies: [bundle…] }
```

### `lib/export/exportStudy.ts` (NEW)
```ts
export interface ExportAction { id: string; label: string; run: () => Promise<string | null> }  // null = cancelled
export function exportActionsFor(study: Study, deps: { getSchema?: (configPath: string) => Promise<ParameterMeta[]> }): ExportAction[]
// per kind: single-rpm [Cycles CSV, Study JSON] · sweep [Per-RPM CSV, Cycles CSV?, Study JSON] · optimization [Trials CSV, Trial curves CSV?, Study JSON]
// filename: `cfd-${kind}-${slugify(basename(configPath))}-${fileTimestamp()}`; optimization CSV/JSON fetch schema best-effort (catch → null)
```

### `components/ExportMenu.tsx` (NEW)
```ts
export interface ExportMenuItem { id: string; label: string; run: () => Promise<{ ok: boolean; message: string }> }
export function ExportMenu({ items, align }: { items: ExportMenuItem[]; align?: "left" | "right" })
```
Gold-outline `Export ▾` button (header-density: text-[10px] uppercase tracking-wider, border-[#2A2C32] hover:border-[#FFC627]); absolute popover menu; Esc/outside-click close; per-item busy state; transient toast (fixed bottom-right, PM WriteErrorToast idiom) showing "Exported → <basename>" / "Copied!" / error; auto-dismiss 4 s.

### `components/charts/ScatterPlot.tsx` (NEW — hand-rolled SVG, ParallelCoordsPlot idioms; NOT uPlot)
```ts
export interface ScatterPt { id: number; x: number; y: number; rank?: number | null; inFlight?: boolean }
export function ScatterPlot(props: { title: string; points: ScatterPt[]; xLabel: string; yLabel: string; stepLine?: { x: number; y: number }[]; selectedId?: number | null; onPointClick?: (id: number) => void; height?: number })
```
Axes min/max from data extent (safe-divide on degenerate); neutral points #4FC3F7 at 0.55 opacity r=3; rank1 #fbbf24 r=5, rank2 #C0C7D1 r=4.5, rank3 #CD7F32 r=4.5 (drawn on top, full opacity); selected gets white ring; optional stepLine rendered as right-angle step polyline (#FFC627, 1.5px, 0.9 opacity); title strip identical to LinePlot chrome. Click bubbles `id`.

### `state/useOptimizationLive.ts` (NEW)
```ts
export interface OptimizationLive { done: OptimizationTrial[]; ranked: RankedTrial[]; top3: RankedTrial[]; rankByIdx: Map<number, number>; running: OptimizationTrial[]; history: { trialIdx: number; objective: number; bestSoFar: number }[]; eta: number | null; nDone: number }
export function useOptimizationLive(study: OptimizationStudy): OptimizationLive
```
ONE `useMemo` keyed `[study.trials, study.objectiveDirection, study.params.nTrials]`. One code path for running/done — only `status === "running"` toggles ETA display & elapsed ticker (1 s `setInterval`, cleaned up, gated to running).

## Screen changes

### `results/OptimizationResults.tsx` (overhaul)
Keep the two-pane grid + ParallelCoordsPlot + TrialInspector seams. New left-pane order:
1. **Header**: existing info + live best from `ranked[0]` (works mid-run), `ETA ~Xm est.` (≥3 done, running only), elapsed (ticking while running), Cancel, **ExportMenu** (Trials CSV, Trial curves CSV, Study JSON, Copy table (TSV), Copy best recipe).
2. **Podium row**: 3 cards (top3): rank chip (#1 gold #FFC627 / #2 silver #C0C7D1 / #3 bronze #CD7F32 left-border + chip), objective (toPrecision(5)) + unit, `Δ −0.42 (−0.7%)` vs best (rank 1 shows "best"), trial #, wall s; click selects in inspector. Empty slots: dashed "—" while <3 done.
3. **Charts row** (2-col grid): **Convergence** ScatterPlot (x=trialIdx, y=objective, stepLine=runningBest, ranks colored) · **Objective vs parameter** ScatterPlot + param selector chips (one chip per `parameterPaths`, gold active; x=param value, y=objective, ranks colored).
4. **ParallelCoordsPlot**: extend `ParallelCoordsTrial` with `rank?: number | null`; rank1 #fbbf24 w2 (back-compat with `bestTrial`), rank2 #C0C7D1 w2, rank3 #CD7F32 w2, drawn above others/below selected. Existing props keep working.
5. **Trial table**: new `rank` + `Δ best` columns; sortable headers (rank default asc; obj, wall, #, each param; toggle asc/desc, arrow glyph); top-3 rows tinted (gold/silver/bronze text like current amber idiom); running rows show pulse dot + "running"; pending dimmed.
`TrialInspector`: rank badge + Δ-to-best line; **recipe card** (param → value ·unit· via `useParameterSchema`, Copy button → TSV `path\tvalue` lines); overlay best-trial torque/power/IMEP curves in #5A5F66 when inspecting a non-best trial (sweep-compare idiom).

### `results/SweepResults.tsx`
- **Summary band** above charts (once ≥2 points): `Peak P 64.2 kW @ 11,480 · Peak τ 58.1 Nm @ 9,950 · Peak VE 96.4% @ 10,000 · Powerband 8,700–12,300 (3,600) · KI max 0.41` (knock chip only when present) + Copy button (one-line text). Values from `summarizeSweep` (interpolated rpm, marked `~`).
- **Add charts**: brake torque vs RPM (brakeTorqueNm, #FF8A65, compare-overlay supported); knock integral vs RPM (only when ≥1 point has knockIntegral).
- **ExportMenu** in header: Per-RPM CSV, Cycles CSV (when present), Study JSON, Copy summary.
- Per-RPM table: add τ_brake + KI columns (KI when present).

### `results/SingleRpmResults.tsx`
- **Summary card** under header (≥1 cycle): final IMEP/VE/P_brake/τ_brake/EGT + KI max chip when present + `conv @ N` from backend summary + `CoV(IMEP, last 5)` from covLastN + Copy line.
- **Convergence panel** (collapsible ChartCard): LinePlot of `imepDeltaSeries` deltaPct vs cycle + constant tol reference series (`study.params.convergenceTolImep × 100`%) + backend convergedCycle noted in title when present. Display-only; no convergence logic re-derivation.
- **ExportMenu**: Cycles CSV, Study JSON, Copy summary.

### `screens/StudiesScreen.tsx`
- Per-row **Export** action (popover: kind CSV + Study JSON — reuse ExportMenu with compact trigger) for every study regardless of status (running = partial snapshot).
- Header: **Export all (JSON)** via buildWorkspaceJson (disabled when no studies).
- New **Best/Peak** column: optimization → `best 12.43 (#7)` ranked live; sweep → `~64 kW @ 11.5k`; single-rpm → `IMEP 11.92`; em-dash when no data.

### `results/wave-viewer/` (smallest slice)
- `WaveViewerModal.tsx`: header gains `PNG` + `CSV (frame)` buttons (transportBtnClass idiom). PNG captures the ACTIVE view canvas → `toBlob("image/png")` → `savePngFile` (`cfd-wave-${rpm}rpm-f${frameInt}-${field}-${fileTimestamp()}`). CSV = current frame ONLY (hard guard): `lib/export/buildWaveCsv.ts` pure `buildWaveFrameCsv(packed, frameIdx)` → columns `pipe_index, pipe_label, role, cell, x_m_derived, rho, u, p, T` (x_m_derived = (cell+0.5)/nCells × lengthM, clearly named as derived).
- `SchematicView.tsx` / `WaterfallView.tsx`: add optional `onCanvasRef?: (el: HTMLCanvasElement | null) => void` prop (callback-ref alongside internal ref; waterfall reports first tile). No other behavior change.

## Test plan (vitest + RTL; extend `__tests__/fakes/study.ts` with `makeSweepStudy()`, `makeOptimizationStudy()`, knockIntegral opt-in on `makeCycleStats`)
- analytics: rankTrials (maximize/minimize, ties→trialIdx order, sequential ranks, skips pending/error/non-finite, agreement with backend-style first-best), runningBest, etaSeconds gates; peakOf (interior parabola vs edge fallback, clamping, <3 pts), powerbandWidth (crossings, flat curve), summarizeSweep (no-knock → null); imepDeltaSeries/covLastN guards.
- export: snapshot-ish structural asserts for all builders (two header rows, units row, column counts, blank non-finite, knock column presence/absence, running-study partial snapshot, optimization rank column matches rankTrials, TSV single header); buildWaveFrameCsv frame gating; buildStudyJson reproducibility fields (sampler/seed/tunables present) + no appVersion.
- components: ExportMenu (opens, runs item, busy, toast, Esc/outside close — mock items); ScatterPlot (SVG circles count, rank classes/colors, step line points, click handler, degenerate single-point safe); ParallelCoordsPlot rank styling (extend existing test, bestTrial back-compat).
- screens: OptimizationResults — stream fake trial-done events (CfdContext `__dispatchTestEvent` idiom from CfdContext.test): podium fills in order, ranks stable across event batches (no reorder of equal-rank rows), table sortable, ETA absent <3 done, present ≥3 + running; rank1 === bestTrialIdx after done event. Sweep/SingleRpm/Studies smoke: summary band values, export buttons render, best/peak cells.
- regression: rehydrating persisted v2 studies WITHOUT knockIntegral renders all screens (optional-field guard).

## Workpackage file ownership (for parallel implementation — exclusive writes)
- **A1**: `state/types.ts` (knockIntegral line only), `lib/metricMeta.ts`, `lib/analytics/*`, `__tests__/fakes/study.ts`, `__tests__/analytics/*`
- **A2**: `lib/export/*` (io, buildCsv, buildJson, buildWaveCsv, exportStudy), `__tests__/export/*`
- **A3**: `components/ExportMenu.tsx`, `components/charts/ScatterPlot.tsx`, `__tests__/ExportMenu.test.tsx`, `__tests__/ScatterPlot.test.tsx`
- **B1**: `results/OptimizationResults.tsx`, `results/TrialInspector.tsx`, `state/useOptimizationLive.ts`, `components/charts/ParallelCoordsPlot.tsx`, their tests
- **B2**: `results/SweepResults.tsx` + test · **B3**: `results/SingleRpmResults.tsx` + test · **B4**: `screens/StudiesScreen.tsx` + test · **B5**: `results/wave-viewer/WaveViewerModal.tsx`, `SchematicView.tsx`, `WaterfallView.tsx` + tests
