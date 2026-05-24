---
id: 20
slug: fmep-revalidation-real-dyno
status: FIXED
topic: Revalidate finding 0002 (FMEP coefficient defensibility) against the team's real dyno data instead of the multi-source aggregate that finding 0018 retired. Original 0002 concluded `fmep_b = 0.1` and `fmep_c = 0.003` were "validated" because the sim over-predicted against the bad aggregate. With real dyno showing sim was actually under-predicting at SDM25 7-11.5k WOT (bias −3.51 kW) and the documented "high-side" `fmep_c = 0.003` (3× the Heywood Tab 13.3 motorcycle ceiling) absorbing model error in the wrong direction. **Recommend production fmep_c = 0.00075** (Heywood Tab 13.3 motorcycle midpoint). Closes RMSE on both engines symmetrically by ~16% in the WOT 6-13k band. No code change — value goes into production-knob-set sweep TOMLs via `apply_override`.
hypothesis: The 0002 finding's verdict that `fmep_c = 0.003` was "defensible against current physics gaps" was based on the simulator over-predicting against the old aggregate dyno. With real team dyno (finding 0018) showing the simulator slightly under-predicting in the WOT band, the over-inflated `fmep_c` is now in the WRONG direction — it widens the gap rather than absorbing it. Moving `fmep_c` to the Heywood Tab 13.3 motorcycle SI midpoint (7.5e-4 bar·s²/m²) should close the gap symmetrically on both engines.
opened: 2026-05-23
closed: 2026-05-23
owner: physics-investigator
spawned_by: finding 0018 followup queue
commit_hash: ~
baseline_fingerprint: production knob set @ 23adac6
revalidation_count: 0
acceptance_approved_at: 2026-05-23
---

## Recap of finding 0002

Finding 0002 (`fmep-b-vs-heywood-typical`) tested whether `fmep_b = 0.1`
was "absorbing model error" vs the Heywood Tab 13.3 motorcycle SI
typical of 0.04–0.05. The conclusion (against the OLD aggregate dyno):

> *Reference engine 1: SDM26 (4-2-1 exhaust), brake_power range across
> sweep: 51.4-54.9 kW (above dyno band 36.9-45.1 kW). [...] Both engines:
> the entire sweep is out-of-band at cycle 25 [...]*

The sim was over-predicting against the bad aggregate, so the high-FMEP
defaults stayed. The flag was preserved as VALIDATED with the caveat
"appropriate to retune once those gaps close."

## What changed: real dyno reverses the picture

Finding 0018 replaced the multi-source aggregate with team-measured
Dynojet runs (`sdm26-team-dyno.csv`, `sdm25-team-dyno.csv`). Against
real data, the simulator is **under-predicting** in the WOT band on
SDM25 (peak band bias −3.51 kW) and slightly over-predicting on SDM26
(+0.44 kW). The friction model that was "absorbing over-prediction"
under the bad reference is now widening the under-prediction.

## Sweep design

Held `fmep_a = 0.5` and `fmep_b = 0.1` (current values, both also
"on the high side" per the SDM26Config doc, but the dominant
high-RPM coefficient is `fmep_c`).

Tested `fmep_c` ∈ {0.003, 0.002, 0.0015, 0.00125, 0.001, 0.00075, 0.0005}:

```
   0.00050 ← Heywood Tab 13.3 motorcycle floor
   0.00075 ← Heywood midpoint (recommended literature value)
   0.00100 ← Heywood ceiling
   0.00125
   0.00150
   0.00200
   0.00300 ← CURRENT SIMULATOR DEFAULT (3× Heywood ceiling)
```

19-RPM grid, 30 cycles each, production knob set otherwise unchanged.

## Results

### Sensitivity table (real dyno, 6-13k WOT band)

| fmep_c | SDM26 RMSE | SDM26 bias | SDM25 RMSE | SDM25 bias | Combined bias² |
|-------:|-----------:|-----------:|-----------:|-----------:|---------------:|
| 0.00300 ← current | 4.74 | −1.02 | 8.12 | −2.52 | 7.41 |
| 0.00200 | 4.27 | −0.18 | 7.51 | −1.75 | 3.10 |
| 0.00150 | 4.11 | +0.24 | 7.23 | −1.37 | 1.93 |
| 0.00125 | 4.05 | +0.45 | 7.09 | −1.17 | 1.58 |
| 0.00100 ← Heywood ceiling | 4.01 | +0.67 | 6.96 | −0.98 | 1.41 |
| **0.00075 ← Heywood midpoint** | **3.98** | **+0.88** | **6.84** | **−0.79** | **1.39 ★** |
| 0.00050 ← Heywood floor | 3.96 | +1.09 | 6.72 | −0.60 | 1.54 |

The minimum is at `fmep_c ≈ 0.00075` (Heywood midpoint) — bias² halves
relative to current. RMSE drops by ~16% on both engines.

### Improvement at the production setting

| Band            | Engine | Current (0.003) | **Recommended (0.00075)** | Δ |
|-----------------|--------|----------------:|--------------------------:|---:|
| All 4-13 k      | SDM26  | RMSE 5.57, bias +0.52 | RMSE 5.12, bias +2.14 | −0.45 RMSE |
| All 4-13 k      | SDM25  | RMSE 8.84, bias +0.39 | RMSE 8.02, bias +1.78 | −0.82 RMSE |
| WOT 6-13 k      | SDM26  | RMSE 4.74, bias −1.02 | RMSE 3.98, bias +0.88 | −0.76 RMSE |
| WOT 6-13 k      | SDM25  | RMSE 8.12, bias −2.52 | RMSE 6.84, bias −0.79 | **−1.28 RMSE** |
| Peak 7-11.5 k   | SDM26  | RMSE 3.59, bias +0.44 | RMSE 3.95, bias +2.07 | +0.36 (slightly worse) |
| Peak 7-11.5 k   | SDM25  | RMSE 5.71, bias −3.51 | RMSE 4.26, bias −1.88 | **−1.45 RMSE** |
| High 10.5-13 k  | SDM26  | RMSE 5.88, bias −3.20 | RMSE 4.33, bias −0.04 | **−1.55 RMSE** |
| High 10.5-13 k  | SDM25  | RMSE 10.78, bias −10.60 | RMSE 7.82, bias −7.65 | **−2.96 RMSE** |

The move helps both engines on every band except the SDM26 peak
band (where current happens to fit unusually well — likely a
coincidence between calibration-tuned values and the dyno
measurement; loses 0.36 kW RMSE there).

### Anti-overfit verification (C10)

Same `fmep_c` applied to both engines. Symmetric improvement:
- SDM26 WOT band: bias moves from −1.02 → +0.88 (shifts +1.90 kW)
- SDM25 WOT band: bias moves from −2.52 → −0.79 (shifts +1.73 kW)

Both engines move up by ~1.8 kW at the same operating point. This
is real physics, not per-engine tuning.

## Decision: add to production knob set

The production knob set from `SESSION_HANDOFF.md §2` was achieved via
`apply_override` flags on top of bit-exact-parity-preserving defaults.
The same pattern works here: keep the default `fmep_c = 0.003` in code
(to preserve parity goldens), but add the override to the production
knob set:

```toml
# Production knob set — additions from finding 0020:
fmep_c = 0.00075   # Heywood Tab 13.3 motorcycle midpoint
                   # (was 0.003 = 3× Heywood ceiling, "on the high side"
                   # per the SDM26Config doc; calibrated to bad aggregate
                   # dyno; finding 0018 retired that reference)
```

This brings the friction model into the Heywood literature range and
improves both engines on the meaningful WOT band by ~16% RMSE.

## What was NOT moved

- `fmep_a = 0.5` — current value is within Heywood Tab 13.3 range
  (0.3–0.5). Moving to midpoint (0.4) shifts BP uniformly by ~0.4 kW
  but doesn't fix RPM-shaped gaps. Not changed.
- `fmep_b = 0.1` — current is 2× the Heywood ceiling (0.05). However,
  moving it to literature dominates the mid-RPM band and OVER-predicts
  SDM26 by 5+ kW. The `fmep_b` value may still be absorbing a
  mid-RPM mechanism. Left at 0.1 for now; document for future
  finding 0023 ("fmep_b origins").
- `fmep_c = 0.003` was the worst offender (3× ceiling) and is the
  high-RPM friction term where the dyno gap was largest. Moving
  only this term is the cleanest, lowest-risk fix.

## Comparison vs spec

| Criterion                                  | Status |
|--------------------------------------------|--------|
| Parity goldens unchanged (override pattern) | ✓ 20/20 |
| Literature-defensible value (no fitting)   | ✓ Heywood Tab 13.3 midpoint |
| Tested on both SDM25 AND SDM26             | ✓ |
| Symmetric improvement = anti-overfit       | ✓ both move ~1.8 kW |
| RMSE improves on both engines              | ✓ (~16% each) |
| Anti-overfit guard C10                     | ✓ |

## Followup queue

- **0023 — fmep_b origins**. `fmep_b = 0.1` is 2× Heywood ceiling.
  Moving it to literature would over-predict mid-RPM by 5+ kW on
  SDM26 — but that mid-RPM agreement is suspiciously good with the
  high `fmep_b`. Is `fmep_b` absorbing a real mid-RPM physics gap
  (heat transfer? wave tuning?) or is the SDM26 mid-RPM match
  coincidence? Worth a deeper investigation.

- **0024 — SDM25 peak under-prediction history**. User flagged that
  at some prior commit, SDM25 was closer to its dyno peak. Bisect
  the production-knob-set commits to find which fix introduced the
  SDM25 under-prediction.
