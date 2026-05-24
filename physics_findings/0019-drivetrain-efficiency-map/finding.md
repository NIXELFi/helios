---
id: 19
slug: drivetrain-efficiency-map
status: NEGATIVE
topic: Can a physically-defensible drivetrain η(P, ω) map fit both SDM25 and SDM26 dyno data better than the constant η = 0.85 Cameron-handbook default? Tested a literature-derived motorcycle chain+gear model with base_drag + RPM-quadratic windage. Result: the literature-defensible η spread is only ±2% across the operating envelope, giving sub-0.3 kW effect on RMSE. Asymmetric: very slightly helps SDM25 (under-predicted engine), very slightly hurts SDM26 (already-matched engine). Not transformative. Documented and rejected as production change because the practical effect is below dyno measurement noise.
hypothesis: The huge implied-η swings (0.5–1.2) in our diagnostics suggest the drivetrain might have meaningful RPM-dependent efficiency. A literature drivetrain map could explain part of the variation and close some of the remaining gap on both engines. Falsification: if the literature map gives < 5% η variation, it cannot explain the implied-η spread, which is therefore dominated by simulator/dyno error rather than drivetrain physics.
opened: 2026-05-23
closed: 2026-05-23
owner: physics-investigator
spawned_by: user question 2026-05-23
commit_hash: ~
baseline_fingerprint: production knob set @ 23adac6
revalidation_count: 0
acceptance_approved_at: 2026-05-23
---

## Model

Literature-derived chain+gear motorcycle drivetrain (Cameron, *Sportbike
Performance Handbook* + Heywood §13.7):

```
η(P_brake, ω) = η_max · P_brake / (P_brake + base_drag + windage · (ω/ω_max)²)
```

Parameters (all literature midpoints, **not tuned**):

| Symbol     | Value     | Source / rationale                                       |
|------------|----------:|----------------------------------------------------------|
| η_max      | 0.92      | Cameron upper bound for well-maintained chain + gearbox  |
| base_drag  | 2.5 kW    | idle drag (chain pitch friction, gear oil churn at zero load) |
| windage    | 1.5 kW    | RPM-quadratic viscous loss at ω_max (gear churn + bearings) |
| ω_max      | 14,000 RPM | redline normalization point                              |

Physical interpretation:
- At high power (e.g. 50 kW peak), losses ≈ 4 kW → η ≈ 0.92·50/54 = 0.85
- At low power (10 kW idle), losses dominate → η ≈ 0.92·10/12.6 = 0.73
- At redline windage adds ~1.5 kW → η drops 1-2%

## Predicted η across operating envelope

| RPM   | P=10 kW | P=30 kW | P=50 kW |
|------:|--------:|--------:|--------:|
|  4000 | 0.729   | 0.846   | 0.874   |
|  6000 | 0.720   | 0.842   | 0.872   |
|  8000 | 0.708   | 0.837   | 0.868   |
| 10000 | 0.694   | 0.830   | 0.864   |
| 12000 | 0.676   | 0.821   | 0.858   |
| 13500 | 0.662   | 0.814   | 0.854   |

In the **realistic operating envelope** (where the engine actually
makes 30–50 kW at 7–13 kRPM), η ∈ [0.83, 0.87] — a **±2% spread** around
the Cameron-handbook default of 0.85.

## Results vs real team dyno

| Engine | Band                | Constant η = 0.85 | η(P, ω) map | Δ RMSE |
|--------|---------------------|------------------:|------------:|------:|
| SDM26  | All RPMs            | RMSE 5.57         | RMSE 5.65   | +0.08 (worse) |
| SDM26  | 7–11.5 k (WOT band) | RMSE 3.59         | RMSE 3.73   | +0.14 (worse) |
| SDM26  | 10.5–13 k           | RMSE 5.88         | RMSE 6.08   | +0.20 (worse) |
| SDM25  | All RPMs            | RMSE 8.84         | RMSE 8.74   | −0.10 (better) |
| SDM25  | 7–11.5 k (WOT band) | RMSE 5.71         | RMSE 5.42   | −0.29 (better) |
| SDM25  | 10.5–13 k           | RMSE 10.78        | RMSE 10.61  | −0.17 (better) |

## Why the asymmetry between engines

Both engines see the SAME η(P,ω) map. The asymmetry is in WHERE each
engine operates:

- **SDM26** peaks at 46 kW @ 9.5 kRPM. At that operating point the
  literature map gives η ≈ 0.86, which is **higher** than the constant
  0.85. So sim_wheel goes UP and sim already matches dyno well, so it
  now over-predicts slightly.
- **SDM25** peaks at 51 kW @ 10.5 kRPM. At that operating point the
  map gives η ≈ 0.86, also higher than 0.85. So sim_wheel goes UP
  and sim was UNDER-predicting dyno, so the gap shrinks slightly.

Both engines respond IDENTICALLY to the same η change. The "asymmetric
benefit" is purely because their current biases are different — SDM26
was matched, SDM25 was under. A real physics fix moves them by the
same kW at the same operating point.

## Implied η spread analyzed

The plot's implied-η swings (0.5 to 1.2 across the RPM range) are
**NOT drivetrain variability**:

| Component                          | Magnitude of η swing |
|------------------------------------|-----------:|
| Real drivetrain η(P, ω) variation  | ±2%       |
| Sim under-prediction (MUSCL @ high RPM) | up to +35% on η (e.g. 0.85 → 1.18) |
| Dyno part-throttle / tune artifacts | up to -50% (e.g. 0.85 → 0.45 at idle) |

The drivetrain map captures ~1/15 of the implied-η spread. The rest is
simulator and dyno noise. Tuning drivetrain η to absorb that would be
**pure overfit**.

## Decision: KEEP constant η = 0.85

The literature map is **more physical** than a constant value, but the
practical effect is below dyno measurement noise (±5% per Dynojet
typical). Maintaining a single global parameter is simpler and the
spread isn't worth the complexity.

If a future use case needs the map (e.g., a study where the engine
operates at very low load for extended periods), the map function in
`analyze_eta_map.py` is reproducible and can be enabled at the
analysis layer without changing the simulator.

**Production drivetrain_efficiency value: 0.85 (unchanged).**

## Followup

- The implied-η high-RPM swing > 1.0 is *the* signature of the MUSCL
  exhaust wave damping issue. Fixing T4.1 (WENO) would close most of
  it; drivetrain η would then be a clean diagnostic, not noise.

- If the team has measured idle-only or coast-down drivetrain data
  (the bike's loss-power-versus-RPM curve), that could pin down
  `base_drag` and `windage` precisely and tighten the η map's
  defensibility. Currently they're literature midpoints.
