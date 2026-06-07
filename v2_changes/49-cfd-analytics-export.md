# 49 — v4.1.0: CFD analytics overhaul + universal study export

**Date:** 2026-06-05

Major CFD-module release: every screen gains real analytics, and every study
kind is exportable. Zero solver-math changes — verified twice by the pre-commit
parity suite and an explicit merge-base diff (`crates/` + `src-tauri/` empty).

## Optimization screen (headline)
The optimization results screen is now a live decision tool, not a flat table:

- **Live top-3 podium** — gold / silver / bronze cards rank trials *while the
  run executes* (client-side selector layered over the untouched reducer;
  rank 1 always agrees with the backend's `bestTrialIdx` after job-done).
  Delta-to-best shown absolute and as %.
- **Convergence chart** — objective per trial with a running-best step line:
  the curve you watch to decide when to cancel a run.
- **Objective-vs-parameter scatter** — one chip per tunable; top-3 highlighted.
  This is the "trends in different parameters" view.
- **Sortable ranked table** — rank / Δ-best columns, click-to-sort headers,
  podium row tinting, pulse indicator on in-flight trials. Rows without the
  sorted quantity always partition to the bottom.
- **ETA** (`~Xm est.`) from mean trial wall time, shown only while running with
  ≥3 done trials.
- **Recipe card** in the trial inspector — winning parameter values with units
  (from the parameter schema), one-click copy; best-trial curve overlay when
  inspecting any other trial.

## Sweep + Single-RPM screens
- Sweep **summary band**: peak power / torque / VE with parabolic-vertex
  interpolated RPM, powerband width (≥95% of peak), knock-integral max chip.
- New **brake-torque-vs-RPM** chart (the missing headline FSAE curve) and a
  knock-integral chart when data carries it.
- Single-RPM **summary card** (final IMEP/VE/power/torque/EGT, CoV(IMEP) of
  the last 5 cycles, backend converged-cycle) + collapsible **convergence
  panel** plotting per-cycle ΔIMEP% against the tolerance line.
- `knockIntegral` (Livengood-Wu) was always sent by the backend but silently
  dropped by the TS types — now surfaced everywhere as raw "KI" (never
  labelled "margin"; the normalization is unconfirmed).

## Universal export
- **Every study kind, every status** (running = partial snapshot) exports from
  the Studies list per-row menu and each results screen header.
- **CSV** (two header rows: names + units, spreadsheet/MATLAB-friendly):
  cycles, per-RPM points, optimization trials (rank + Δ-best columns), and
  long-format trial curves. Tiny magnitudes (~1e-7 conservation diagnostics,
  minimize-objectives) serialize exponentially — the file matches the screen.
- **Study JSON bundle** — self-describing and *reproducible*: carries
  sampler + seed + tunables + locked pairs + objective, so an optimization
  study can be regenerated from its params alone. "Export all (JSON)"
  workspace bundle on the Studies screen.
- **Clipboard**: TSV trial table, best-trial recipe, summary lines.
- **Wave viewer**: PNG capture of the active schematic/waterfall canvas and a
  current-frame CSV (`x_m_derived` clearly named as reconstructed).
- All export I/O goes through one Tauri seam (`save()` dialog +
  `writeTextFile`/`writeFile`); nothing is written back to app state.

## Verification
- 4-design judge panel → minimal-risk skeleton + grafts; vetoes enforced (no
  on-screen correlation stats at FSAE trial counts, no reducer rewiring).
- 15-agent adversarial review with per-finding refutation: all spec hard rules
  verified clean; 7 confirmed findings fixed in the same release (export
  number fidelity, popover clipping, sort partition, tie labelling, canvas-ref
  churn).
- 1150/1150 desktop tests green (164 new), tsc clean, physics parity suite
  green on every commit.
