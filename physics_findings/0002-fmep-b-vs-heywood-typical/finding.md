---
id: 2
slug: fmep-b-vs-heywood-typical
status: INVESTIGATING
topic: Is Chen-Flynn FMEP linear coefficient fmep_b=0.1 defensible vs the CBR600 dyno, or is it absorbing other model error?
hypothesis: fmep_b=0.1 is roughly 2x the Heywood Tab 13.3 motorcycle-SI typical (0.04–0.05 bar·s/m), and is empirically calibrated to compensate for under-predicted peak pressure (likely the missing variable-γ chemistry). A sweep over [0.04, 0.10] against the CBR600 dyno at 10000 RPM should reveal what fmep_b the model "wants" given current physics.
opened: 2026-05-22
closed: ~
owner: physics-researcher
spawned_by: manual
commit_hash: ~
baseline_fingerprint: ~
revalidation_count: 0
acceptance_approved_at: ~
---

## Hypothesis

The Chen-Flynn FMEP model in `crates/engine-sim/src/model/sdm26.rs` is
implemented in the *peak-pressure-free* reduced form (Heywood Tab 13.3):

```text
fmep_bar = fmep_a + fmep_b · sp + fmep_c · sp²
```

with `sp = 2·stroke·N/60` (mean piston speed, m/s). Defaults are
`(fmep_a, fmep_b, fmep_c) = (0.5, 0.1, 0.003)` per `sdm26.rs:224-226`.

Heywood Tab 13.3 motorcycle-SI typical: `fmep_b ≈ 0.04-0.05 bar·s/m`. The
in-source comment at lines 145-148 already flags this disparity ("0.1 …
on the high side"). The hypothesis: `fmep_b = 0.1` is empirically calibrated
to compensate for other model gaps (most likely the absence of variable-γ
combustion chemistry, which under-predicts peak pressure → IMEP comes out
too low → without elevated FMEP the model would under-predict BMEP at
10000 RPM by ~10-15 %).

Falsification criteria:

- If `fmep_b ≈ 0.04-0.05` (Heywood typical) lands the model **inside** the
  CBR600 dyno band (38-43 kW at 10000 RPM), then `fmep_b = 0.1` is *not*
  defensible — it's compensating for nothing and should be retuned.
- If only `fmep_b ≈ 0.08-0.10` lands inside the band, then `fmep_b = 0.1` is
  empirically defensible against this calibration target *given the current
  physics gaps* — VALIDATED with the caveat that retuning becomes
  appropriate once those gaps close (e.g., after finding 0003 lands
  variable-γ).

## Study design

Full reproducible inputs in `study.toml` (SDM26) + `study_sdm25.toml` (SDM25
C10 cross-check). Summary:

- **Config baseline:** `crates/engine-sim/python_ref/configs/sdm26.json`
  (primary), `sdm25.json` (C10 second-engine validation).
- **RPM list:** [10000.0] — single operating point at the FSAE-restricted
  dyno's well-instrumented mid-band.
- **Cycles per RPM:** 25 — enough for IMEP / FMEP to converge to within the
  noise floor (typical convergence is reached by cycle 15-20 per existing
  parity goldens at 5+ cycles).
- **Parameter sweep:** `fmep_b ∈ [0.04, 0.10]`, n_trials = 5, LHS sampler
  (stratified jitter, deterministic with seed). Covers the discrete points
  (0.04, 0.05, 0.06, 0.075, 0.10) called out in the orchestrator brief.
- **Validation metric:** `brake_power_kW` at 10000 RPM, target 41 kW
  (CBR600 FSAE-restricted dyno lower bound), ±10 % band.

## Literature

Key references in `physics_findings/references/literature/`:

- `heywood-friction-ch13.md` — Heywood Ch 13, Tab 13.3 (peak-pressure-free
  reduced Chen-Flynn coefficients): `a=0.5, b=0.04-0.05, c=0.003` for
  modern SI.
- `chen-flynn-1965.md` — original 1965 paper (diesel coefficients; SI
  recalibration per Patton-Nitschke SAE 890836). Note: both literature
  files were corrected as part of this finding — earlier versions
  described the wrong implementation form (`b · P_max`); the actual form
  is `b · S_p̄`.

Dyno target:

- `physics_findings/references/dyno/cbr600rr-fsae-restricted.csv`
  row rpm=10000 → `brake_power_kW = 41.0` (lower bound of 41-52 kW
  published FSAE band; multi-source aggregate).

## Results

_(filled by researcher after sweep — see `results_sdm26.ndjson`,
`results_sdm25.ndjson`)_

### SDM26 (primary)

| fmep_b (nominal) | fmep_b (jittered) | fmep_bar (bar) | brake_power_kW | imep_bar | nonconservation |
|------------------|-------------------|----------------|----------------|----------|-----------------|
| 0.04             |                   |                |                |          |                 |
| 0.052            |                   |                |                |          |                 |
| 0.064            |                   |                |                |          |                 |
| 0.076            |                   |                |                |          |                 |
| 0.088            |                   |                |                |          |                 |
| 0.100 (default)  |                   |                |                |          |                 |

### SDM25 (C10 cross-check)

| fmep_b (nominal) | fmep_b (jittered) | fmep_bar (bar) | brake_power_kW | imep_bar | nonconservation |
|------------------|-------------------|----------------|----------------|----------|-----------------|

## Comparison vs literature

| Metric         | Target (cite)                                  | Tolerance | Measured | Pass? |
|----------------|------------------------------------------------|-----------|----------|-------|
| brake_power_kW | 41.0 (CBR600 dyno 10000 RPM lower bound)       | ±10 %     |          |       |

## Conclusion

_(VALIDATED / NEEDS-FIX / LITERATURE-AMBIGUOUS / etc. — filled after sweep.)_

## Skeptic review

### Pre-run (acceptance band)

- Reviewer: physics-skeptic (orchestrator role)
- Verdict: ACK
- Round: 0/3
- Notes:
  ±10 % band on a 41 kW target gives 36.9-45.1 kW, which spans the lower half
  of the published 41-52 kW FSAE dyno range. This is intentional: at 10000 RPM
  we are below the peak power point (12000-13500 RPM per the CSV), so the
  lower-bound 41 kW is the right target for an engine that's well-tuned but
  not yet at its torque/power peak. The orchestrator brief's 38-43 kW envelope
  fits inside this band. Comparison class is brake (not indicated, not wheel) —
  this matches the dyno CSV's `brake_power_kW` column, which captures BMEP via
  a dyno cell measurement (no drivetrain efficiency multiplied in).

  Conservation requirement: `nonconservation` ≤ 1e-10 per spec C9. At 25 cycles
  the engine is well past initial transient and the f64 closure error should
  be ~1e-17 (per finding 0001's measurement on the same SDM26 / 10000 RPM
  configuration).

  Citation chain: Heywood Tab 13.3 → linear-S_p̄ coefficient bound (0.04-0.05);
  CBR600 FSAE dyno → brake_power_kW target. No mixed comparison classes.
  Literature corpus was corrected as part of this finding (earlier text
  described `b · P_max` form; verified actual form is `b · S_p̄` at
  sdm26.rs:884).

### Post-run (conclusion)

- Reviewer: physics-skeptic (orchestrator role)
- Verdict: _TBD_
- Round: 0/3
- Notes:
  _TBD_

## Reproducibility

```powershell
git checkout <commit_hash>
helios-bench sweep physics_findings/0002-fmep-b-vs-heywood-typical/study.toml `
    --out /tmp/r_sdm26.ndjson
helios-bench sweep physics_findings/0002-fmep-b-vs-heywood-typical/study_sdm25.toml `
    --out /tmp/r_sdm25.ndjson
helios-bench compare /tmp/r_sdm26.ndjson `
    physics_findings/0002-fmep-b-vs-heywood-typical/results_sdm26.ndjson
helios-bench compare /tmp/r_sdm25.ndjson `
    physics_findings/0002-fmep-b-vs-heywood-typical/results_sdm25.ndjson
```

Expected: zero metric deltas above noise floor (1e-12 relative) on the same
`(target_triple, rustc_version, libm_source)` tuple.

## Second-engine validation (C10)

This finding is a coefficient sensitivity study (not a wiring bug), so
C10 cross-engine validation is required. The SDM25 sweep
(`study_sdm25.toml`, `results_sdm25.ndjson`) re-runs the same fmep_b
sweep on the SDM25 calibration of the same CBR600 engine (4-1 exhaust,
3 L plenum). Both calibrations target the same dyno; if SDM26 and SDM25
disagree on which `fmep_b` matches dyno → flag.

## Revalidations

_(grows on STALE re-open)_
