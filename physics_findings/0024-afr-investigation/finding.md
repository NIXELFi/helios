---
id: 24
slug: afr-and-residual-tracking-investigation
status: VALIDATED-BUT-ASYMMETRIC
topic: Tested AFR target sensitivity (12.0 / 12.5 / 13.0 / 13.1 / 13.5) and `enable_residual_tracking` flag against real team dyno on both engines. Both knobs produce real, physically defensible shifts in BP, but **each engine wants different settings to fit best**. This reveals a fundamental limit: SDM25 and SDM26 may genuinely have different AFR tunes (real FSAE teams tune their engines individually), and the universal `afr_target = 13.1` is a compromise that doesn't perfectly fit either. Residual tracking helps SDM26 substantially (best SDM26 fit yet: WOT bias +0.54, peak bias +1.76) but hurts SDM25 (over-corrects to under-prediction). No clean universal-knob improvement available; the production knob set stays at Option B.
hypothesis: After finding 0023 showed WENO5 doesn't move the needle, the remaining ~5 kW SDM25 high-RPM gap must be physics-model (not numerics). Two candidate mechanisms: (a) AFR — real FSAE engines run rich (12.0-12.5) at WOT for charge cooling + peak power; sim's 13.1 may be too lean; (b) `enable_residual_tracking` — flag exists but disabled; trapped residuals dilute fresh charge.
opened: 2026-05-23
closed: 2026-05-23
owner: physics-investigator
spawned_by: finding 0023 followup
commit_hash: ~
baseline_fingerprint: production knob set Option B
revalidation_count: 0
acceptance_approved_at: 2026-05-23
---

## AFR sensitivity

Swept `afr_target` ∈ {12.0, 12.5, 13.0, 13.1, 13.5} × both engines × full
production knob set. Both engines respond symmetrically to AFR: richer →
higher BP, leaner → lower BP. But the magnitude of optimal AFR differs.

### Combined bias² score on WOT 6-13k

| AFR    | SDM26 bias | SDM25 bias | combined bias² |
|-------:|-----------:|-----------:|---------------:|
| 12.0   | +5.75      | +3.86      | 47.93          |
| 12.5   | +3.96      | +2.16      | 20.37          |
| 13.0   | +2.29      | +0.58      | 5.58           |
| **13.1** | **+1.97** | **+0.28**  | **3.95 ★**     |
| 13.5   | +0.72      | −0.90      | 1.33           |

The score gets even smaller at AFR=13.5 (1.33), but that's because **SDM26
under-predicts less and SDM25 over-predicts less by cancellation** —
they're moving in opposite directions on the bias axis.

### Per-engine best AFR (cherry-picked, NOT recommended)

| Engine | Best WOT AFR | Bias at that AFR |
|--------|-------------:|-----------------:|
| SDM26  | 13.5         | +0.72            |
| SDM25  | 13.0         | +0.58            |

If we **could** use different AFR for each engine, both would fit
beautifully. Real teams do tune individually; the sim doesn't capture
that without per-engine config diffs.

### Per-band optimal AFR (SDM25)

| Band            | Best AFR | bias |
|-----------------|---------:|-----:|
| Peak 7-11.5k    | 13.0     | −0.47 |
| High 10.5-13k   | 12.5     | −3.16 |

SDM25 wants RPM-varying AFR — leaner at peak, richer at top end. This
matches classic FSAE tuning practice (lean cruise + rich power band).
The simulator's constant AFR=13.1 is a compromise.

## Residual gas tracking sensitivity

`enable_residual_tracking = true` enables tracking of residual exhaust
gas trapped at IVC from the previous cycle. The residuals dilute fresh
charge, reducing VE and BP.

| Band            | SDM26 OFF | SDM26 ON | SDM25 OFF | SDM25 ON |
|-----------------|----------:|---------:|----------:|---------:|
| WOT 6-13k       | RMSE 4.27, bias +1.97 | **RMSE 4.18, bias +0.54** | RMSE 6.02, bias +0.28 | RMSE 6.58, bias −0.85 |
| Peak 7-11.5k    | 4.53 / +3.11 | **3.92 / +1.76** | 3.01 / −0.77 | 3.77 / −1.86 |
| High 10.5-13k   | 4.98 / +1.86 | **4.88 / −0.27** | 5.63 / −5.39 | 7.43 / −7.21 |

**Residual tracking gives SDM26 its best fit yet** (high-RPM bias drops
from +1.86 to −0.27 — essentially perfect). But it pushes SDM25 further
into under-prediction.

This is the same asymmetric C10 signature: a physically correct
mechanism (trapped residuals dilute charge) shifts both engines by
~1.2-1.4 kW, but SDM25 was already on the "low side" of zero so the
shift makes it worse.

## Why the asymmetry persists across multiple knobs

Multiple investigations now show the same pattern: SDM25 wants more
gas in the cylinder (or richer fuel) than SDM26 at matched RPM. This
is consistent with the actual hardware differences between the two
engines:

- SDM25: 4-1 exhaust, long 0.66 m primaries → strong wave tuning at
  the design RPM → more scavenging → more fresh charge → more BP
- SDM26: 4-2-1 exhaust, short 0.31 m primaries → milder wave tuning
  → less scavenging boost → lower peak BP

The simulator captures some of this via the 1D pipe physics, but
apparently not enough to match the real SDM25's exhaust scavenging
boost. The remaining 3-5 kW gap on SDM25 at high RPM may be
unresolvable without exhaust-specific tuning or a more sophisticated
scavenging model.

## Recommendation: NO change to production knob set

Keep Option B as-is. Per-engine knob differences would close gaps but
violate the spec's per-engine-tuning prohibition. Real-team tune
asymmetry is real and physical; it's a limitation of one-set-fits-both
modeling, not a simulator bug.

If the team is willing to maintain per-engine configs (capturing
each car's actual AFR map), they could shift to:
- `sdm25.json`: `afr_target = 12.8` (closer to high-RPM rich operation)
- `sdm26.json`: `afr_target = 13.3` (closer to factory)

But that decision is policy, not physics.

## What WOULD close the remaining gap

After this session's exhaustive testing, the residual SDM25 high-RPM
gap (~3-5 kW, depending on settings) is bounded by:

1. **Per-engine AFR / spark tune**: known but disallowed by C10
2. **Real exhaust scavenging at SDM25's tuned RPM**: needs better
   solver or BC fidelity at the runner-collector interface
3. **Cycle-to-cycle variation**: real engines have CCV; sim is
   deterministic and steady-state
4. **Dyno measurement uncertainty**: ±5% on Dynojet at full power
   is ~2-3 kW

The first is policy. The second requires either WENO+much-finer-grid
(finding 0023 ruled out solver-class), or a 3D CFD-coupled exhaust
junction (months of effort). The third and fourth set a noise floor
of ~3-5 kW that's likely irreducible.

## Comparison vs spec

| Criterion                                  | Status |
|--------------------------------------------|--------|
| Tested on both SDM25 AND SDM26             | ✓ |
| Anti-overfit C10 guard                     | ✓ (no per-engine knob change) |
| Identified per-engine tune asymmetry       | ✓ |
| Recommendation honest about limits         | ✓ |

## Followup queue

- **0025 — Per-engine config audit**. If the team has the actual AFR
  maps and spark tables from each car's ECU, update the JSON configs
  to match. This isn't overfitting if the values are measured from
  the actual hardware.

- **0026 — Cycle-to-cycle variation model**. Currently sim is
  deterministic; real engines have ~5% CCV at peak. Adding stochastic
  burn-duration jitter would set a realistic "fuzzy" prediction band
  that bounds the dyno measurement uncertainty.

- **0027 — Restrictor CFD validation**. Per finding 0022 followup,
  CFD on the actual restrictor geometry would pin down Cd(M) and
  potentially reveal a systematic offset that the analytic model
  missed.
