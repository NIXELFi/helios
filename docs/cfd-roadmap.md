# CFD Module — Future Work Roadmap

_Last updated: 2026-06-11 (post lap-sim audit 0029: limit-classifier pace fix,
roll-config aero split, report lap-sim section; items 10–13 added)._

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

## 6. Managed-effort endurance pace model — ✅ DONE (2026-06-11)

Shipped (still ONE knob): corner ceilings scale by pace, and braking +
traction-limited exits now run at pace × capacity — the old model paired
full-send 2 g braking with half-pace corners, which hollowed the endurance
g-g into a ring with spikes (Nick's screenshot). The ENGINE stays wide open
(straights run out, top gears reached — the constraint from the earlier
telemetry bug). Exponent experiment: effort = pace² ("uniform grip usage")
is REFUTED by the Mines fuel anchor — it does too little lap work and forces
the fitted efficiency to an unphysical 0.126; effort = 1 was the spike
artifact; effort = pace fits with peak brake 1.27 g / lat ~1.0 g — typical
managed-pace telemetry. Refit: ENDURANCE_PACE 0.5826, ENDURANCE_THERMAL_EFF
0.1640 (both Mines anchors exact; AX flat-out untouched at 42.905 s).
Endurance telemetry to validate the effort split would upgrade this from
"defensible" to "measured".

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

## 9. Lap channels in the design-review report — ✅ DONE (2026-06-11)

Shipped: the master report now has a "Lap simulation — traces & limit states"
section — speed-vs-distance with the limit-state strip for AX + EN, the
time-weighted limit-fractions table (incl. balance margin), a limit-colored
g-g diagram, and the skidpad validation card. The lap CSV header also carries
the headline telemetry. Remaining nice-to-have: channel-colored track MAP in
the report (the screen has it; the report's visual-track SVG could take a
channel ramp).

## 10. Lap Sim — sector / corner-by-corner time table — ✅ DONE (2026-06-11)

Shipped as `lib/performance/sectors.ts` (`lapSectors` / `sectorDeltas`):
sectors split at brake applications (40 m sliver merge), per-sector time /
vmin / vmax / limit makeup, and per-sector ΔT vs B over the same road. Sector
table on the Lap Sim screen (worst/best sector flagged in A/B), autocross
sector table in the master report, live sector chip in the lap-player dash.
Found + fixed while building: the speed envelope now caps at the TOP-GEAR
LIMITER speed — previously the forward pass zigzagged around it (force = 0
past redline → phantom −0.4 g "braking" on long straights, polluted
maxBrakeG). Calibration anchors held.

## 11. Brake + tire duty metrics from the channels — ✅ DONE (2026-06-11)

Shipped: `LapTelemetry.brakeEnergyKJ / peakBrakePowerKw / tireDutyGkm`
(brake force is net of drag's share), `throttle` / `brake` demand channels
(demand ÷ capacity from the SAME grip model — 1.0 = at the limit), pedal
trace plot + analyzer channels + dash pedal bars on the Lap Sim screen,
duty table in the master report, columns + header lines in the lap CSV.

## 12. Braking should see load transfer (χ + longitudinal) — ✅ DONE (2026-06-11)

Shipped: `aBrakeGrip` is now a fixed-point solve with FORWARD weight transfer
(fronts gain m·a·h/L; load-sensitive μ weighted per axle via `muLatFz`), the
roll-config aero split, χ(v,R) for lateral transfer, and the ellipse — the
same treatment cornering already had. `sens = 0` + no .tir reduces exactly to
the legacy μ·g_eff (test vehicles unchanged). SDM26 peak braking fell from an
ideal 2.77 g to **2.02 g (AX) / 2.19 g (EN)** — flagged by Nick as
unrealistic, now transfer-honest. No measured brake-g anchor exists yet; if
DAQ data surfaces, pin a brake-specific scale the way skidpad pinned μ_lat.

Recal (same anchors): LINE_FACTOR 1.159 → **1.192** (AX 43.007 s vs 42.922
anchor — still saturating 0.2% short at the geometric line cap),
ENDURANCE_PACE 0.540 → **0.5405** (159.600 s exact), ENDURANCE_THERMAL_EFF
0.221 → **0.2125** (0.9786 kg CO₂/lap exact on the shipped curve).

## 13. Lap-time sensitivity panel (vehicle knobs) — 🟡 v1 SHIPPED (2026-06-24)

**Why:** "What's a kg worth? What's 0.1 CLA worth?" is the first question
every design review asks. The optimizer answers it for engine params only.

**v1 (vehicle-dynamics sweeps, 2026-06-24):** a "VD sweep" mode on the Lap Sim
screen sweeps ONE chassis knob — total mass, CG height, ARB balance
(`rsdFront`), or tire µ %dropoff — across a physical range on source A's engine,
re-running the full `simLap` at each value (`lib/performance/vdSweep.ts`:
`applyVdParam`/`runVdSweep`). New "lap time vs VD value" plot with a baseline
marker, sweep-summary CSV (`value, lapTimeS, maxLatG, balanceMargin, fuelKg`),
and the A/B headline/traces reused via a `runFor(src, vehicleOverride?)` seam
refactor (B = the swept setup). The µ %dropoff framing is a pure restatement of
`tireLoadSensitivity` — `(1 − 2^(−sens))·100`,
`lib/performance/loadSensitivity.ts` — surfaced as a chip in the Performance
VehicleEditor (which also gained a CG-height field). Directional invariants are
pinned in `vdSweep.test.ts`. The %dropoff sweep is gated off when a `.tir`
overrides µ(Fz); and `cgHeightM` is gated off when the resolved vehicle has a
roll config (see the finding). Mass/RSD always stay valid; a disabled param can
never be the active one. **Gotcha honored:** `applyVdParam` patches the RESOLVED
vehicle — `vehicleForCar` force-overwrites `massKg` for known cars, so a mass
sweep before identity resolution silently resets to the preset (same trap as the
FD optimizer, note above). **Finding:** under the per-axle roll model, lateral
transfer keys on `hRollArmM`, NOT raw `cgHeightM`, so on a roll-config car a CG
sweep freezes lateral capacity and the lap-time trend **INVERTS** (higher CG
reads as faster — it moves only longitudinal load transfer). That wrong-way plot
is why `cgHeightM` is gated to lumped-model vehicles in v1, and why coupling
`hRollArmM ↔ cgHeightM` is the priority QSS follow-up (stage 1 of the design
doc). Design doc + the staged path to the full QSS model:
`docs/superpowers/specs/2026-06-24-lapsim-vd-quasi-steady-state-roadmap.md`.

**Remaining (the original ask, deferred):** finite-difference ∂(lap
time)/∂(mass, CdA, CLA, μ, FD, shift time) as a one-shot TORNADO chart in
Performance/Lap Sim and the report (~12 extra simLap calls — instant). The VD
sweep is the interactive, single-axis tool; the tornado is the at-a-glance
ranking. Plus the full quasi-steady-state VD model (per-station equilibrium
solve, per-tire combined-slip MF) per the design doc's staged roadmap.

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
