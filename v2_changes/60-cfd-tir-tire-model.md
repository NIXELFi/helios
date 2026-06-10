# 60 — Lap sim: measured tire model (.tir loader) replaces guessed μ constants

The suspension team produced a Pacejka MF6.1 tire fit (.tir) for the
16x7.5-10 R20. The lap sim now runs on the MEASURED peak-friction-vs-load
law instead of hand-tuned constants.

**Proprietary-data rule:** tire fit data never enters the repo. The app has a
runtime `.tir` loader (`lib/performance/tir.ts`); the imported model lives in
local app state only, and all tests use synthetic invented coefficients.

## What changed

- **`.tir` loader + MF6.1 peak-friction evaluation** — parses the
  ADAMS/OptimumT property format and distills μx(Fz)/μy(Fz):
  `(PDX1 + PDX2·dfz)` / `|PDY1 + PDY2·dfz|` with inflation-pressure terms at
  the file's INFLPRES, per Pacejka §4.3.2. (First cut had the load term
  multiplicative — the unit tests caught it; it's additive.)
- **Grip model upgrades** (only when a tire is imported; legacy constants
  otherwise): corner/brake grip from μy(Fz) at the speed-dependent per-tire
  load; lateral-load-transfer factor χ now capacity-weighted directly from
  μ(Fz) (the power-law closed form remains the fallback); drive traction and
  the accel event's traction limit from μx(Fz) at the rear per-tire load.
- **Per-axis surface scales** — belt→asphalt transfer measurably differs by
  axis. Anchored against SDM26's real 2026 events with the 0028 dyno-fit
  engine curve: lateral 0.625 (autocross 42.844 s sim vs 42.922 s real),
  longitudinal 0.70 (accel 4.186 s vs ~4.2 s real); endurance stays on the
  Mines anchor (158.7 vs 159.6 s/lap). These scales are OUR calibration
  constants, not tire data.
- **UI:** Vehicle setup gains "Import tire model (.tir)" with a live
  μ_lat/μ_long-at-static readout (sanity check on the fit quality), per-axis
  scale fields, and remove. The tire rides the persisted vehicle config.

## Notes / not used (yet)

- The .tir's combined-slip shape factors (RBX/RBY…) could replace the
  circular friction-ellipse approximation; aligning moment and camber terms
  have no DOF in the QSS model. Rolling-resistance terms are unfitted zeros
  in the current file.
- The fit's Fx pressure coefficients look under-constrained (the file's
  dpi = −0.62 is a big extrapolation); the per-axis scales absorb this, and
  the μ readout in the UI keeps it visible.
