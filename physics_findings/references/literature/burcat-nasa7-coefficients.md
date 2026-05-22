# Burcat Database — NASA-7 Polynomial Coefficients

## Citation

- **Burcat, Alexander, and Ruscic, Branko.** "Third Millennium Ideal Gas and
  Condensed Phase Thermochemical Database for Combustion (with Update from
  Active Thermochemical Tables)." Argonne National Lab / Technion technical
  report ANL-05/20 and TAE 960. Last updated 2005 (with periodic ATcT
  revisions through 2014).
  - Web: https://burcat.technion.ac.il/
  - Pinned version recommended: Burcat 2005-09 (or the most recent ATcT
    revision used by Cantera 2.6 / OpenSMOKE — both pin a Burcat snapshot).
- The NASA-7 polynomial form itself: McBride, B. J., Gordon, S., and Reno,
  M. A. "Coefficients for Calculating Thermodynamic and Transport Properties
  of Individual Species." NASA Technical Memorandum 4513 (1993).

## Scope

This document records the NASA-7 polynomial form, the species set engine-sim
uses (and what the multi-zone extension will need), and a pinned coefficient
table for the most-relevant 11 species. The exact coefficient values are
omitted here (they are long; pin the Burcat-2005-09 download and reference its
SHA in this document when committed). What this document records is *which*
coefficients to use and the temperature ranges they cover.

## The NASA-7 polynomial form

Each species has two coefficient sets, one for a low-T range and one for a
high-T range, joined at a transition temperature T_mid (commonly 1000 K).

### Specific heat capacity at constant pressure

```
Cp(T) / R = a1 + a2·T + a3·T² + a4·T³ + a5·T⁴
```

### Specific enthalpy

```
h(T) / (R·T) = a1 + a2·T/2 + a3·T²/3 + a4·T³/4 + a5·T⁴/5 + a6/T
```

### Specific entropy

```
s(T) / R = a1·ln(T) + a2·T + a3·T²/2 + a4·T³/3 + a5·T⁴/4 + a7
```

Coefficient set `(a1, a2, a3, a4, a5, a6, a7)` per (species, T-range).

### γ and Cv (derived)

```
Cv(T) = Cp(T) - R
γ(T) = Cp(T) / Cv(T)
```

For ideal gas only. At engine pressures (≤ 100 bar) the ideal-gas approximation
holds to better than 1% for combustion products (Heywood Ch 4 supports this;
Ferguson & Kirkpatrick Ch 5 quantifies the deviation).

## Species set for engine combustion modeling

### Currently used by engine-sim (assumed minimal)

For two-zone with fixed composition, engine-sim needs Cp(T) for:

- **N₂** — diluent, dominant by mass
- **O₂** — oxidizer
- **CO₂** — product
- **H₂O** — product
- **Fuel surrogate** — usually iso-octane (C₈H₁₈) or n-heptane (C₇H₁₆); for
  gasoline the standard surrogate is PRF (primary reference fuel) or TPRF
  (toluene PRF). CBR600 race fuel ≈ 100 RON pump gasoline; iso-octane is the
  conservative surrogate.

### Required for Phase 3 multi-zone + equilibrium

Standard 11-species set per Ferguson & Kirkpatrick Ch 5:

| Species | Mol weight (g/mol) | Notes                           |
|---------|--------------------|---------------------------------|
| N₂      | 28.014             | diluent                         |
| O₂      | 31.998             | oxidizer                        |
| H₂O     | 18.015             | product                         |
| CO₂     | 44.010             | product                         |
| CO      | 28.010             | dissociation product            |
| H₂      | 2.016              | dissociation product            |
| OH      | 17.007             | radical                         |
| NO      | 30.006             | Zeldovich NOx                   |
| O       | 15.999             | radical (rate-limiting in NO)   |
| H       | 1.008              | radical                         |
| N       | 14.007             | Zeldovich intermediate          |

For *full* Zeldovich NOx kinetics, add N₂O and NO₂ (13 species total).

### Fuel species (for the unburned zone)

| Species | Formula | NASA-7 source                     |
|---------|---------|-----------------------------------|
| iso-octane | C₈H₁₈ | Burcat 2005-09 (CHEMKIN format)  |
| n-heptane  | C₇H₁₆ | Burcat 2005-09                   |
| toluene    | C₇H₈  | Burcat 2005-09                   |
| methane    | CH₄   | Burcat 2005-09 (reference fuel)  |

## Temperature ranges

Standard two-piece NASA-7 fit (Burcat default):

- **Low range**: 200-1000 K
- **High range**: 1000-6000 K
- **Transition T_mid**: 1000 K

For engine modeling, T spans roughly 300 K (intake) to 3500 K (peak burned).
Both ranges are needed; the spline at T_mid is C¹-continuous by construction
(Burcat fits enforce continuity).

For T > 6000 K, NASA-7 is *extrapolated*, not validated. The engine-sim
two-zone clamps T_b at 3500 K (per two_zone_results.md), well within range.

## Reference values for sanity-checking

(All values from Burcat 2005-09; reproduce within ±0.1%.)

At T = 298.15 K, P = 1 bar:

| Species | Cp (J/mol·K) | h (kJ/mol)       | s (J/mol·K) |
|---------|--------------|------------------|-------------|
| N₂      | 29.124       | 0.000 (ref)      | 191.610     |
| O₂      | 29.376       | 0.000 (ref)      | 205.147     |
| H₂O (g) | 33.590       | -241.826         | 188.832     |
| CO₂     | 37.135       | -393.522         | 213.795     |
| CO      | 29.142       | -110.527         | 197.660     |

At T = 2500 K (combustion-relevant):

| Species | Cp (J/mol·K)    | γ (= Cp/Cv) |
|---------|-----------------|-------------|
| N₂      | 35.97           | 1.302       |
| O₂      | 37.84           | 1.282       |
| H₂O (g) | 51.92           | 1.190       |
| CO₂     | 60.35           | 1.160       |
| CO      | 36.39           | 1.293       |

A *burned mixture* at T = 2500 K, stoichiometric gasoline-air, has γ ≈ 1.25-1.27
(mass-weighted average dominated by N₂ + H₂O + CO₂).

A *unburned mixture* at T = 1000 K, stoichiometric gasoline-air (still air +
fuel vapor pre-flame), has γ ≈ 1.30-1.32.

## Constants / coefficients

| Quantity              | Value               | Source                |
|-----------------------|---------------------|-----------------------|
| Universal gas const R | 8.31446 J/(mol·K)   | CODATA 2018           |
| R for air             | 287.05 J/(kg·K)     | M_air = 28.965 g/mol  |
| R for stoich. burned  | 290-295 J/(kg·K)    | mixture-averaged      |
| Boltzmann constant    | 1.380649e-23 J/K    | CODATA 2018           |
| Avogadro number       | 6.02214076e23 /mol  | CODATA 2018           |

## Expected ranges (what the solver should produce)

For two-zone Helios at CBR600 race conditions:

- **γ_unburned (T_u ≈ 1100 K)**: 1.30-1.32. Two_zone_results.md reports
  consistent values.
- **γ_burned (T_b ≈ 3000 K)**: 1.22-1.25 (extrapolating NASA-7 above 2500 K
  shows γ continues to drop slightly with T due to vibrational modes
  activating).
- **R_unburned (gasoline-air φ=1)**: ~287 J/kg·K (close to air since fuel
  mass fraction is small).
- **R_burned (stoich products)**: ~290 J/kg·K.

## Known disagreements

- **Burcat-1984 vs Burcat-2005:** Coefficient differences are < 0.5% in γ
  and < 0.2% in h for the 11 standard species. Pin the 2005 version (or
  later ATcT update) for new finding work. Existing engine-sim code likely
  uses an older snapshot; finding #3 will audit.
- **Iso-octane vs gasoline surrogate vs gasoline:** No standard "gasoline"
  NASA-7 exists (gasoline is a mixture); iso-octane (C₈H₁₈) is the standard
  research-octane surrogate. CRC TPRF (toluene-PRF) is closer for sensitivity
  but more complex. CBR600 race fuel is closer to iso-octane than n-heptane.
- **Lower heating value (LHV) consistency:** Iso-octane LHV per Burcat 2005 =
  44.32 MJ/kg. Pump gasoline LHV is typically 42.5-43.5 MJ/kg (lower because
  of aromatics + olefins). Within ~2% of iso-octane; for power prediction
  this is fine, for BSFC prediction it shifts numbers by 2% in the same
  direction.
- **High-T extrapolation:** NASA-7 above 6000 K is extrapolated. Engine-sim
  T_b ≤ 3500 K (clamped) stays well within range.

## Solver implementation notes

- Verify NASA-7 coefficient location in `crates/engine-sim/src/thermo.rs` or
  similar. Pin the source (Burcat date stamp or commit hash of an upstream
  thermo library) in a comment.
- For Phase 3 multi-zone + equilibrium chemistry, the coefficient set will
  need to grow from the current 4-5 species to the full 11. Pin to
  Burcat 2005-09 unless a stronger reason emerges.
- The numerical Gibbs-energy minimization (Olikara-Borman or RAND) requires
  all 11 species coefficients to be loaded at simulator startup. Cost is
  trivial (< 100 floats).

## Cross-references

- Ferguson & Kirkpatrick Ch 5 (multi-zone): `ferguson-kirkpatrick-ch5.md`.
- Two-zone implementation: `heywood-combustion-ch9.md` + `two_zone_results.md`.
- Phase 1 investigation queue #3: variable γ + dissociation chemistry.
