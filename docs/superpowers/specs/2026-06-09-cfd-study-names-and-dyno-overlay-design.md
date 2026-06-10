# CFD: study rename + provenance names + dyno validation overlay — design

**Date:** 2026-06-09 · **Goals:** accuracy + accessibility (Nick's stated priorities)

## Study names

- `StudyBase.name?: string` — optional, so persisted/exported studies load
  unchanged. `studyName(study)` = custom name or config basename; the single
  display-name source for every screen, dropdown, and export label.
- `renameStudy(id, name)` reducer action: trims; blank/null **drops** the key
  (clean JSON), falling back to the config name.
- Inline rename via shared `StudyNameEditor` in the Studies list AND all three
  results headers. Accessibility contract: idle state is a real button
  ("Rename <name>"), editor is a labeled input, Enter commits / Esc cancels /
  blur commits, focus returns to the button on close.
- Provenance auto-names on spawn: sweep-from-trial-recipe → `sdm26 — opt #12
  recipe`; refine-around-best → `sdm26 — refine of #12`
  (`startSweep`/`startOptimization` gained an optional `{name}`).
- When a custom name is set, the config basename stays visible in muted text —
  the provenance is never hidden.

## Dyno validation overlay (roadmap #2)

- `parseDynoCsv` (pure, `lib/import/importDyno.ts`): accepts the team
  reference format (`rpm,brake_power_kW,brake_torque_Nm,…`) and raw Dynojet
  sheets — header-driven column + unit detection (hp→kW, lb-ft→Nm), junk rows
  skipped. Power/torque derive from each other when one is absent (P = τω).
- `SweepStudy.dynoRef?: DynoRef` — persisted with the study, rides along in
  exports. **Imported at runtime only; dyno CSVs are never bundled** (real
  data must not ship in the public repo).
- `compareDyno` (`lib/analytics/dynoCompare.ts`): brake-power RMSE + mean bias
  (sim − dyno, positive = sim over-predicts) over the overlapping RPM band,
  linear interpolation of the sim at each dyno rpm.
- SweepResults: "Import dyno CSV…" in the overlay strip → dyno series on the
  power + torque charts (#CE93D8) + an always-current RMSE/bias chip + remove.
  Parse failures render as an inline `role="alert"`, not a silent no-op.

## Accessibility fixes (audit findings)

- Optimization trial-table rows (select-to-inspect) were pointer-only → now
  focusable with Enter/Space activation + a visible focus ring.
- `LinePlot` draws to canvas (invisible to assistive tech) → the plot host is
  a named `role="img"` region (title + series labels).
- Audit found selects/modals/SVG charts already labeled (v4.3.0 did this
  well); no other gaps surfaced.
