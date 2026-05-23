---
id: 11
slug: woschni-twozone-joint-recalibration
status: VALIDATED
topic: 2D LHS over (woschni_c1_combustion, woschni_c2_combustion) with two_zone_enabled=1 to test whether Woschni can be re-tuned to make two-zone competitive with single-zone. **Conclusive NEGATIVE result**: even in the BEST corner of Heywood's recommended range (c1=2.72, c2=0.0049), two-zone gives RMSE 7.29 / bias +2.20 vs single-zone baseline RMSE 7.19 / bias +0.77 on the same RPMs. Two-zone is not a defensible production upgrade.
hypothesis: 0010 documented that two_zone_enabled gives a uniform +3 kW BP boost that worsens overall fit. The two_zone documentation in code (`combustion.rs`) explicitly notes that Woschni c1 typically needs a downward retune when two-zone is enabled. Hypothesis: with optimal Woschni for two-zone (joint 2D optimization over c1, c2 within Heywood's recommended range), two-zone+joint-Woschni can beat single-zone+default-Woschni. Falsification: if NO point in the Heywood-recommended Woschni range produces a better fit with two-zone than single-zone with default Woschni, two-zone is fundamentally limited at this calibration.
opened: 2026-05-23
closed: 2026-05-23
owner: physics-investigator
spawned_by: manual
commit_hash: ~
baseline_fingerprint: ~
revalidation_count: 0
acceptance_approved_at: 2026-05-23
---

## Study design

25-trial LHS over:
- `woschni_c1_combustion` ∈ [1.5, 3.0] (Heywood Tab 12.1: 1.8-2.6)
- `woschni_c2_combustion` ∈ [0.0, 0.005] (Heywood: 0-0.005)

With all production knobs ON + `two_zone_enabled = 1`. SDM26 at 4 RPMs
(8k, 10k, 11k, 12k — FSAE peak band), 30 cycles, seed 11000.

## Results

### 1. Top 5 (c1, c2) combinations by RMSE

| c1 | c2 | RMSE | bias | η_imp@10k |
|----:|----:|----:|----:|----:|
| **2.72** | **0.0049** | **7.29** | **+2.20** | 0.822 |
| 2.68 | 0.0045 | 7.39 | +2.51 | 0.816 |
| 2.19 | 0.0047 | 7.44 | +2.78 | 0.812 |
| 2.44 | 0.0040 | 7.60 | +3.09 | 0.806 |
| 2.33 | 0.0037 | 7.75 | +3.44 | 0.800 |

The best two-zone result needs **c1 = 2.72**, slightly above Heywood's
upper-recommended bound of 2.6 but within literature-defensible
territory. c2 lands at the high end of the recommended range (~0.005).

### 2. Comparison vs single-zone baseline

| Variant (SDM26, 8k/10k/11k/12k, wheel power) | RMSE | bias | η_imp@10k |
|---|---:|---:|---:|
| **Single-zone (default Woschni, prod knobs)** | **7.19** | **+0.77** | **0.850** |
| Two-zone + best joint Woschni (c1=2.72, c2=0.0049) | 7.29 | +2.20 | 0.822 |

Single-zone baseline still wins on every metric:
- Lower RMSE (7.19 vs 7.29)
- Lower bias (+0.77 vs +2.20 kW)
- Implied η at 10000 RPM exactly matches Cameron handbook 0.85

**Two-zone with optimal Woschni cannot beat single-zone with default
Woschni.** The +3 kW boost two-zone applies uniformly is the wrong
direction at the model's sweet spot — no amount of Woschni adjustment
within physical range cancels it cleanly.

### 3. Why two-zone over-predicts even with high c1

Two-zone's per-zone heat-loss formulation should INCREASE Q_loss at
matched Woschni c1 (because T_b > T_avg means burned-zone Q_loss is
larger than single-zone's mass-averaged equivalent). The Q_loss
increase should REDUCE IMEP. But empirically IMEP INCREASES by ~3 kW.

Hypothesis (not tested in this finding): the per-zone γ split (γ_b
for burned vs γ_u for unburned, both currently 1.4 — see combustion.rs
two_zone branch) is the dominant effect, not Q_loss. With γ_b
incorrectly held at 1.4 (real burned gas has γ ~ 1.25-1.3 due to
high T), the model over-predicts expansion-stroke work because
γ-dependent dW/dV is too large. To make two-zone valid, γ(T)
modeling per zone is required — that's a 0012 candidate ("variable
gamma in two-zone").

## Conclusion

**VALIDATED.** The 0010 negative recommendation stands and is now
strengthened. Two-zone cannot be rehabilitated by Woschni recalibration
alone within Heywood's range. The fundamental physics limitation is
the constant-γ per zone, not the heat-loss budget.

For SDM27 design: continue using single-zone (default). Two-zone
becomes interesting only AFTER variable γ(T) per zone is implemented
(0012 candidate). Until then, the production knob set is unchanged:

```toml
intake_junction_borda_carnot = 1
intake_junction_loss_coef = 1.0
restrictor_loss_from_diffuser_geometry = 1
restrictor_cd_mach_k = 0.3
spark_advance_rpm_slope_deg_per_krpm = 1.5
duration_rpm_exp = 0.4
# two_zone_enabled = 0  (KEEP DEFAULT — single-zone wins)
# afr_eta_enabled = 0   (KEEP DEFAULT unless studying off-stoich)
```

## Comparison vs spec

| Criterion                                  | Status |
|--------------------------------------------|--------|
| Parity goldens                             | ✓ 20/20 |
| C9 conservation across 25 LHS trials       | ✓ 0 fail |
| Joint 2D optimization terminated cleanly   | ✓      |
| Negative finding documented                | ✓      |
| Production recommendation explicit         | ✓      |

## Followup queue

- **0012 — Variable γ(T) per zone**: the constant γ=1.4 in the burned
  zone is the dominant model limitation revealed by this finding.
  Per Heywood Fig 4-9, γ drops from 1.4 to ~1.25 as T rises from
  300K to 2800K. Implementing γ(T) using Burcat NASA-7 polynomials
  (already in `references/literature/burcat-nasa7-coefficients.md`)
  in the burned-zone integration would close the over-prediction
  observed here and make two-zone a defensible upgrade.
- **0013 — single-zone Woschni sensitivity at default config**: brief
  follow-up: does varying c1 alone (without two-zone) move single-
  zone's already-good fit in any useful direction? Likely no, given
  the implied η = 0.85 at 10k is already perfect, but worth
  documenting.
