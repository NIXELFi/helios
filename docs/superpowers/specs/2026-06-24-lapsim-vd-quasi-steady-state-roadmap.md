# CFD Lap Sim: vehicle-dynamics sweeps + quasi-steady-state roadmap — design

**Date:** 2026-06-24 · **Source:** Daniel Germaine (Chief Engineer) feature
report — "quasi-steady-state VD model; tire µ %dropoff for load
transfer/distribution; analyze CG height, mass, RSD, etc." · **Roadmap item:**
#13 (`docs/cfd-roadmap.md`, "Lap-time sensitivity panel — vehicle knobs").

## Key finding (why this is a SWEEP build, not a physics build)

The requested vehicle-dynamics physics ALREADY EXISTS in
`lib/performance/lapSim.ts` and is wired through `types.ts` + the SDM presets:

- **Load-sensitive µ** — `µ_eff = µ·(Fz/Fz_static)^(−sens)`
  (`makeGripModel`, the `loadMult`/`sens` path). `sens` is
  `VehicleConfig.tireLoadSensitivity`.
- **Lateral load transfer χ** — outer tires gain less µ than the inner tires
  lose, discounting axle capacity. Closed form for the power-law tire; capacity
  weighted from `µ(Fz)` for a measured `.tir`.
- **Per-axle roll split** — with a `RollConfig`, lateral load transfer splits by
  roll-stiffness distribution (`rsdFront`) + roll-center geometry; each axle
  saturates on its own `µ(Fz)`; the car's limit is whichever axle gives up
  first (the understeer/oversteer balance).

So v1 surfaces these as **sweepable inputs** on the existing lap sim, reusing the
A/B + CSV plumbing — no new physics formulas.

## v1 increment (shipped 2026-06-24)

### Pure cores (TDD red→green)

- **`lib/performance/loadSensitivity.ts`** — the %dropoff affordance. The
  vehicle team thinks in "grip lost per load DOUBLING", so
  `dropoffPctFromSens(sens) = (1 − 2^(−sens))·100` and its exact inverse
  `sensFromDropoffPct`. This RESTATES the grip model's exponent (no new knob);
  `tireLoadSensitivity` stays the stored source of truth. The default
  `sens = 0.15` (Hoosier R20) ≈ **9.87% µ drop/doubling**.
- **`lib/performance/vdSweep.ts`** — `VdParam =
  "massKg"|"cgHeightM"|"rsdFront"|"muDropoffPct"`, `VdSweepSpec{param,start,
  stop,step}`, `applyVdParam(v,p,x)`, `runVdSweep(curve,baseVehicle,track,spec,
  opts)` → one `VdSweepRow{value,lapTimeS,maxLatG,balanceMargin,fuelKg}` per
  step (each a real `simLap`). Physical default windows (`VD_PARAM_RANGE`): RSD
  0.376–0.605 (the ARB-calculator span), %dropoff 0–20 (≈ sens 0–0.32), and
  sensible mass/CG deltas — NOT arbitrary 0..1.

  **IDENTITY-CLOBBER TRAP (load-bearing):** `vehicleForCar` force-overwrites
  identity keys incl. `massKg` for known cars (`vehicle.ts` `IDENTITY_KEYS`).
  `applyVdParam` patches an ALREADY-RESOLVED `VehicleConfig` and never routes
  back through `vehicleForCar` — a mass sweep applied before identity resolution
  would silently reset to the preset (267 kg). Same warning as the FD optimizer.

### Seam refactor (load-bearing)

`LapSimScreen.runFor(src)` derived the vehicle internally; it now accepts
`runFor(src, vehicleOverride?)`. VD-sweep mode runs the **same engine curve
(source A)** with **two vehicles** — baseline and `applyVdParam(resolvedBase,
param, stop)` — so the existing deltaT / sector / g-g / headline visuals reuse
directly. This is the small-but-real edit the A/B reuse depends on; it is NOT
free.

### UI

- `PerformanceScreen` VehicleEditor: a **CG height** `NumField` row (`cgHeightM`,
  unit m, step 0.005) and a read-only **"≈ X% µ drop/doubling"** chip next to
  `tire load sens` (`dropoffPctFromSens`).
- `LapSimScreen` **VD-sweep mode** (gated behind a `vdMode` toggle so the
  default A/B study path is untouched when off): a param dropdown + start/stop/
  step controls; a "lap time vs VD value" `LinePlot` with a baseline marker; B
  is the swept setup at the last GRID value (the raw stop is snapped to
  `vdSweepValues(spec).at(-1)` so B is always a plotted point). Two params are
  gated, same disabled-option idiom: **`muDropoffPct`** is disabled when a `.tir`
  is loaded (the Pacejka fit overrides µ(Fz)), and **`cgHeightM`** is disabled
  when the resolved base vehicle has a roll config (the roll model keys lateral
  transfer on `hRollArmM`, so the CG lap-trend inverts — see the finding below);
  a disabled param can never be the active one (the screen falls back to a valid
  param). A sweep-summary CSV (`value, lapTimeS, maxLatG, balanceMargin, fuelKg`)
  via the existing `saveTextFile` seam.

### Directional invariants (validation anchors)

`__tests__/vdSweep.test.ts` asserts the REAL `simLap` + SDM26 preset behave as
a vehicle engineer expects: +mass ⇒ slower lap + lower maxLatG; +%dropoff ⇒
slower; an RSD-front sweep makes `balanceMargin` cross zero (monotone in RSD)
with the lap optimum INTERIOR to the ARB window (a setup sweet spot, not
"stiffer is always better"); and `tireLoadSensitivity = 0` with roll present
collapses onto the lumped baseline lap (regression guard). Use
`LapTelemetry.balanceMargin`, NOT `pctFrontLimited` (which saturates 0/1).

**Finding worth recording (and why CG-sweep is gated in v1):** under the
production PER-AXLE roll model, lateral load transfer is keyed on the
CG-to-roll-axis arm `hRollArmM`, NOT raw `cgHeightM`, so on a roll-config car a
`cgHeightM` sweep FREEZES lateral capacity (`maxLatG` flat) and the lap-time
trend actually **INVERTS**: with cornering grip held constant, raising CG only
moves LONGITUDINAL load transfer, which the model reads as marginally faster — so
higher CG plots as FASTER and the "fastest @" annotation points the wrong way.
CG's correct "higher ⇒ more transfer ⇒ slower" signature lives in the LUMPED χ
path only (`chi()` uses `cgHeightM` directly). Because the roll-model plot would
mislead the requester's headline parameter, **v1 GATES `cgHeightM` out of the
sweep dropdown whenever the resolved base vehicle has a roll config present**
(mirroring the `muDropoffPct`+`.tir` gate); it stays selectable on lumped-model
vehicles, where it is correct. The CG invariant test in `vdSweep.test.ts`
asserts the directional law on the lumped car, where the physics expresses it.
Promoting `cgHeightM` to a first-class driver of `hRollArmM` (coupling
`hRollArmM ↔ cgHeightM`) is therefore the **priority QSS follow-up** (stage 1
below) — it is deliberately deferred, not an oversight.

## Path to the full quasi-steady-state VD model (staged)

Build ON this foundation; each stage is independently shippable and testable.

1. **Full lateral load-transfer matrix.** Replace the simplified Milliken Ch.18
   axle split with the sprung/unsprung decomposition + jacking forces; make
   `hRollArmM` a DERIVED quantity of `cgHeightM` + roll-center geometry so a CG
   sweep drives the lateral transfer directly (closes the v1 finding above).
2. **Diagonal / longitudinal coupling.** Couple lateral transfer with
   longitudinal (combined braking-in-corner load states) at the per-corner
   level, beyond today's friction ellipse.
3. **Per-tire µ + combined-slip MF.** Per-tire vertical load → `µ(Fz)` from the
   Pacejka MF6.x fit (build on `tir.ts`), with combined-slip (lat+long) instead
   of the ellipse approximation.
4. **Per-station equilibrium solve.** Replace the bisection corner-speed solve
   with a per-station force/moment equilibrium (yaw balance), so balance is a
   solved state, not a post-hoc margin readout.

### Regression anchors (must hold through every stage)

- Skidpad **5.02 s** (the µ_lat pin, `predictSkidpad`).
- Autocross **42.922 s** flat-out (the LINE_FACTOR anchor).
- Endurance / efficiency anchors in `calibration.test.ts`
  (`LINE_FACTOR`, `ENDURANCE_PACE`, `ENDURANCE_THERMAL_EFF`).
- `tireLoadSensitivity = 0` + no `.tir` reduces EXACTLY to the legacy µ·g_eff.

### Calibration & data rules

- Each new physical knob gets its OWN measurement (skidpad pinned µ_lat; line
  factor solved on autocross) — do not let one knob absorb another's error.
- Proprietary tire data (`.tir`) and aero maps are imported at runtime and
  **never** committed to the repo. The %dropoff framing is display-only and
  carries no proprietary data.
- Side-note (external source, not a repo discrepancy): the preset mass is 267 kg
  (`vehicle.ts`); the team ARB spreadsheet uses ~279.5 kg. Reconcile when
  interpreting mass sweeps against real setup sheets.

## Files

- `lib/performance/loadSensitivity.ts`, `lib/performance/vdSweep.ts` (new, with
  `__tests__/`), re-exported from `lib/performance/index.ts`.
- `screens/LapSimScreen.tsx` (`runFor` seam + VD-sweep mode), `screens/
  PerformanceScreen.tsx` (CG row + %dropoff chip).
