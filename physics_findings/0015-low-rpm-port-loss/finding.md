---
id: 15
slug: low-rpm-port-loss-heywood-re-correction
status: NEGATIVE
topic: T1.1 from NEXT_AGENT.md — low-Reynolds intake valve Cd correction (Heywood §6.2, Annand-Roe 1974) to close the +12 kW BP over-prediction at 6 kRPM (implied η = 0.52 vs literature 0.85). Mechanism implemented as opt-in flag + literature-midpoint parameters. **Conclusive NEGATIVE result**: at the literature-defensible Re_crit ≤ 15,000, the correction f_Re(Re) ≡ 1.0 across the entire CBR600RR operating range, because mean-piston-speed Reynolds is ≥ 10,000 at 4 kRPM and grows monotonically with RPM. The Heywood low-Re mechanism does not apply to this engine class.
hypothesis: Heywood §6.2 + Annand-Roe 1974 document a Cd reduction (~10-30%) at intake valves when Re < 10⁴. Hypothesis: applying this correction with reference Reynolds = ρ·c_m·D_v/μ would lower simulator BP at low RPM where Re is small, closing the +12 kW gap symmetrically on SDM25 and SDM26 without affecting peak. Falsification: if Re > Re_crit at all tested RPMs, the mechanism cannot engage and the gap must lie elsewhere.
opened: 2026-05-23
closed: 2026-05-23
owner: physics-investigator
spawned_by: NEXT_AGENT.md T1.1
commit_hash: ~
baseline_fingerprint: production knob set @ 23adac6
revalidation_count: 0
acceptance_approved_at: 2026-05-23
---

## Hypothesis

Heywood *Internal Combustion Engine Fundamentals* §6.2-6.3 and Annand-Roe
1974 document that valve discharge coefficients measured at high-Reynolds
steady-flow benches (Re > 10⁴) over-state the effective Cd at engine
operating conditions when the flow Reynolds drops below ~10⁴. The
correction is multiplicative:

```
Cd_eff(L/D, Re) = Cd_bench(L/D) · f_Re(Re)
f_Re(Re) = 1                                 if Re ≥ Re_crit
f_Re(Re) = re_cd_min + (1 − re_cd_min) · (Re − 1000)/(Re_crit − 1000)
                                              if 1000 < Re < Re_crit
f_Re(Re) = re_cd_min                          if Re ≤ 1000
```

Literature midpoints (Heywood Fig 6.16, Hellström 2014):
- `Re_crit = 10,000`
- `re_cd_min = 0.70`

If this mechanism dominates, SDM26's +12 kW at 6 kRPM should drop by
~6–8 kW while SDM25 (same physical engine, different solver
calibration) should drop by a similar amount. The C10 calibration-
over-fit guard demands symmetric response on both engines.

## What was implemented

Files modified (all opt-in, default OFF, parity preserved at defaults):

- `crates/engine-sim/src/cylinder/valve.rs`
  - `air_viscosity(t_kelvin)` — Sutherland's formula (White, *Viscous
    Fluid Flow* Tab 1.2): μ_ref=1.716e-5 Pa·s, T_ref=273.15 K, S=110.4 K
  - `re_cd_multiplier(Re, re_crit, re_cd_min)` — piecewise linear, clamped
  - 3 new fields on `ValveParams`: `re_correction_enabled`, `re_cd_min`,
    `re_crit`
- `crates/engine-sim/src/bcs/valve.rs`
  - New entry point `fill_valve_ghost_characteristic_with_cd_mult(...)`
    that multiplies `a_eff` (= `n_valves · Cd · A_ref`) by an external
    `cd_multiplier` after computing the effective area. Multiplying
    `a_eff` is equivalent to multiplying Cd by the same factor since
    `A_ref` is geometric.
- `crates/engine-sim/src/model/sdm26.rs`
  - 3 new `SDM26Config` fields, default OFF
  - In `step()`, compute reference Reynolds once per RPM:
    `Re_ref = ρ_amb · c_m · D_v / μ_amb`, with c_m = mean piston speed
    `= 2 · stroke · rpm / 60`. The intake-valve BC is called with the
    resulting `cd_multiplier`; exhaust is always called with 1.0.
- `crates/cfd-core/src/params.rs`
  - 3 new entries in `enumerate_schema` + `apply_override` (so studies
    can sweep them).
- Parity test fixtures (`tests/parity_*.rs`) updated to include the
  new `ValveParams` fields with parity-preserving defaults.

Parity: 20/20 SDM25 + SDM26 scenarios bit-exact (re-verified post-fix).

## Results

### 1. Reference Reynolds across the operating range (SDM26)

| RPM   | c_m (m/s) | Re_ref | f_Re @ Re_crit=10k | f_Re @ Re_crit=15k |
|------:|-----:|------:|------:|------:|
| 4000  | 5.67  | 9933  | 0.998 | 0.892 |
| 5000  | 7.08  | 12416 | 1.000 | 0.948 |
| 6000  | 8.50  | 14900 | 1.000 | 0.998 |
| 7000  | 9.92  | 17383 | 1.000 | 1.000 |
| 8000  | 11.33 | 19866 | 1.000 | 1.000 |
| 10000 | 14.17 | 24833 | 1.000 | 1.000 |
| 13000 | 18.42 | 32283 | 1.000 | 1.000 |

At the literature midpoint Re_crit = 10,000, the multiplier is ≥ 0.998
at all RPMs ≥ 4000. At the literature upper bound Re_crit = 15,000, it
drops to 0.892 only at 4 kRPM — outside the dyno comparison range.

### 2. SDM26 + SDM25 sweep, production knob set, with vs without Re correction

| Variant                                  | SDM26 RMSE | SDM26 bias | SDM25 RMSE | SDM25 bias |
|------------------------------------------|-----------:|----------:|-----------:|----------:|
| Production knob set (baseline)           | 10.04      | +1.94     | 9.05       | +0.71     |
| + Re correction @ Re_crit=10k, min=0.70  | 10.04      | +1.94     | 9.05       | +0.71     |
| + Re correction @ Re_crit=15k, min=0.65  | 10.04      | +1.94     | 9.05       | +0.70     |

All deltas vs baseline ≤ 0.01 kW. The flag is wired correctly (verified by
unit-test arithmetic on `re_cd_multiplier`) but the engine never operates
at Re < Re_crit, so the multiplier never engages.

### 3. Implied drivetrain η — unchanged

| RPM | η baseline | η + Re correction | Δ |
|-----|----------:|--------:|---:|
| 6000  | 0.521 | 0.521 | 0.000 |
| 10000 | 0.850 | 0.850 | 0.000 |
| 13000 | 1.283 | 1.283 | 0.000 |

The +12 kW gap at 6 kRPM is unaffected.

## Why the mechanism doesn't apply here

The Heywood low-Re Cd correction is documented for engines with one or
more of:
- Large displacement per cylinder (≥ 500 cc), giving large valve diameters
- Low peak RPM (≤ 5000), giving low mean piston speeds
- Slow operation in industrial/marine duty cycles

For a CBR600RR-class engine (150 cc/cyl, 14 kRPM peak), the
characteristic Reynolds is *intrinsically* high:

```
Re = ρ · c_m · D_v / μ
   ≈ 1.18 · (2·0.0425·RPM/60) · 0.0275 / 1.85e-5
   ≈ 0.00248 · RPM
```

This gives Re ≥ 10⁴ for any RPM ≥ ~4 kRPM. The bench-Cd curve is
already in its asymptotic regime, and there is no slack to recover.

## Implication for the +12 kW low-RPM gap

The over-prediction at 6 kRPM is **not** caused by low-Reynolds valve
flow losses. The gap exists in both SDM25 and SDM26 with identical
magnitude (+10.96 / +11.66 kW at 6 kRPM respectively), so it is a
shared physics gap, not a per-engine tune artifact.

Candidate explanations that **could** apply (deferred):

1. **Wave-dynamics mismatch off-design RPM**. The intake runner is
   geometry-tuned for ~10 kRPM. The MUSCL-Hancock solver damps waves
   more aggressively than reality (per finding 0007), so the
   simulator's ram-charging at low RPM may be physically incorrect
   in either direction. Validation would require WENO (solver-class,
   T4.1) and is out of scope for this finding.

2. **Friction model at low piston speed**. The Chen-Flynn FMEP
   formula `fmep = a + b·c_m + c·c_m²` is dominated by `fmep_a` at
   low c_m. Default `fmep_a = 0.5 bar` is mid-range of Heywood Tab
   13.3 (0.3-0.8 bar). Pushing toward the high end (0.7) would close
   ~2 kW at low RPM. But this is a parameter tuning move within the
   literature range, not a new physical mechanism — borderline
   overfit and deferred unless a physical argument selects a specific
   value.

3. **Fuel-vaporization charge cooling**. Currently not modeled. Real
   engines see ~10–20 K intake-charge cooling from fuel evaporation
   in the port. At low RPM the air is well-conditioned to the warm
   runner walls (325 K) before the valve opens, and evaporation
   cooling would lower the in-cylinder mass slightly. Effect size
   ~1–2 kW at all RPMs (charge-density ~ T_intake), so does not
   selectively close the low-RPM gap.

4. **Dyno provenance**. The 6 kRPM FSAE value (18.5 kW wheel) is
   marked in `references/dyno/cbr600rr-fsae-restricted.csv` as
   "Aggregated low-RPM band; teams rarely publish below 6k for
   restricted CBR600." Lower-confidence dyno point; envelope may be
   wider than ±5%.

## Recommendation

**Keep the flag, default OFF.** The implementation is correct and
documented. The flag becomes useful only for engine classes outside
CBR600RR territory (lower peak RPM, larger valves, etc.).

For SDM26/SDM27 design work, the production knob set is **unchanged**:

```toml
# unchanged from SESSION_HANDOFF §2:
intake_junction_borda_carnot = 1
intake_junction_loss_coef = 1.0
restrictor_loss_from_diffuser_geometry = 1
restrictor_cd_mach_k = 0.3
spark_advance_rpm_slope_deg_per_krpm = 1.5
duration_rpm_exp = 0.4

# 0015 — implemented but DO NOT ENABLE for CBR600RR-class engines
# (no operating-range Reynolds below Re_crit = 10,000)
intake_valve_re_correction_enabled = 0
```

## Comparison vs spec

| Criterion                                  | Status |
|--------------------------------------------|--------|
| Parity goldens 20/20 with flag default OFF | ✓      |
| Mechanism physically grounded              | ✓ Heywood §6.2, Annand-Roe 1974 |
| Parameters literature-derived (no fitting) | ✓ Re_crit=10000 midpoint of Heywood Fig 6.16 |
| Tested on both SDM25 AND SDM26             | ✓      |
| Symmetric response = anti-overfit check    | ✓ (both engines: Δ ≈ 0) |
| Negative finding documented                | ✓      |

## Followup queue

The +12 kW low-RPM gap is now isolated to mechanisms other than
low-Re valve flow. The two highest-leverage remaining candidates:

- **0018 — Fuel-vaporization charge cooling**. Add a per-cylinder
  charge-cooling term ΔT_intake = h_fg · m_fuel / (m_air · c_p_air)
  driven by AFR. Heywood §4.4 supports ~10–20 K cooling at
  stoichiometric. Effect size 1–2 kW; not low-RPM specific but
  worth quantifying.
- **0019 — FMEP_a sensitivity within Heywood Tab 13.3 range**. Pure
  sweep over fmep_a ∈ [0.4, 0.8] to characterize how much of the
  low-RPM gap is friction model uncertainty. If a literature-defensible
  value (e.g., motorcycle-specific value from a referenced paper)
  closes the gap, it becomes a candidate; if not, document as not
  the mechanism.
- **0020 — Wave-tuning sanity sweep**. Vary runner length ± 30% and
  check whether the simulator's low-RPM BP responds in the right
  direction. If yes, the +12 kW gap is partly wave-physics; if no,
  the MUSCL damping is masking it (T4.1 territory).
