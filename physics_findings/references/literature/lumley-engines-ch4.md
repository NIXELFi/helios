# Lumley — Engines: An Introduction (Ch. 4: Turbulence and Combustion)

## Citation

- **Lumley, John L.** *Engines: An Introduction*. Cambridge University Press,
  1999. ISBN 9780521644891.
  - Chapter 4 — "Turbulence" (pp. 57-78); Chapter 5 — "Combustion in
    Reciprocating Engines" (pp. 79-110). This document cites both, with
    Ch 4 as primary.

## Scope

This book is the engine-sim solver's principal source for:
- Turbulence-intensity scaling at end-of-compression
- Tumble + swirl ratio definitions and their effect on burn rate
- Turbulent flame-speed correlation (vs laminar) and burn-rate enhancement
- Damköhler / Karlovitz dimensionless groups in engine context

Lumley is shorter and more physical/intuitive than Heywood; where they differ
on a quantitative claim, Lumley is preferred for *modeling intuition* but
Heywood is preferred for *citable numerical values*.

## Equations

### Eq. 1 — Turbulence intensity scaling

(Lumley §4.2, eq. 4.5.)

For SI engine flow at end of compression (TDC, just before spark):

```
u' = α · S_p̄
```

Where `u'` is the RMS turbulent velocity fluctuation at TDC, S_p̄ is mean
piston speed, and α is an empirical constant. Lumley gives α ≈ 0.5-1.0 for
typical pent-roof chambers (depending on tumble ratio); pancake / open
chambers give α ≈ 0.3-0.5.

For CBR600-class (S_p̄ ≈ 22-26 m/s at peak power) with high tumble:
u' ≈ 0.7 · 24 = ~17 m/s at TDC.

### Eq. 2 — Tumble ratio (definition)

(Lumley §4.4.)

```
T_R = ω_tumble / ω_crank
```

Where `ω_tumble` is the average angular velocity of the bulk in-cylinder flow
around an axis perpendicular to the cylinder axis (tumble), and `ω_crank` is
crankshaft angular velocity. Typical SI engine values:

| Chamber type      | T_R         |
|-------------------|-------------|
| Pent-roof bike    | 1.5-3.5     |
| 4-valve auto      | 1.0-2.0     |
| Open chamber      | 0.3-0.8     |
| Swirl-port diesel | 0 (swirl, not tumble) |

CBR600's reverse-pent-roof high-tumble head gives T_R ≈ 2.5-3.5.

### Eq. 3 — Tumble decay + turbulence amplification at TDC

(Lumley §4.4-4.5.)

Bulk tumble persists through most of compression; near TDC it breaks down into
small-scale turbulence (tumble vortex deforms as the chamber height collapses,
producing high-`k` turbulence energy). The peak `u'` near TDC roughly scales
with T_R:

```
u'_TDC ≈ β · (S_p̄ + γ · T_R · S_p̄)    [Lumley eq. 4.12 approx]
```

With β ≈ 0.5, γ ≈ 0.3. For T_R = 3, S_p̄ = 24: u' ≈ 0.5·(24 + 0.3·3·24) ≈ 23 m/s.

The two-term form distinguishes "piston-driven" (β·S_p̄, always present) from
"tumble-bust" (γ·T_R·S_p̄, only with high tumble).

### Eq. 4 — Turbulent flame speed enhancement

(Lumley §5.3, restated from Damköhler / Bray theory.)

```
S_T / S_L = 1 + C · (u' / S_L)^n
```

Where:
- `S_T` is turbulent flame speed
- `S_L` is laminar flame speed (gasoline-air at TDC conditions ≈ 0.5-0.8 m/s)
- `u'` is turbulent intensity (from eq. 3)
- `C` ≈ 1 (Lumley) to 2.5 (Bray, depending on regime)
- `n` ≈ 0.5-1.0 (depending on Damköhler regime)

For CBR600 conditions: u'/S_L ≈ 23/0.6 ≈ 38; with C=1.5, n=0.7:
S_T/S_L ≈ 1 + 1.5 · 38^0.7 ≈ 1 + 1.5 · 12.2 ≈ 19.

That's a 19× enhancement of flame speed by turbulence — consistent with the
20-30× speedup needed to fit a typical SI burn duration into 20-30 deg of
crank angle.

### Eq. 5 — Damköhler number

(Lumley §5.4.)

```
Da = τ_turb / τ_chem = (ℓ / u') / (δ_L / S_L)
```

Where `ℓ` is integral turbulence length scale, `δ_L` is laminar flame
thickness. For SI engines at TDC:

- ℓ ≈ 1-3 mm (typically the geometric scale of the chamber)
- u' ≈ 5-20 m/s
- δ_L ≈ 0.1 mm
- S_L ≈ 0.5 m/s

```
Da ≈ (0.002 / 10) / (0.0001 / 0.5) = 0.0002 / 0.0002 = 1
```

Da ≈ 1 places SI engine combustion in the *thin reaction zone* regime (broken
flamelets), where eq. 4 has C = 1-2, n ≈ 0.7. Confirms the Damköhler regime
the empirical fits assume.

### Eq. 6 — Karlovitz number

(Lumley §5.4.)

```
Ka = (η_K / δ_L)^(-2) · (u' / S_L)^2 · Re_t^(-1)
```

With Ka ≈ 10-100 in SI engines (broken-reaction-zone regime, consistent with
Da ≈ 1). For lean-burn HCCI engines Ka can exceed 1000 (distributed
combustion); for stoichiometric SI it stays in the 10-100 band.

## Constants / coefficients

| Constant   | Value       | Source              | Notes                       |
|------------|-------------|---------------------|-----------------------------|
| α (u'/S_p̄)| 0.5-1.0     | Lumley eq. 4.5      | depends on chamber          |
| β          | 0.5         | Lumley eq. 4.12     | piston-driven u'            |
| γ          | 0.3         | Lumley eq. 4.12     | tumble-bust u'              |
| C (S_T)    | 1.0-2.5     | Lumley eq. 5.3 / Bray | flame-speed enhancement    |
| n (S_T)    | 0.5-1.0     | Lumley eq. 5.3      | depends on Da regime        |
| T_R (CBR600)| 2.5-3.5    | Lumley §4.4 / SAE   | high-tumble bike head       |
| S_L (gasoline, φ=1, TDC) | 0.5-0.8 m/s | Heywood Tab 9.2 |                       |

## Expected ranges (what the solver should produce)

The Helios solver does NOT explicitly track turbulence — it uses a Wiebe form
with a `tumble_burn_factor` that mocks the eq. 4 speedup phenomenologically.

When `tumble_burn_factor = 0.0` (parity), Wiebe duration is the user-set
value (typically 50 deg). With tumble factor > 0, duration shortens:

```
Δθ_effective ≈ Δθ_user / (1 + tumble_burn_factor · T_R)
```

For T_R = 3 and tumble_burn_factor = 0.3: Δθ goes from 50 to ~36 deg.
Modern fast-burn pent-roof bike chambers: 18-28 deg measured (Heywood Tab 9.4
and Lumley Ch 5). So `tumble_burn_factor ≈ 0.5-0.6` is the literature-
defensible range for CBR600-class.

Phase 1 finding #4 (turbulent burn-rate correlation) will validate this
phenomenological factor against measured CBR600 burn-duration data (or
GT-POWER published reference cases).

## Known disagreements

- **u'/S_p̄ ratio at TDC:** Lumley gives 0.5-1.0; Heywood (Ch 8) gives a similar
  range but with `α ≈ 0.5` as a "rule of thumb". The difference is roughly the
  spread between chamber types.
- **Tumble-driven u' (γ coefficient):** Lumley's eq. 4.12 form is a fit to
  one engine; Reuss et al. (SAE 950101) measure the relationship and find
  γ ≈ 0.2-0.5 depending on chamber geometry. Use the geometric mean (0.3)
  for generic SI; CBR600-specific measurements would refine.
- **S_T/S_L scaling exponent `n`:** Damköhler theory + experimental fits span
  0.5-1.0. Engine codes that explicitly model turbulence (KIVA, OpenFOAM
  combustion) pick a single value per code; the choice has factor-of-2 effect
  on burn rate at high turbulence. Helios's Wiebe-based phenomenology
  sidesteps this; the trade-off is loss of predictive turbulence-dependence.
- **Da regime classification:** SI engines straddle Da ≈ 1 (thin reaction
  zones) and Da ≈ 10 (corrugated flamelets). Some papers (Peters, Borghi)
  argue SI is in the corrugated regime; Lumley argues thin reaction zone.
  Phase 3 turbulent-burn investigation would need to pick a sub-model.

## Solver implementation notes

- `crates/engine-sim/src/cylinder/wiebe.rs` is the Wiebe-form combustion;
  `tumble_burn_factor` directly multiplies Wiebe's `a` (efficiency) param.
- T_R is a config knob; no internal tumble evolution model.
- u' is NOT tracked explicitly. To add: see Phase 3 multi-investigation
  track "Quasi-3D port-flow corrections (swirl/tumble generation)".
- Phase 1 finding #4 is the open investigation to ground tumble_burn_factor
  in literature ranges.

## Cross-references

- Heywood Ch 9 (combustion): `heywood-combustion-ch9.md`.
- Phase 1 investigations: #4 (tumble burn rate), Phase 3 (quasi-3D corrections).
