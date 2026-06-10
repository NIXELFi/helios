# 50 — v4.3.1 polish: results-tab freeze, endurance calibration, Compare overlay

**Date:** 2026-06-09

Three bugfixes for issues introduced with the v4.3.0 competition-events work.
Frontend-only — no solver/Rust changes.

## Optimization results froze the app (perf)

Opening the Results tab on an optimization study (or having it open during a
live run) blocked the main thread for ~6.5 s per state change on a 128-trial
study. Two compounding causes, two fixes:

- **`simLap` was re-solving the corner-speed bisection per cell.** `vCorner`
  (40-step bisection) ran ~17k times per endurance lap, but track radii are
  piecewise-constant (≤ tens of distinct values). Cached per distinct radius in
  `solveSpeeds` + the telemetry limit classifier. Identical output, verified by
  the full performance suite: `computeEvents` 51 ms → **3.25 ms** (15.7×).
  The Compare screen and Performance screen get the same speedup for free.
- **`eventsByTrial` re-simmed the whole study on every state-identity churn**
  (each live trial landing, rehydrate, study switch). New `cachedTrialEvents`
  (content-keyed, cross-render, `lib/performance/eventsCache.ts`): only trials
  not yet scored pay for a sim; churn is a cache hit.

## SDM26 endurance placed P1 (calibration)

The 2026-06-09 re-anchor to Mines' clean-lap pace (148.0 s) scored SDM26 at
241.8 endurance pts / 382.7 total — ahead of the real 2026 field. Root cause:
convention mismatch. The scoring baselines (`enduranceTMin` 142.085 s, the EF
anchors) are official corrected-total/laps numbers — in/out laps included — so
a clean-lap model time gets ~+55 endurance pts of free pace.

Re-anchored the knobs to the run-average convention:

- `ENDURANCE_PACE` 0.7625 → **0.694** (SDM26 lands 159.6 s/lap, Mines'
  official run-average pace) → 186.6 endurance pts, ~320 total. Mid-field,
  matching reality.
- `ENDURANCE_THERMAL_EFF` 0.15 → **0.14** (re-solved to hold the Mines fuel
  anchor, 0.9786 kg CO₂/lap on E85, at the slower pace).
- Efficiency now reproduces Mines' official FEF 0.536 / ~43 pts (was 0.575).
- `calibration.test.ts` pins the new convention and adds a "not field-beating"
  regression guard (endurance pts < 210, total < 340).

## Compare torque-curve overlay was blank

Comparing a sweep against an optimization best drew an empty chart: the two
curves live on different rpm grids, so the union x-axis interleaves and every
neighbor sample is a gap for each series. `LinePlot` padded gaps with `NaN`
(uPlot draws no segments at all) and Compare hides point markers → nothing
rendered. Gaps are now `null` (uPlot's missing-value sentinel) and own-x
series set `spanGaps: true`.
