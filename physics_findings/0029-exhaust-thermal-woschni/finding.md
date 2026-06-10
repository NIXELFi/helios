---
id: 29
slug: exhaust-thermal-woschni
status: CLOSED-MIXED
topic: Chased the three shape residuals left after 0028 (SDM26 10.5-12k over-prediction, SDM26 6-8k torque-hump phasing, SDM25 peak-torque under-read). Global thermal knobs (exhaust wall T, Woschni, cylinder wall T) are pure vertical offsets that trade SDM26 against SDM25 — all REJECTED under C10 + the shape rule. The knock-retard hypothesis for the SDM26 sag produced a real opt-in feature (ECU-style closed-loop knock control) but was REFUTED by field evidence: no team build has ever knocked. That evidence instead became the anchor for a KI field calibration (octane = RON 98, Douaud-Eyzat tau x2.0) — the model now agrees with reality that the team's engines are knock-free (worst-case KI 0.75), with zero change to power curves.
hypothesis: (a) Exhaust wall temperature shifts header acoustic phasing enough to move the torque hump; (b) the SDM26 dyno sag at 10.5-12k is the real ECU pulling timing where the model's KI crosses 1.0 (KI: 0.83 -> 1.14 across 10.5-12k, back to 0.79 by 13k; SDM25 stays < 1 and shows no sag).
opened: 2026-06-10
closed: 2026-06-10
owner: physics-investigator
spawned_by: v4.3.3 accuracy mandate, continuation of finding 0028
commit_hash: ~
baseline_fingerprint: feat/physics-accuracy-0028 @ 7b00ce1
revalidation_count: 1
acceptance_approved_at: 2026-06-10
---

## Round 1 — global thermal knobs: REJECTED

Variants on top of the 0028 base (app configs): primary/secondary/collector
wall T {850/750/650, 1000/880/760}, woschni_c1_comb 3.2, woschni_c2 5e-3,
t_wall 500. Verdict from `fig_round_review.png` (the graph, not just RMSE):
every variant is a near-parallel offset of base — no phase shift of the
torque hump, no sag creation. Hotter exhaust walls are strictly worse
(SDM26 WOT 2.56 -> 2.93). The Woschni bumps "win" SDM26 (sag bias +4.0 ->
+2.9) but push SDM25 from -2.4 to -3.5 high-band bias — the exact C10
anti-overfit signature. All rejected.

## Round 2 — knock-control hypothesis: feature kept, hypothesis REFUTED

The KI-vs-sag correlation was striking (KI crosses 1.0 exactly in the sag
band, on the sag engine only), so ECU-style closed-loop knock control was
implemented: per-cylinder spark retard at each cycle boundary when KI >
limit, 1/4-step relax below it (`knock_control_enabled`,
`knock_integral_limit`, `knock_retard_step_deg`, `knock_max_retard_deg`,
all parity-default-off, sweepable, loadable). Effect was real but small
(sag RMSE 4.30 -> 4.13 at limit 0.9) — and the team's field evidence
(below) refutes the premise, so it ships DISABLED. It remains the right
tool for SDM27 design exploration (a high-CR concept now derates itself
instead of reporting fantasy power).

## Round 3 — KI field calibration: SHIPPED

Field anchor (Nick, 2026-06-10): **no team build has ever knocked or had
pre-detonation issues.** The open-loop model claimed KI > 1 at low RPM on
every config and at 11.5-12k on SDM26 — false positives. Two defects:

1. `octane_number` was 95 but Douaud-Eyzat wants **RON**; the team's
   Sunoco 93-AKI pump fuel is ~RON 98.
2. The D-E pre-exponential (17.68, CFR engine, 1978) over-predicts knock
   for modern fast-burn pent-roof chambers; rescaling tau against a known
   knock boundary is standard practice. New `knock_tau_scale` knob
   (default 1.0 = parity).

Calibration: RON 98 + tau_scale {1.5, 2.0, 2.5} -> worst-case KI across
both 19-point sweeps = {1.00, 0.75, 0.60}. **Shipped: tau_scale 2.0**
(knock-free with margin, but a +2-CR or hot-intake SDM27 concept would
still trip it; 1.5 leaves SDM26 sitting exactly at the limit). Power
verified bit-identical (max |dP| = 0.0 kW on both engines) — KI is
diagnostic-only, so the 0028 dyno fit is untouched.

## Residuals after 0029 (honest state)

- SDM26 10.5-12k sag: UNEXPLAINED. Not global-thermal, not knock-retard.
  Remaining candidates: per-cylinder runner/airbox interaction detail,
  real-tune cam/VE specifics, or dyno-day conditions. Park until per-engine
  as-built geometry is verified by the team.
- SDM26 6-8k torque-hump phasing + SDM25 peak torque: same parking lot.
- The model and the field now agree on knock: none.
