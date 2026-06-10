# 52 — CFD: final-drive optimizer + knock-margin surfacing

**Date:** 2026-06-09 · Frontend-only. Roadmap items #1 and #4.

- **Final-drive optimizer** (Performance screen): "Sweep sprockets" scores
  every real 520-chain tooth combination (front 12–16T, rear 36–56T,
  FD 2.4–4.4) through the production computeEvents chain — interactive only
  because of the vCorner memo (#50). Total-FSAE-points-vs-FD chart with the
  current ratio marked, plus a top-8 table in real teeth ("3.000 = 42/14 =
  45/15") with per-event times and Δpts vs current. The cheapest hardware
  change the team can make, quantified in points.
- **Knock-margin surfacing** (optimization results): per-trial max
  Livengood–Wu integral is now a sortable "KI max" column — ⚠ red when
  I > 1.0 — with a knocking-trial count in the header and a ⚠ badge on podium
  cards. High-CR trials can no longer silently "win" with designs that would
  detonate.

3 new tests; 464 CFD tests + typecheck green.
