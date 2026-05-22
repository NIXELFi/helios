# Chen & Flynn 1965 — Development of a Single-Cylinder Compression Ignition Research Engine

## Citation

- **Chen, S. K., and Flynn, P. F.** "Development of a Single-Cylinder
  Compression Ignition Research Engine." *SAE Transactions*, vol. 74 (1965),
  paper 650733. DOI: 10.4271/650733.
- Often cited shorthand: "Chen-Flynn 1965" or "Chen-Flynn FMEP correlation".
- Modernized / extended in Patton, Nitschke & Heywood, SAE 890836 (1989); for
  high-RPM SI applications, see Sandoval & Heywood (SAE 2003-01-0725).

## Scope

This paper introduced the empirical FMEP-vs-(P_max, S_p̄) polynomial that
became the de-facto industry standard for parametric friction modeling. Most
1D engine simulation codes (Ricardo WAVE, GT-POWER, Helios engine-sim) ship
a Chen-Flynn-form FMEP correlation by default.

## Equations (from the paper, 1965 numbering reconstructed)

### Eq. 1 — Mean piston speed

```
S_p̄ = 2 · L_stroke · N
```

Where L_stroke is stroke length (m) and N is revs/s. For Chen-Flynn's test
engine, S_p̄ ranged 4-12 m/s; for CBR600-class at 13000 RPM with 42.5 mm
stroke, S_p̄ = 2 · 0.0425 · (13000/60) ≈ 18.4 m/s — *extrapolation beyond
Chen-Flynn's calibration range.*

### Eq. 2 — Friction MEP correlation

(Chen & Flynn 1965 eq. 4 in the original; commonly restated as Heywood eq. 13.26.)

```
FMEP [kPa] = A + B · P_max [kPa] + C · S_p̄ [m/s] + D · S_p̄² [m²/s²]
```

In bar units (multiply through by 0.01):

```
FMEP [bar] = a + b · P_max [bar] + c · S_p̄ [m/s] + d · S_p̄² [m²/s²]
```

The original Chen-Flynn coefficients (paper §IV — diesel test engine):

| Coefficient | Value (kPa, m/s) | Value (bar, m/s)  |
|-------------|------------------|-------------------|
| A           | 30 kPa           | 0.30 bar          |
| B           | 0.005            | 0.005 (dimensionless) |
| C           | 4.4 kPa·s/m      | 0.044 bar·s/m     |
| D           | 0.34 kPa·s²/m²   | 0.0034 bar·s²/m²  |

Note these are *diesel* coefficients. For SI engines, Patton-Nitschke (SAE
890836) recommends recalibration:

| Coefficient | SI value (bar)  |
|-------------|-----------------|
| a           | 0.4-0.6         |
| b           | 0.010-0.015     |
| c           | 0.0-0.05 (often dropped) |
| d           | 0.002-0.005     |

### Eq. 3 — Component decomposition (Patton-Nitschke extension)

Chen-Flynn's polynomial is the *total* FMEP. Patton-Nitschke decomposed it:

```
FMEP_total = FMEP_crankshaft + FMEP_piston + FMEP_valvetrain + FMEP_accessories
```

Each component has its own Chen-Flynn-style polynomial with its own coefficients
fit to test data. Engine-sim currently uses the total-FMEP form (no
decomposition); Phase 1 finding #11 will investigate the value of decomposition
for tuning sensitivity.

## Constants / coefficients

### Chen-Flynn 1965 original (diesel, calibrated 1500-3000 RPM)

| Coef. | Diesel value (bar) |
|-------|--------------------|
| a     | 0.30               |
| b     | 0.005              |
| c     | 0.044 (linear S_p̄) |
| d     | 0.0034             |

### Heywood Tab 13.6 (modern SI, calibrated 1000-7000 RPM)

| Coef. | SI value (bar) | Notes              |
|-------|----------------|--------------------|
| a     | 0.5            | "modern" naturally aspirated 4-valve |
| b     | 0.012-0.015    | peak-pressure-driven, mild     |
| c     | 0 (dropped)    | typical practice               |
| d     | 0.003          | squared piston-speed dominant  |

### Helios PARITY_FLAGS.toml defaults

| Coef. | Helios value (bar) | Status            |
|-------|--------------------|-------------------|
| fmep_a| 0.5                | matches Heywood SI |
| fmep_b| 0.1                | **10× larger** than Heywood — see "Known disagreements" |
| fmep_c| 0.003              | matches Heywood SI |

## Expected ranges (what the solver should produce)

At CBR600-class operating points (S_p̄ ≈ 22-26 m/s, P_max ≈ 85-95 bar):

Using Heywood SI coefficients (a=0.5, b=0.013, c=0, d=0.003):

```
FMEP @ S_p̄=22, P_max=85 = 0.5 + 0.013 · 85 + 0.003 · 484
                        = 0.5 + 1.105 + 1.452
                        = 3.06 bar
```

```
FMEP @ S_p̄=26, P_max=95 = 0.5 + 0.013 · 95 + 0.003 · 676
                        = 0.5 + 1.235 + 2.028
                        = 3.76 bar
```

For CBR600 race calibration with measured BMEP ≈ 8.5-10.5 bar and IMEP ≈
10-12 bar, FMEP ≈ 1.5-3.0 bar is consistent — i.e., η_m ≈ 0.75-0.85.

If `fmep_b = 0.1` is in use *literally* (not as a unit-misnamed 0.01):

```
FMEP @ S_p̄=22, P_max=85 = 0.5 + 0.1 · 85 + 0.003 · 484 = 10.95 bar
```

That's larger than measured IMEP, which is physically nonsense. So either:
(a) the Helios code multiplies `fmep_b` by 0.01 internally (units mismatch
between config and formula), or (b) `P_max` is fed in some other unit (MPa
making the formula consistent: `0.1 · 8.5 + ... = 0.85 bar`), or (c) the
implementation is buggy. **This must be resolved before any retune (finding
#11).**

## Known disagreements

- **`fmep_b = 0.1` in PARITY_FLAGS.toml vs Heywood 0.012-0.015** — Suspected
  unit-system mismatch; see physics_synthesis.md and Heywood Ch 13 file.
  Finding #11 will resolve.
- **Linear S_p̄ term:** Chen-Flynn 1965 includes it (coefficient C); modern
  practice (Heywood Ch 13) drops it. Both give acceptable fits; difference
  is < 5 % FMEP at typical operating points.
- **High-RPM extrapolation:** Chen-Flynn was calibrated 1500-3000 RPM (S_p̄ ≈
  4-12 m/s). CBR600 operates at S_p̄ ≈ 22-26 m/s — *3-4× outside Chen-Flynn's
  calibration range.* Sandoval-Heywood 2003 extends to S_p̄ = 18 m/s (still
  below CBR600). Beyond ~20 m/s the FMEP-vs-S_p̄² fit is *extrapolated, not
  validated.* This is a known limitation; finding #11 should flag.
- **Diesel vs SI:** Original Chen-Flynn coefficients are for a diesel. SI
  engines have less peak-pressure-driven friction (b is smaller). Don't
  copy the 1965 paper's coefficients verbatim for SI.

## Solver implementation notes

- Verify in `crates/engine-sim/src/cylinder/friction.rs` or similar — the
  coefficient names in the SDM26 config may be `fmep_a`/`fmep_b`/`fmep_c`/
  `fmep_d` (with optional linear term), or some subset. The PARITY_FLAGS.toml
  lists `fmep_a`/`fmep_b`/`fmep_c` — implying the linear S_p̄ term is dropped
  and `fmep_c` is the *squared* coefficient. Verify this is the case.
- The race-calibration retune does NOT touch FMEP coefficients (per
  physics_synthesis.md). So the current FMEP value is whatever Helios
  produces at the PARITY_FLAGS defaults; finding #11 will validate.

## Cross-references

- Heywood Ch 13 restatement: `heywood-friction-ch13.md` eq. 4.
- Phase 1 open investigation: orchestrator queue #11 (friction decomposition).
- Related: Patton, Nitschke & Heywood (SAE 890836); Sandoval & Heywood (SAE
  2003-01-0725).
