# CFD Competition Events & Scoring — Design

- **Date:** 2026-06-08
- **Status:** Draft for approval
- **Module:** `apps/desktop/src/modules/cfd` (+ Rust `crates/cfd-core`, `crates/engine-sim` for fuel only)
- **Rules reference:** Formula SAE Rules 2026 v1.0 (10 Sept 2025) — sections cited inline.

## Goal

Turn the engine's torque curve into the numbers that win FSAE points — acceleration time, autocross/endurance lap time, fuel-per-lap → CO₂ + efficiency factor, a tractive-effort map, and a skidpad gear/RPM readout — and surface them as optimization objectives + graphs, with optional *projected* FSAE points.

## Locked decisions

- **Scoring lives in the frontend (TypeScript).** The optimizer sampler is LHS / uniform-random — space-filling and non-adaptive (`crates/cfd-core/src/optimization/sampler.rs`) — and every trial already stores its full torque curve (`OptimizationTrial.sweepPoints`). So a TS scoring layer over stored trials yields the **identical** winning config a Rust objective would, re-scores already-completed studies, and carries zero physics-parity-suite risk.
- **Full 2D quasi-steady-state (QSS) lap sim** for autocross/endurance (P2).
- **Placeholder track** synthesized from rules feature specs now; `Track` is an interface so GPS / image-traced layouts drop in later via one function.
- **Physical metrics always computed; projected FSAE points optional**, using a user-editable reference baseline seeded from last year's published results.
- **Fuel switching is the only backend (Rust) piece** — it changes the torque curve itself.
- **Skidpad = lightweight kinematic gear/RPM readout, not a sim.**

## Rules constants (FSAE 2026)

| Event | Geometry | Tmax | Points formula | Max |
|---|---|---|---|---|
| Acceleration §D.9 | 75 m straight | 1.50·Tmin | 95.5·[(Tmax/Ty−1)/(Tmax/Tmin−1)]+4.5 | 100 |
| Skidpad §D.10 | inner 15.25 m dia, outer 21.25 m dia, 3.0 m lane | 1.25·Tmin | (gear readout only) | 75 |
| Autocross §D.11 | ~0.8 km; straights ≤60 m, turns 23–45 m dia, hairpins ≥9 m, slaloms 7.62–12.19 m | 1.45·Tmin | 118.5·[(Tmax/Ty−1)/(Tmax/Tmin−1)]+6.5 | 125 |
| Endurance §D.12 | ~22 km; straights ≤77 m, turns 30–54 m dia, slaloms 9–15 m | 1.45·Tmin | 250·[(Tmax/Ty−1)/(Tmax/Tmin−1)] + laps(≤25) | 275 |
| Efficiency §D.13 | — | — | 100·(EF−EFmin)/(EFmax−EFmin) | 100 |

- Efficiency factor: `EF = (Tmin/lap ÷ Ty/lap) · (CO₂min/lap ÷ CO₂you/lap)`.
- CO₂ conversion §D.13.4.1: **gasoline 2.31 kg/L, E85 1.65 kg/L**.
- Fuels §IC.5.1: provided = gasoline + E85; octane grade per competition (your 91/93/100 are all "gasoline" → 2.31).

## Data model (new types in `cfd/state/types.ts`, persisted via `cfdStorage` `Persisted`)

- **`VehicleConfig`** — mass & balance (`mass_kg`, `weight_dist_front`, `cg_height_m`, `wheelbase_m`, `track_width_m`), grip (`mu_long`, `mu_lat`), aero (`cda_m2`, `cla_m2`, `air_density_kgm3`), `crr`, `drivetrain_eff`, and **gearing as a per-gear speed-per-rpm table** `gears: { speedMps: number; atRpm: number }[]` — taken directly from the spec sheet's "vehicle speed @ design rpm per gear", which bakes in the box/primary ratios + tire radius self-consistently, so no separate tire-radius guess is needed. A `finalDrive` knob scales the whole table by `baselineFinalDrive/finalDrive` so a rear-sprocket swap is one number. Plus `shift_rpm`, `rev_limit_rpm`. `tire_radius_m` kept informational only. One active config; **SDM26 preset below**; editable.
- **`ReferenceBaseline`** — per-event `{ Tmin, lapTotal }` and `{ CO2min_kg, lapTotal }`; optional, drives points projection.
- **`Track`** (interface) — `curvature(s)` / segment list + `totalLength_m`; placeholder generators `synthesizeAutocross()` / `synthesizeEndurance()` from rules specs.
- Extend `Persisted` (`{ lastConfigPath, studies }`) with `vehicleConfig` and `referenceBaseline`.

## SDM26 reference values (spec sheet, Car #106, ASU)

Seeds the `VehicleConfig` SDM26 preset:

- **Mass** 200 kg (no driver/fuel; scaled 199 kg at comp) → running default **268 kg** (+68 kg driver); full 6.1 L tank ≈ +4.5 kg.
- **Weight dist** 48.5% front w/ 68 kg driver → rear axle 51.5% (RWD traction).
- **CG height 0.2845 m**, **wheelbase 1.530 m**, **track ≈ 1.20 m** (F 1.207 / R 1.194).
- **Tires** Hoosier 16×7.5-10 R20 (r ≈ 0.20 m, informational only).
- **Gearing** — speed @ 9000 rpm per gear: **1: 61.0 · 2: 83.9 · 3: 100.7 · 4: 116.2 · 5: 128.7 · 6: 138.9 kph**; final drive 3.0:1 → `vps_i = (kph/3.6)/9000` m/s per rpm.
- **Engine** CBR600RR, 599 cc, CR 12.7, 20 mm restrictor; peak **55 kW @ 9000**, **50 Nm @ 8000**, 80% τ @ 6750. **Fuel currently 100 octane** (gasoline → CO₂ 2.31 kg/L).
- **Aero** Cl −3.03 / Cd 1.22 / ref 1.02 m² → CdA ≈ 1.24; downforce 456 N + drag 186 N @ 80 kph (note: force-implied CdA ≈ 0.65 disagrees with Cd×A ≈ 1.24 — spec inconsistency to resolve).
- Redline **14500 rpm** + shift time **0.1 s** (100 ms) — confirmed. SDM25 preset = same chassis, **3.5 final drive**, auto-applied to any `sdm25`-named config (SDM26 → 3.0). *Still estimates:* μ ≈ 1.5 (Hoosier R20), drivetrain_eff 0.85.

## P1 — Vehicle + tractive map + acceleration + skidpad readout

New **pure** module `cfd/lib/performance/` (fully unit-tested), a `VehicleConfig` editor, and a new **Performance** screen (NavRail entry) that takes a source torque curve (a sweep's points, or an optimization trial's `sweepPoints`).

1. **Tractive map** — `tractiveForce(vehicle, torqueCurve)`:
   - per gear `F_i(v) = T(rpm)·η·(2π/60)/vps_i`, with `rpm = v/vps_i`; envelope = max over gears. (`vps_i` from the gearing table — no tire-radius dependence.)
   - traction-limit line `F_max = mu_long·m·g` (v1; weight-transfer / aero refinement noted as later work).
   - resistance `F_res(v) = ½·ρ·CdA·v² + Crr·m·g`.
   - Chart: force-vs-speed, per-gear curves + envelope + traction limit + resistance.
2. **Acceleration** — `simAccel(vehicle, torqueCurve)`:
   - 75 m forward integration; traction-limited launch; **optimal shifts** — upshift at the tractive-force crossover (or rev limit), sequential/up-only, but only when the shift reaches the finish sooner than riding the current gear out (accounting for the `shiftTimeS` no-drive coast) — so it runs 1-2-3-4 and rides out the last usable gear to the limiter; `a = (min(F_tractive, F_traction) − F_res)/m`. Outputs `t_75`, finish gear, `v(x)`/`rpm(x)` traces, and the recorded **shift schedule** (gear, speed, rpm) shown in the UI.
   - projected points via §D.9 when a baseline is present.
3. **Skidpad readout** — `skidpad(vehicle, targetTime, opts)`:
   - `R = 7.625 + track_width/2 + clearance` (default clearance 0.1 m), editable; `v = 2πR / T`; per-gear `engine_rpm = v / vps_i`; lateral load `v²/(R·g)`. Table + markers on the torque curve.
4. **Tests:** tractive force vs hand calc; accel integrator vs constant-force analytic (`x = ½at²`); skidpad rpm + lateral-g math; points formulas at `Ty=Tmin` (max) and `Ty=Tmax` (floor).

## P2–P5 (sketch — separate spec/plan each)

- **P2** QSS 2D lap sim — corner `v_max = √(mu_lat·g·R)`, forward/backward grip-limited passes (friction circle vs engine tractive force), `lap time` + `fuel/lap` (WOT fuel-rate × on-throttle time + near-idle off-throttle; flagged approximation) → autocross/endurance/efficiency metrics + projected points + graphs; optimizer re-rank objective + composite.
- **P3** Fuel switching (Rust) — fuel preset `{ afr_stoich, q_lhv, octane, co2_per_l }` replacing the hardcoded 14.7 in `afr_eta_factor`; config-editor dropdown (E85 / 100 / 91–93); parity-suite update.
- **P4** Post-hoc sensitivity tornado — Spearman of each tunable vs any (incl. new event) metric, mined from existing trials.
- **P5** Light-mode export — light-palette chart/report renderer; tractive map + design-review one-pager.

## Open items / caveats

- Vehicle preset now uses real SDM26 spec-sheet values; still need confirmed μ, shift_rpm/rev_limit (estimated).
- Accel traction limit now includes longitudinal weight transfer (closed form `F = μ(W_rear + F·h/L)`) + rear aero downforce (~47% of Cl·A) — launch ≈1.05 g vs ~0.77 g static. Lateral / combined-grip (friction circle) is deferred to the P2 lap sim.
- Final drive auto-matches the loaded config (SDM26 → 3.0, SDM25 → 3.5) via `carKeyForConfig`. With the correct 14500 redline, stock ratios + FD 3.0 run 1-2-3-4 and ride out 4th — the earlier 6th-gear finish was the wrong 10500 redline, now fixed.
- Aero CdA has a spec-sheet inconsistency (Cd×A ≈ 1.24 vs force-implied ≈ 0.65) — default to 1.24, flag for Nick to confirm.
- Fuel thermodynamic properties (LHV, AFR_stoich, octane) come from Sunoco datasheets / standard refs (P3).
- Lap part-load fuel is approximated (no BSFC map) — relative, not absolute.
- Reference baseline seeded from most recent published FSAE results, then corrected by Nick.
