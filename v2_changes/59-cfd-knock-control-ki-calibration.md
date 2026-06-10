# 59 — CFD physics: knock-control feature + knock-integral field calibration (finding 0029)

Continuation of the v4.3.3 accuracy mandate. Full method and rejected
branches: `physics_findings/0029-exhaust-thermal-woschni/finding.md`.

## What shipped

- **ECU-style closed-loop knock control (opt-in, default OFF).** When
  `knock_control_enabled`, each cylinder's spark retards by
  `knock_retard_step_deg` at any cycle whose Livengood-Wu integral exceeds
  `knock_integral_limit` (clamped to `knock_max_retard_deg`) and relaxes back
  at 1/4 step when comfortably below — a production ECU's knock strategy.
  Per-cycle applied retard is reported as `knockRetardDeg` in CycleStats and
  the bench NDJSON. Purpose: SDM27 design exploration — knock-prone concepts
  now derate themselves instead of reporting unachievable power.

- **Knock-integral field calibration.** The team has NEVER had knock on any
  build, but the model read KI > 1 across configs — false positives from two
  defects: `octane_number` held the AKI-style 95 where Douaud-Eyzat wants RON
  (team's Sunoco 93-AKI ≈ RON 98), and the 1978 CFR-calibrated
  pre-exponential over-predicts for modern fast-burn chambers. New
  `knock_tau_scale` knob (default 1.0 = parity); shipped configs carry
  RON 98 + tau×2.0 → worst-case KI 0.75 (knock-free with margin, still
  sensitive to genuinely risky designs). Power curves verified bit-identical.

## What was tested and rejected (documented, not shipped)

- Exhaust wall-temperature and Woschni/cylinder-wall variants for the
  remaining SDM26 shape residuals: all are vertical offsets that trade SDM26
  accuracy against SDM25 (C10 anti-overfit guard) — rejected on the round
  graphs, per the "shape first" review rule.
- The "SDM26 dyno sag = real knock retard" hypothesis: refuted by the field
  evidence above; the sag stays honestly unexplained pending as-built
  geometry verification.
