# 54 — CFD: master engineering report (Ansys-style) on every screen

**Date:** 2026-06-09 · Frontend-only. Includes roadmap #9 (lap channels in the
report).

One print-ready engineering document that expands the whole workspace:

- **Structure:** cover → linked TOC → numbered sections — executive summary
  (all designs scored side by side, best starred), methodology & calibration
  (anchors + trust limits stated honestly), cross-design torque comparison
  with deltas, one section per sweep (power/torque chart, per-RPM data table,
  dyno-validation RMSE/bias + dashed overlay when a reference is attached),
  one per optimization (convergence envelope, top-10 designs with knock
  flags, Spearman sensitivity table), the best design's FSAE deep-dive with
  **lap telemetry** (rpm, shifts, g's, % power-/corner-limited, gear usage —
  roadmap #9), the traced 2026 courses, and a study-registry appendix.
- **Everything is recomputed through the production code paths**
  (computeEvents / sourcesFrom / rankTrials / compareDyno) at generation
  time, so the report can never disagree with the app. Names/configs are
  HTML-escaped. Print CSS paginates each section; open in a browser and
  print to PDF.
- **Buttons everywhere:** "Full report (PDF)" on Studies, Compare,
  Performance, and Lap Sim headers; "Report (print → PDF)" in the sweep and
  optimization Export menus (scoped to that study); Compare scopes to the
  pinned set ("Report — pinned").

3 new builder tests (structure, scoping, escaping); 472 CFD tests +
typecheck green.
