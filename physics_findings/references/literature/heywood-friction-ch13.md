# Heywood — Friction and Lubrication (Ch. 13)

## Citation

- **Heywood, John B.** *Internal Combustion Engine Fundamentals*, 2nd ed., 2018.
  McGraw-Hill Education. ISBN 9781260116106.
  - Chapter 13 — "Engine Friction and Lubrication" (2nd ed.; 1st ed. Ch. 13,
    pp. 722-779).
- The Chen-Flynn correlation referenced herein is paraphrased separately in
  `chen-flynn-1965.md`.

## Scope

This chapter is the engine-sim solver's principal source for:
- Friction Mean Effective Pressure (FMEP) decomposition
- Chen-Flynn polynomial form and coefficient ranges
- Component-wise friction contributions (piston ring, bearings, valvetrain)
- Mechanical efficiency η_m = BMEP / IMEP and FMEP = IMEP - BMEP

## Equations

### Eq. 1 — Mean effective pressure decomposition

(Heywood eq. 13.1, p. 723 1st ed.)

```
IMEP = BMEP + FMEP
PMEP = pumping mean effective pressure (subtracted from gross IMEP)
TFMEP = FMEP + PMEP (total friction MEP)
```

Where IMEP is *gross* indicated mean effective pressure (combustion stroke
only) and PMEP captures intake/exhaust pumping work. Engine-sim's reported
IMEP excludes PMEP (gross convention); the simulator's `bmep_bar` already has
both FMEP and PMEP subtracted.

### Eq. 2 — Decomposed FMEP

(Heywood eq. 13.21-13.25.)

```
FMEP = FMEP_piston_assembly + FMEP_bearings + FMEP_valvetrain + FMEP_auxiliaries
```

Published splits (Heywood Tab 13.5, motored-engine teardown):

| Component         | Fraction of FMEP | Trend                          |
|-------------------|------------------|--------------------------------|
| Piston assembly   | 0.40-0.55        | ∝ piston speed² (hydrodynamic) |
| Bearings (mains + rod)| 0.20-0.30    | ∝ piston speed (also viscous)  |
| Valvetrain        | 0.10-0.20        | weak RPM dependence            |
| Auxiliaries (oil pump, water pump) | 0.05-0.15 | ∝ ω             |

For SI engines at 1500-5000 RPM these fractions are reasonably stable; at
12000+ RPM the piston-assembly share grows toward 0.60+ (squared-velocity
dominance).

### Eq. 3 — Total friction torque

(Heywood eq. 13.7.)

```
T_friction = T_piston(S_p̄) + T_bearings(N) + T_valvetrain(N) + T_aux(N)
```

Where `S_p̄` is mean piston speed (m/s) and N is engine speed (rad/s or RPM
depending on author).

### Eq. 4 — Chen-Flynn polynomial form

(Heywood eq. 13.26; full derivation in `chen-flynn-1965.md`.)

The full Chen-Flynn form includes a peak-pressure linear term:

```
FMEP [kPa] = A + B · P_max [kPa] + C · S_p̄ [m/s] + D · S_p̄² [m²/s²]
```

However, **Heywood Tab. 13.3 (Friction MEP vs. mean piston speed — typical
correlations for modern SI engines)** gives a *peak-pressure-free* reduction
that fits the same data within ~5 % at full load, where the P_max-linear term
is absorbed into a re-calibrated linear-`S_p̄` term:

```
FMEP [bar] = a + b · S_p̄ [m/s] + c · S_p̄² [m²/s²]
```

This is the form implemented in engine-sim
(`crates/engine-sim/src/model/sdm26.rs` line 145–148 + 884–885):
`fmep_bar = fmep_a + fmep_b · sp + fmep_c · sp²` where `sp = 2·stroke·N/60`.

Coefficient ranges (Heywood Tab 13.3, modern SI engines — peak-pressure-free
reduction):

| Coefficient            | Typical value | Range          | Engine class                    |
|------------------------|---------------|----------------|---------------------------------|
| a [bar]                | 0.5           | 0.4-0.8        | constant offset                 |
| b [bar·s/m]            | 0.04-0.05     | 0.03-0.06      | passenger SI; bearings + valvetrain |
| c [bar·s²/m²]          | 0.003         | 0.002-0.005    | piston-assembly hydrodynamic    |

(High-load Heywood Tab. 13.6 *with* P_max gives a separate fit with smaller
`b` ≈ 0.012–0.015 [dimensionless] applied to `P_max [bar]`, not S_p̄.)

Engine-sim's PARITY_FLAGS.toml lists `fmep_a = 0.5`, `fmep_b = 0.1`,
`fmep_c = 0.003`. The `fmep_b = 0.1` is roughly 2× the Heywood-typical linear
`S_p̄` coefficient. This *is* a real disagreement, not a units error —
finding 0002 confirmed the implementation form is `fmep_b · S_p̄` and the
value is genuinely on the high side. See "Known disagreements" below and
`physics_findings/0002-fmep-b-vs-heywood-typical/` for the empirical sweep.

### Eq. 5 — Mechanical efficiency

(Heywood eq. 13.5.)

```
η_m = BMEP / IMEP = 1 - FMEP / IMEP - PMEP / IMEP
```

For a healthy SI engine at WOT, η_m ≈ 0.80-0.92 at peak-power RPM; declines
to ~0.70 at low load (partial-throttle PMEP dominates).

### Eq. 6 — Peak-pressure-dependent piston ring friction

(Heywood §13.5.4, p. 738-740.)

The piston-ring friction is hydrodynamic at most operating points but
transitions to mixed/boundary lubrication near TDC under high P_max. The
linear-in-P_max term in Chen-Flynn captures this:

```
FMEP_piston_ring,P-driven ≈ k · P_max · (geometric factor)
```

With k ≈ 0.006-0.012 (dimensionless) per Heywood Fig 13.24.

## Constants / coefficients

| Constant         | Value             | Source                                  |
|------------------|-------------------|-----------------------------------------|
| Chen-Flynn a     | 0.5 bar (typ)     | Heywood Tab 13.3, modern SI             |
| Chen-Flynn b     | 0.04-0.05 bar·s/m | Heywood Tab 13.3 (peak-pressure-free)   |
| Chen-Flynn c     | 0.003 bar·s²/m²   | Heywood Tab 13.3                        |
| Piston-assy %    | 0.40-0.55         | Heywood Tab 13.5                        |
| Bearing %        | 0.20-0.30         | Heywood Tab 13.5                        |
| Valvetrain %     | 0.10-0.20         | Heywood Tab 13.5                        |
| η_m peak         | 0.80-0.92         | Heywood §13.4                           |

## Expected ranges (what the solver should produce)

At CBR600-class operating points (10000-13000 RPM, WOT, P_max ≈ 85-95 bar,
S_p̄ ≈ 14.2-18.4 m/s — *note: 42.5 mm stroke gives lower S_p̄ than typical
auto SI*):

- **FMEP**: 1.8-3.0 bar (Heywood Chen-Flynn projection with `a=0.5, b=0.045,
  c=0.003`).
- **PMEP**: 0.2-0.5 bar (low at WOT; rises sharply at partial throttle).
- **η_m**: 0.75-0.85.
- **BMEP**: 8.5-11.0 bar (matches measured at typical FSAE-restricted dynos).

If the simulator currently reports FMEP outside this range, finding 0002 will
investigate. Per physics_synthesis.md §A1, the existing race calibration
gives roughly the right BMEP, suggesting the FMEP value is roughly correct
even if `fmep_b = 0.1` looks ~2× too high — likely absorbing other model
gaps (e.g., missing variable-γ chemistry that under-predicts peak pressure).

## Known disagreements

- **`fmep_b = 0.1` vs Heywood Tab 13.3 0.04-0.05 (~2× larger):** Confirmed
  finding 0002 — NOT a unit-system mismatch; the implementation form is
  `fmep_b · S_p̄` (linear piston speed), and `fmep_b = 0.1 bar·s/m` is
  genuinely on the high side relative to Heywood-typical SI values. Most
  likely empirically calibrated to compensate for under-predicted peak
  pressure (variable-γ chemistry absent → IMEP too low → BMEP would be
  too high without elevated FMEP).
- **Chen-Flynn full vs reduced form:** The implementation uses the
  peak-pressure-free reduction (Heywood Tab 13.3). The full form
  (Heywood Tab 13.6 / Chen-Flynn 1965) includes a `B · P_max` term that
  engine-sim does NOT model directly. This is acceptable provided the
  linear `S_p̄` coefficient is re-tuned to absorb the load-dependent
  friction (which is what `fmep_b = 0.1` may be doing).
- **PMEP at WOT vs partial:** Heywood §13.4 gives 0.2-0.5 bar at WOT; FSAE
  20mm-restricted operation may push PMEP to 0.5-1.0 bar because the
  restrictor's pressure drop counts as pumping work. The simulator includes
  the restrictor as a 1D restriction so this should be captured automatically;
  worth checking via finding #16 (exhaust-pulse / junction acoustics).

## Solver implementation notes

- Engine-sim's FMEP is currently a single `bmep = imep - fmep - pmep` style
  scalar; no per-component decomposition.
- Chen-Flynn coefficients live in SDM26Config (verify exact field names in
  `crates/engine-sim/src/config/loader.rs`).
- The race-calibration retune (per physics_synthesis.md §A1) does NOT change
  Chen-Flynn coefficients; it changes spark advance + Wiebe params + Woschni
  c1. So FMEP is currently un-tuned and lives at the PARITY_FLAGS.toml
  defaults. Phase 1 finding #11 will sweep the Chen-Flynn coefficients
  within Heywood Tab 13.6 ranges and check sensitivity.
