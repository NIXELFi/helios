# Ferguson & Kirkpatrick — Internal Combustion Engines: Applied Thermosciences (Ch. 5)

## Citation

- **Ferguson, Colin R., and Kirkpatrick, Allan T.** *Internal Combustion
  Engines: Applied Thermosciences*, 3rd ed., 2016. Wiley.
  ISBN 9781118533314.
  - Chapter 5 — "Fuel-Air Cycles" + Chapter 7 — "Heat Transfer in Engines"
    (this document covers Ch 5 + parts of Ch 7 + Ch 8 multi-zone).
- This book is the *go-to* reference for *multi-zone* combustion modeling.
  Heywood Ch 9 covers two-zone; Ferguson & Kirkpatrick Ch 5 extends to N-zone
  with equilibrium chemistry coupling.

## Scope

This book is the engine-sim solver's principal source for:
- Multi-zone (≥3) combustion thermodynamics
- Equilibrium chemistry coupling within zones (CO, CO₂, H₂O, NO, OH species)
- NASA-7 polynomial integration patterns
- Fuel-air cycle vs ideal-gas-cycle comparison

## Equations

### Eq. 1 — Multi-zone first law (extended from two-zone)

(Ferguson & Kirkpatrick eq. 5.21.)

For N zones at common pressure P, no inter-zone heat transfer, ideal-gas mixture:

```
Σ_i m_i · du_i + p · dV_i = δQ_i - δW_i
```

Where i = 1..N indexes zones. Total energy:

```
Σ_i m_i · u_i(T_i, χ_i) = U_cyl  (conservation)
Σ_i V_i = V_cyl                  (volume closure)
P_i = P  ∀i                      (pressure equilibrium)
```

For each zone, ideal-gas: `m_i · R_i · T_i / V_i = P` → V_i = m_i · R_i · T_i / P.

### Eq. 2 — Three-zone combustion model

(Ferguson & Kirkpatrick §5.4, Tab 5.3.)

A common 3-zone model splits the cylinder into:

1. **Unburned zone** (u): unreacted air-fuel mixture, T_u rises adiabatically
   with compression + flame-front-driven displacement.
2. **Flame zone** (f): the thin reacting region; for engine-cycle modeling
   often lumped into either u or b (i.e., model is effectively two-zone with
   instant chemistry at the flame). When tracked separately, f has very
   short residence time (~0.1 ms).
3. **Burned zone** (b): post-flame products at near-equilibrium chemistry.

The 2-zone vs 3-zone distinction matters for *NOx* prediction (Zeldovich
mechanism is sensitive to peak T in the flame zone, which is hotter than the
post-flame equilibrium T). For *power* prediction, 2-zone is sufficient
(Ferguson & Kirkpatrick §5.4.3).

### Eq. 3 — Equilibrium chemistry within burned zone

(Ferguson & Kirkpatrick §5.5; based on Olikara-Borman / Reynolds equilibrium
solver.)

The burned zone is assumed at chemical equilibrium for 11 species:

```
{N2, O2, H2O, CO2, CO, H2, OH, NO, O, H, N}
```

Equilibrium constants K_p(T) computed from NASA-7 polynomial Gibbs energies.
Species mole fractions solve a coupled 11-equation system (mass balance on
C/H/O/N + 7 independent equilibrium relations).

Engine-sim does NOT currently implement multi-species equilibrium (this is
Phase 3 work). Current behavior: composition is fixed at user-specified χ_b,
χ_u with two-zone γ from NASA-7 fits at T_b, T_u but no dissociation-aware
energy release.

### Eq. 4 — Fuel-air vs ideal-gas cycle efficiency

(Ferguson & Kirkpatrick eq. 5.40.)

```
η_fuel_air = η_otto · (1 - f_dissociation_loss(P_peak, T_peak))
```

The dissociation correction `f_dissociation_loss` drops fuel-air-cycle
efficiency below ideal Otto by 2-5% at typical SI engine conditions, because
CO ⇌ CO₂ and similar equilibria absorb energy at the peak-temperature
moment that's only partially recovered during expansion. This is the
"dissociation loss" engine-sim does not currently model.

For CBR600 conditions (T_peak ~3300 K, P_peak ~90 bar), Ferguson & Kirkpatrick
Tab 5.4 indicates ~2-3% fuel-air-cycle efficiency drop from dissociation. The
two_zone_results.md note that adding dissociation chemistry "is a ~weeks-long
add" maps directly to this.

### Eq. 5 — NASA-7 polynomial form for u, h, s (each species)

(Ferguson & Kirkpatrick Appendix C; standard NASA-7 form.)

```
Cp(T) / R = a1 + a2·T + a3·T² + a4·T³ + a5·T⁴
h(T) / (R·T) = a1 + a2·T/2 + a3·T²/3 + a4·T³/4 + a5·T⁴/5 + a6/T
s(T) / R = a1·ln(T) + a2·T + a3·T²/2 + a4·T³/3 + a5·T⁴/4 + a7
```

Two-temperature-range fits: low (200-1000 K) and high (1000-6000 K) with
coefficient sets `(a1..a7)_low` and `(a1..a7)_high`. Standard Burcat database
or NASA Glenn TRDB pinned coefficients.

See `burcat-nasa7-coefficients.md` for the coefficient table.

### Eq. 6 — γ from NASA-7

```
γ(T, χ) = Cp_mix(T, χ) / Cv_mix(T, χ) = Cp_mix(T, χ) / (Cp_mix(T, χ) - R_mix(χ))
```

Where Cp_mix is the mass-weighted (or mole-weighted) sum over species and
R_mix is the mixture-specific gas constant. The simulator's NASA-7 plumb-through
is in `crates/engine-sim/src/thermo.rs` (verify).

## Constants / coefficients

| Constant         | Value           | Source                       |
|------------------|-----------------|------------------------------|
| η_fuel_air drop  | 2-5 % vs η_otto | Ferguson & Kirkpatrick Tab 5.4 |
| Species count    | 11 (typical)    | Ferguson & Kirkpatrick §5.5  |
| Equilibrium const | from Burcat table | see `burcat-nasa7-coefficients.md` |
| γ_burned (3200K) | 1.22-1.27       | NASA-7 derived               |
| γ_unburned (1100K)| 1.32-1.37      | NASA-7 derived               |

## Expected ranges (what the solver should produce)

For the SDM26 baseline at CBR600 race-calibration:

- **Two-zone γ split** (Helios already implements): γ_b ≈ 1.25 ± 0.02 at T_b
  ≈ 2700-3300 K; γ_u ≈ 1.35 ± 0.02 at T_u ≈ 1000-1200 K. Consistent with
  two_zone_results.md.
- **Indicated efficiency vs ideal Otto:** Helios should be ~92-95% of η_otto
  at race-calibration WOT (the ~5% loss is η_combustion · dissociation · etc.).
- **NO emission rate** (if Zeldovich added): Phase 3 work, not currently
  implemented.

When (and if) Phase 3 multi-zone + equilibrium chemistry lands:

- **Power gain from dissociation reversal during expansion:** 1-3% per
  two_zone_results.md's estimate, which sources Ferguson & Kirkpatrick
  Ch 5 as the underlying basis.

## Known disagreements

- **2-zone vs 3-zone for SI power prediction:** Heywood Ch 9 and Ferguson &
  Kirkpatrick §5.4 both say 2-zone is sufficient for power (within ~1%);
  3-zone is needed only for NOx prediction. Phase 3 won't extend to 3-zone
  unless an NOx finding requires it.
- **Equilibrium species set:** 11 is "standard" but minimal. Adding NH₃ +
  CN + HCN extends NOx accuracy by ~5% for rich operation. CBR600 stoich
  operation makes this irrelevant.
- **NASA-7 coefficient sources:** Burcat database has multiple revisions
  (1984, 1991, 2005). Helios should pin a specific version. Differences are
  < 0.5% in γ at engine T's; pin to Burcat 2005 (latest pre-NASA-9 update).
- **Olikara-Borman vs Reynolds equilibrium:** Two solver algorithms, give
  identical results to numerical noise; choice is implementation taste.
  Ferguson & Kirkpatrick uses Olikara-Borman.

## Solver implementation notes

- Helios's two-zone (current) uses NASA-7 γ at zone T's but fixed χ — no
  dissociation. Adding dissociation requires a per-step equilibrium solve
  (Phase 3).
- The NASA-7 coefficients live in `crates/engine-sim/src/thermo.rs` (verify
  exact location).
- Equilibrium solver is NOT implemented; the closest existing code is the
  γ-vs-T lookup table.

## Cross-references

- Heywood Ch 9 (combustion): `heywood-combustion-ch9.md`.
- Burcat NASA-7 coefficients: `burcat-nasa7-coefficients.md`.
- Phase 1 investigation queue #3: variable γ + dissociation chemistry (this is
  where multi-zone + equilibrium will be evaluated as a Phase 3 candidate).
- two_zone_results.md: documents what the existing 2-zone model achieves and
  what dissociation chemistry would add.
