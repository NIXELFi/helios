---
id: 30
slug: tune-sensitivity
status: SHIPPED-CAPABILITY / HYPOTHESIS-PARTIAL
topic: Nick's hypothesis — neither car was tuned 100% well, so the model (idealized smooth map) should over-read the dyno (the flashed tune) wherever the tune was off. Shipped per-RPM measured ignition-map support (physics.spark_advance_map) so the actual ECU table can be loaded, then quantified the model's spark sensitivity in the SDM26 sag band: -5 deg costs 0.3-0.5 kW, -10 deg costs 1.4-1.5 kW vs a dyno sag of 2.3-5.9 kW. Direction matches, magnitude covers under half — AND the model's spark sensitivity is itself understated (prescribed Wiebe duration does not lengthen with retard like real retarded combustion does), so in reality a ~10 deg conservative band could plausibly account for most of the sag. Unverifiable without the real map.
hypothesis: A conservative/imperfect ignition map in 10.5-12k explains the SDM26 dyno sag that no breathing or thermal mechanism could (findings 0028/0029).
opened: 2026-06-10
closed: 2026-06-10
owner: physics-investigator
spawned_by: Nick 2026-06-10 "I would assume that neither of these cars were tuned 100% well"
commit_hash: ~
baseline_fingerprint: feat/physics-accuracy-0028 @ f619f3b
revalidation_count: 0
acceptance_approved_at: 2026-06-10
---

## Capability shipped

`physics.spark_advance_map` — [[rpm, deg BTDC], ...] in any config's physics
section, strictly-increasing rpm enforced by the loader, linear interp
clamped at the ends, REPLACES the scalar spark_advance + MBT slope when
present. Knock-control retard (0029) still subtracts on top. Default absent
→ parity. Loader + interpolation unit-tested.

This converts "the tune was probably imperfect" from an assumption into a
measurement: export the ignition table from the ECU, paste it into the
config, and the residual between sim-with-real-map and the dyno is the
MODEL's error; the residual between real-map and idealized-map is the
TUNE's cost (recoverable power, band by band).

## Experiment (fig_tune_sensitivity.png)

SDM26, 0028 calibration, spark pulled only across 10.5-12k:

| rpm | base | -5 deg | -10 deg | dyno |
|-----|-----:|-------:|--------:|-----:|
| 10500 | 44.70 | 44.40 | 43.32 | 42.42 |
| 11000 | 45.30 | 44.99 | 43.83 | 42.51 |
| 11500 | 47.07 | 46.55 | 45.20 | 41.11 |
| 12000 | 47.18 | 46.89 | 45.68 | 42.13 |

(wheel kW). Quadratic sensitivity as MBT theory predicts (~0.07 kW/deg at
5 deg, ~0.15 kW/deg at 10 deg in-band).

## Verdict

- Direction: correct — a band-retarded map produces a band sag and nothing
  else moves (the graph confirms no shape side-effects).
- Magnitude in-model: covers < half the observed sag even at -10 deg.
- Caveat on the model side: prescribed-Wiebe combustion understates real
  spark sensitivity (real retarded burns are also slower/less stable;
  rule-of-thumb real losses are ~2x what this model shows), so the
  real-world tune cost of a 10 deg conservative band plausibly reaches
  3-4 kW — most of the sag.
- DECISION: keep the model on the idealized map and do NOT calibrate
  physics toward the sag. Treat the model's +1-2 kW peak-band optimism as
  "potential vs as-tuned" margin until the team exports the actual
  ignition (and ideally fuel) tables. That export is the single cheapest
  way to close the last accuracy gap — no dyno time needed.
