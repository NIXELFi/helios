# CFD Module — Future Work Roadmap

_Last updated: 2026-06-09 (post-v4.3.0 feature set: Config / Studies / Results /
Performance / Lap Sim / Compare)._

This is the backlog for the CFD tab, ranked by decision-value to the engine
team. Each entry notes what exists today, what to build, and the gotchas
discovered while building the v4.3.0 features.

---

## 1. Drivetrain optimizer (small, very actionable)

**Why:** Gap attribution proved final drive dominates endurance (FD 3.5 costs
+2.4 s/lap vs 3.0 on the same car) while being nearly free in autocross — and a
sprocket swap is the cheapest real-world change the team can make.

**Build:** A panel (inside Performance, or its own study kind) that sweeps
final drive across the feasible sprocket range for the loaded torque curve and
plots **total FSAE points vs FD**, annotated with real tooth combinations
(e.g. "3.13 = 47/15"). Optionally co-sweep shift RPM. All frontend math —
`computeEvents` over a FD grid is ~instant.

**Notes:** `vehicleForCar` forces FD for known cars; the optimizer must
override after identity resolution (pass an explicit vehicle, don't fight the
preset).

## 2. Dyno validation overlay (trust maintenance)

**Why:** The sim's claim to accuracy (RMSE 4.27 kW vs the team Dynojet with
the finding-0021 physics) lives in docs, not on screen. Calibration drift is
invisible until someone re-checks by hand.

**Build:** Import a Dynojet CSV (rpm, torque/power) → overlay on any study's
curve → RMSE / bias per RPM band readout, persisted next to the study.
Re-runs automatically when the curve source changes.

**Notes:** Reuse the import seam pattern from `lib/import/importStudy.ts`
(pure parser + io seam → trivially testable).

## 3. Fuel / AFR strategy explorer

**Why:** The Rust sim already has AFR-dependent combustion efficiency
(`afr_eta_enabled`, Heywood-shape η(φ)) and `afr_stoich` for E85 — none of it
exposed. Efficiency is 100 pts; fuel choice + AFR target is a real strategy
decision.

**Build:** Sweep `afr_target` (and fuel = 93 vs E85) → torque curve family →
CO₂-vs-points tradeoff curve. Needs `afr_eta_enabled: true` in the config
`physics` section (loader support shipped in v4.3.0).

## 4. Knock margin surfacing

**Why:** The Livengood-Wu knock integral (finding 0013) is computed but
watch-only. High-CR optimization trials can silently "win" with designs that
would detonate.

**Build:** Surface the per-RPM knock integral in Results (flag trials with
I > 1.0), and optionally let the optimizer reject/penalize knocking designs.
Policy question for the team: flag-only vs derate.

## 5. Custom track import for the lap sim

**Why:** Visual track import exists (`*-visual.json` traces); the lap sim
still runs only the bundled 2026 radius profiles. When FSAE publishes next
year's course map, the team should be able to pre-sim it same-day.

**Build:** `parseTrack` already accepts `{length, radius|null}` segments —
add a file-import path (and/or derive a radius profile from a traced
centerline via the existing Menger curvature, smoothed) plus a track picker on
the Lap Sim screen. Re-anchor `LINE_FACTOR` only if the source geometry type
changes (centerline-trace vs surveyed).

## 6. Two-knob endurance pace model (accuracy)

**Why:** The single `ENDURANCE_PACE` knob scales the whole speed envelope, so
race-pace cornering reads low (1.55 g at pace 0.7625 vs ~2 g flat-out). Real
drivers manage pace mostly by lifting early on straights, not by cornering 25%
under the limit.

**Build:** Split into `cornerPace` (~0.9) + straight-line/throttle factor,
calibrated jointly so the Mines clean-lap anchor (148.0 s) still holds. Then
re-anchor `ENDURANCE_THERMAL_EFF` (fuel) — the speed profile reshapes drag
work. Follow the recal-sweep pattern (see commit e22c9d0).

## 7. WENO5 + SSP-RK2 solver upgrade (large, Rust)

**Why:** Finding 0023: the MUSCL solver damps sharp blowdown fronts → ~11 kW
under-prediction at 13 kRPM. Also the root cause of the flat exhaust-tuning
response (finding 0007).

**Build:** WENO5 reconstruction behind a `physics` flag (the section ships in
v4.3.0; `use_weno5_in_pipes` already exists as a field). Validate against the
team dyno, then enable in bundled configs. Large effort; needs a careful
parity story.

## 8. Auto-refine loop for the optimizer

**Why:** "⟲ Refine around #1" is one click per round; the backend sampler is
space-filling, so converging on an FSAE objective takes several rounds.

**Build:** Frontend orchestration: run N refinement rounds (re-sampling with
`refineBounds`), stop when the best stops improving. Pure sequencing of
existing `startOptimization` calls.

## 9. Lap channels in the design-review report

**Why:** The light-theme HTML report predates the Lap Sim channels; the
hand-off artifact should carry the limit-state strip + channel-colored maps.

**Build:** Extend `buildDesignReportHtml` with the limit-state breakdown,
track maps colored by speed, and the headline telemetry (incl. %
power-limited).

---

## Gotchas for whoever builds these (learned in v4.3.0)

- **Never splice TS/TSX with PowerShell** `Get-Content`/`Set-Content` — it
  corrupts multi-byte UTF-8 (—, →, °). Use the editor tooling or .NET
  `ReadAllText/WriteAllText` with UTF-8.
- **Recalibration treadmill:** any change to grip/shift physics moves the
  anchors. The three knobs live in `lib/performance/events.ts`
  (`LINE_FACTOR`, `ENDURANCE_PACE`, `ENDURANCE_THERMAL_EFF`); recalibrate in
  that order against: SDM26 autocross 42.922 s, Mines clean-lap 148.0 s,
  Mines CO₂ 0.9786 kg/lap (E85). `calibration.test.ts` pins all three.
- **LinePlot pins its x-range at creation** — the data extent is part of the
  rebuild key. Don't regress this when touching the chart.
- **CfdProvider rehydrates from localStorage even with `skipRehydrate`** (the
  flag only skips `listJobs`) — screen tests must `localStorage.clear()` per
  test.
- **The optimizer must never pay for channels** — `simLap` only allocates
  traces behind `opts.channels`.
- **`physics` config section**: every key optional; absent = legacy
  Python-parity behavior. Parity fixtures must never gain the section.
- **cfd-core legacy tests resolve `python_ref` configs first** — the bundled
  configs ship validated physics and are NOT a legacy baseline anymore.
