# 62 — Lap sim v4.3.3: measurement-driven accuracy + race-engineer tooling

Consolidated log of the lap-sim overhaul that followed the solver
recalibration (entries 58–61). Theme: replace every guessed constant with a
measurement, and make the sim explorable like real telemetry.

## Accuracy chain (each knob pinned by its own measurement)

- **Traced-curvature tracks** (`trackFromVisual`): the sim's radius profile
  now derives from the traced course centerlines (Menger curvature, 6 m
  smoothing) instead of hand-built constant-radius arcs — killed the
  corner-speed plateaus (RPM "hangs": 25% of lap → ~0%) and made the
  lap-distance → map position exact. Courses rescaled to rules-nominal
  lengths (AX 800 m, EN 2.20 km); validated by tire-scale lat/long
  consistency, not just the rulebook.
- **Measured tire** (`.tir` loader, entry 60) pinned by the REAL skidpad
  (SDM26 5.02 s): lateral surface scale 0.574, default μLat 1.368.
- **Racing line** physically bounded (≤17 m of radius from course width)
  and solved on the real 42.922 s autocross: LINE_FACTOR 1.159.
- **Per-axle roll balance** (entry 61) with the measured 55.3% front aero
  share from the 2026 CFD aero map; presets updated to the map's nominal
  ClA 3.146 / CdA 1.294.
- **Endurance pace** scales corner ceilings only — straights run flat-out,
  so endurance reaches top gears like real telemetry (PACE 0.540 on the
  Mines 159.6 s/lap anchor).
- **Variable-throttle fuel** (`fuelMap.ts`): Willans line derived entirely
  from solver sweep data (friction power = indicated − brake; WOT fuel from
  trapped air mass / AFR; η_ind 0.35–0.38). UNCALIBRATED validation: SDM26
  endurance on E85 predicts 0.956 kg CO₂/lap vs the real Mines 0.9786
  (2.3%, zero knobs) — the efficiency ranking no longer depends on a lumped
  thermal-efficiency constant.

## Team-data pipeline (proprietary data stays out of the repo)

Folder convention auto-loaded by one button (path persists):

    <Simulation Data>/
      tire/<name>.tir            Pacejka MF6.x fit
      aero/<car>-aero-map.csv    Helios aero map v1 (cl/cd/front_frac vs
                                 ride height; see lib/performance/aeroMap.ts)

## Tooling / UI

- **Lap player**: play/scrub the simulated lap on the channel-colored track
  map (A and B dots race in real time), every channel + solver engine
  internals (power, VE, EGT, BMEP) interpolated at the cursor.
- **Supersport LCD cluster**: rpm scale sweeps up from low-left across the
  top (gradient band edge = indicator), gear top-left, big digital speed,
  shift light, live g-dot, engine-vitals bar gauges.
- **Residency histograms** (rpm/speed/lat-g, time-weighted, A/B overlay) and
  a **channel analyzer**: any channel as distance/time trace or histogram,
  filtered by limit state + distance window, with time-weighted slice stats.
- **Design sensitivities** panel: one realistic step per lever (mass, aero,
  grip, driveline, shift time, CG, ARB balance) through the full scoring
  chain, ranked by FSAE points.
- Limit-state display: "grip" now reads **traction** (drive tires can't put
  torque down) vs **corner** (riding the lateral ceiling); per-axle balance
  readout reports the capacity margin (push/neutral/loose %).
- Skidpad model prediction shown next to the readout (anchored at 5.02 s,
  regression-tested).
