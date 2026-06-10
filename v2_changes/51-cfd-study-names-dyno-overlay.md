# 51 — CFD: study renaming, provenance names, dyno validation overlay, a11y

**Date:** 2026-06-09 · Frontend-only. Spec:
`docs/superpowers/specs/2026-06-09-cfd-study-names-and-dyno-overlay-design.md`

- **Rename any study** inline (Studies list + every results header), keyboard
  end-to-end: Enter opens, Enter commits, Esc cancels, blank clears back to
  the config name. Names flow into the Compare / Performance / Lap Sim
  source dropdowns and persist across reloads.
- **Provenance auto-names**: a sweep run from an optimization trial's recipe
  is born `sdm26 — opt #12 recipe`; "Refine around #1" spawns
  `sdm26 — refine of #12` — no more three studies all called "sdm26.json".
- **Dyno validation overlay** (roadmap #2): import a dyno CSV (team reference
  format or raw Dynojet hp/lb-ft — units auto-convert) onto any sweep. Dyno
  points overlay the power + torque charts and an RMSE/bias chip
  (sim − dyno) updates with the curve, putting the sim's accuracy claim on
  screen instead of in docs. Persisted with the study; never bundled.
- **Accessibility**: optimization trial rows are keyboard-selectable with a
  visible focus ring; uPlot canvas charts are named `role="img"` regions.

13 new tests (parser/units, RMSE math by hand, reducers, editor keyboard
contract); 461 CFD tests + typecheck green.
