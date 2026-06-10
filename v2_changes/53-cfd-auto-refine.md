# 53 — CFD: auto-refine loop + sensitivity TSV export

**Date:** 2026-06-09 · Frontend-only. Roadmap #8 + handoff pending item.

- **Auto-refine** (optimization results): "▶ Auto-refine" runs 2/3/5 refine
  rounds hands-off — each round re-samples in a 0.3× box around the previous
  round's #1 (in the active ranking dimension, FSAE metrics included) and the
  loop stops early when the best improves < 0.5% relative. Each round is a
  provenance-named study ("sdm26 — refine of #N"), so the lineage reads like a
  log. Loop state survives the per-round screen remount (module-level
  controller); Stop ends the loop without cancelling the running job.
- **Copy sensitivity (TSV)**: the Spearman tornado table exports through the
  Export menu for the design log (parameter, ρ, n, active metric).

5 new tests; 469 CFD tests + typecheck green.
