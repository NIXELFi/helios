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

### Helios actual implementation (sdm26.rs:145-148, 884-885)

Engine-sim uses the *peak-pressure-free* reduced form (no `B · P_max` term):

```
fmep_bar = fmep_a + fmep_b · sp + fmep_c · sp²
```

with `sp = 2·stroke·N/60` (mean piston speed, m/s) and defaults:

| Coef.   | Helios value           | Heywood Tab 13.3 typ. | Status        |
|---------|------------------------|-----------------------|---------------|
| fmep_a  | 0.5 bar                | 0.5 bar               | matches       |
| fmep_b  | 0.1 bar·s/m            | 0.04-0.05 bar·s/m     | **~2× high**  |
| fmep_c  | 0.003 bar·s²/m²        | 0.003 bar·s²/m²       | matches       |

This is NOT a units mismatch (verified by finding 0002). `fmep_b · sp` gives
the right magnitude FMEP — but the value of `fmep_b = 0.1` itself is high
relative to Heywood-typical SI, most plausibly because it absorbs other
model gaps (variable-γ chemistry, peak-pressure-driven friction not modeled
explicitly).

## Expected ranges (what the solver should produce)

CBR600 stroke = 42.5 mm. At 10000-13000 RPM:

- S_p̄ = 2·0.0425·(10000/60) = **14.17 m/s @ 10000 RPM**
- S_p̄ = 2·0.0425·(13000/60) = **18.42 m/s @ 13000 RPM**

(Note: earlier versions of this file said S_p̄ ≈ 22-26 m/s — that was
incorrect; off by a factor of ~1.5 because of an arithmetic slip on the
stroke. The corrected values above are what the simulator computes at
`sdm26.rs:884`.)

Using Heywood-typical coefficients (a=0.5, b=0.045, c=0.003):

```
FMEP @ S_p̄=14.17 = 0.5 + 0.045 · 14.17 + 0.003 · 200.8
                  = 0.5 + 0.638 + 0.602
                  = 1.74 bar
```

```
FMEP @ S_p̄=18.42 = 0.5 + 0.045 · 18.42 + 0.003 · 339.3
                  = 0.5 + 0.829 + 1.018
                  = 2.35 bar
```

Using Helios defaults (a=0.5, b=0.1, c=0.003):

```
FMEP @ S_p̄=14.17 = 0.5 + 0.1 · 14.17 + 0.003 · 200.8
                  = 0.5 + 1.417 + 0.602
                  = 2.52 bar
```

```
FMEP @ S_p̄=18.42 = 0.5 + 0.1 · 18.42 + 0.003 · 339.3
                  = 0.5 + 1.842 + 1.018
                  = 3.36 bar
```

The ~0.8-1.0 bar gap between Helios and Heywood-typical is what finding 0002
quantifies against the CBR600 dyno.

## Known disagreements

- **`fmep_b = 0.1` vs Heywood Tab 13.3 0.04-0.05** — Resolved as a real
  (not units) disagreement by finding 0002. The implementation form is
  `fmep_b · S_p̄` with consistent bar / (m/s) units; the value is
  empirically elevated, plausibly to compensate for other model gaps.
- **Reduced vs full Chen-Flynn form:** Original 1965 + Heywood Tab 13.6
  include a `B · P_max` term. Helios uses the *reduced* (peak-pressure-free)
  form with the load-dependent friction absorbed into the linear `S_p̄`
  coefficient. Both fits are within ~5 % at full load per Heywood §13.4.4.
- **High-RPM extrapolation:** Chen-Flynn was calibrated 1500-3000 RPM (S_p̄
  ≈ 4-12 m/s). CBR600 at 10000-13000 RPM operates at S_p̄ ≈ 14-18 m/s — just
  beyond the original calibration band but well within Sandoval-Heywood 2003
  extension (S_p̄ up to 18 m/s).
- **Diesel vs SI:** Original Chen-Flynn coefficients are for a diesel. SI
  engines have less peak-pressure-driven friction. Don't copy the 1965
  paper's coefficients verbatim for SI.

## Solver implementation notes

- Implementation: `crates/engine-sim/src/model/sdm26.rs:145-148` (config
  fields) and `sdm26.rs:884-885` (FMEP computation per cycle).
- Fields exposed in SDM26Config: `fmep_a`, `fmep_b`, `fmep_c`. No
  P_max-dependent term.
- As of finding 0002, `apply_override` supports `fmep_a`, `fmep_b`,
  `fmep_c` for sweep studies.

## Cross-references

- Heywood Ch 13 restatement: `heywood-friction-ch13.md` eq. 4.
- Phase 1 open investigation: orchestrator queue #11 (friction decomposition).
- Related: Patton, Nitschke & Heywood (SAE 890836); Sandoval & Heywood (SAE
  2003-01-0725).
