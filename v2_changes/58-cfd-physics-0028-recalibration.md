# 58 — CFD physics: dyno-RMSE recalibration (finding 0028) + measured-dyno scoring

**Mandate (v4.3.3):** refine the 1D engine model and lap-sim accuracy; Python
parity retired as a constraint as long as the Rust solver is *more accurate*.

## Solver calibration (Rust)

Recalibrated the shipped defaults against BOTH real team dynos (banded wheel-power
RMSE, C10 anti-overfit guard across SDM26 + SDM25). Full method, 27-variant
matrix, and figure: `physics_findings/0028-dyno-rmse-recalibration/`.

- WOT-band RMSE: **SDM26 5.80 → 2.56 kW** (−56% vs legacy), **SDM25 6.54 → 4.54 kW**;
  both high-RPM bands roughly halve. The dyno's 12.5k power plateau is now reproduced.
- Shipped knob set = production (0021) + van Leer limiter @ CFL 0.5 (numerics
  fidelity — always-minmod @ 0.85 was damping the intake/exhaust acoustics),
  flat-top cam lift + low-Re valve Cd (0015), collector reflection 0.15 (0007),
  η_comb 0.94 (rich-AFR Heywood value).
- `SDM26Config::calibrated()` carries it programmatically; `default()` stays
  frozen as the Python-parity baseline so the entire kernel parity suite still
  runs unchanged. App configs pick it up via the loader's extended `physics`
  section (now covers limiter/cfl/lift/Re-Cd/reflection/afr_eta).
- Optimizer schema ranges un-clipped: `afr_target` floor 11.5 → 10.5, IVC
  ceiling 620° → 645° (both flagged by the May synthesis as binding real optima).

## Lap-sim / UI accuracy

- **Wheel-vs-wheel fix:** the on-screen and report dyno RMSE compared sim *brake*
  power against *wheel* dyno data — flattering the sim by the driveline loss
  (~15%). Both now compare wheel power (`SweepResults`, master report).
- **Measured-dyno engine source:** the Performance screen can score events on the
  imported dyno curve (`torqueCurveFromDyno`, wheel→crank via driveline η) —
  zero engine-model error for as-built event projections.
- **Model-accuracy strip:** banded sim-vs-dyno agreement (the 0028 calibration
  bands) shown on the Performance screen whenever a dyno reference is attached.

## Repo cleanup

- The May physics-audit artifacts (26 files: conservation_*.json, synthesis/
  validation/parity reports) moved from the repo root to
  `physics_findings/audit-2026-05/`; the conservation-audit test now writes
  there; spec links repointed. Root is back to standard project files only.
