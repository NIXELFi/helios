# Heywood — Heat Transfer (Ch. 12)

## Citation

- **Heywood, John B.** *Internal Combustion Engine Fundamentals*, 2nd ed., 2018.
  McGraw-Hill Education. ISBN 9781260116106.
  - Chapter 12 — "Engine Heat Transfer" (2nd ed.; 1st ed. has the heat-transfer
    treatment in Ch. 12 as well, pp. 668-721).
- Original sources for the correlations cited herein are paraphrased in their
  own files (`woschni-1967.md` for Woschni; Annand referenced below per
  Heywood's restatement).

## Scope

This is engine-sim's principal source for:
- Convective heat-transfer coefficient `h_c` correlations (Annand, Woschni)
- Wall-temperature assumptions
- Per-crank-angle heat-transfer area
- Radiation-vs-convection split in flame zone

## Equations

### Eq. 1 — Annand correlation

(Heywood 2nd ed. eq. 12.39, restated from Annand 1963 "Heat transfer in the
cylinders of reciprocating internal combustion engines", *Proc. IMechE*
177(36):973-996.)

```
Nu = a · Re^0.7
```

With `a` an empirical constant (0.35-0.8 depending on combustion phase), and:

```
Re = ρ · |v_p̄| · B / μ
```

Where `v_p̄` is mean piston speed, `B` is bore, ρ and μ are gas properties.

Converting to `h_c`:

```
h_c = (k_gas / B) · a · Re^0.7 + c · σ · (T^4 - T_w^4) / (T - T_w)
```

The second term is radiative; Annand's `c` ≈ 0 during compression, ≈ 0.6 during
combustion (high temperatures + soot/luminous radiation).

### Eq. 2 — Woschni correlation

(Heywood 2nd ed. eq. 12.42; full derivation in `woschni-1967.md`. Restated here
for cross-reference.)

```
h_c = c · B^(-0.2) · p^0.8 · T^(-0.53) · w^0.8
```

Variables:

| Symbol | Meaning                    | Units    |
|--------|----------------------------|----------|
| h_c    | convective coefficient     | W/m²·K   |
| c      | empirical const (≈ 3.26 / 130 SI) | varies (see below) |
| B      | bore                       | m        |
| p      | cylinder pressure          | kPa (Woschni) or bar |
| T      | gas temperature            | K        |
| w      | characteristic gas velocity| m/s      |

The leading constant `c` depends on the unit system. Two common Woschni-form
expressions found in the literature:

- SI form with p in kPa: `h_c = 3.26 · B^-0.2 · p^0.8 · T^-0.55 · w^0.8`
  (units: h_c in W/m²·K). Note the T-exponent is sometimes given as -0.53.
- SI form with p in bar, T-exp -0.53: `h_c = 130 · B^-0.2 · p^0.8 · T^-0.53 · w^0.8`.

The Helios solver uses `c = 3.26` with p in kPa, T-exp -0.53 (matches Woschni's
original 1967 paper — see `woschni-1967.md`).

Characteristic velocity `w` per Heywood eq. 12.43:

```
w = c1 · S_p̄ + c2 · (V_d · T_r / (p_r · V_r)) · (p - p_motored)
```

Where `S_p̄` is mean piston speed, `V_d` displacement, and the second term is
the combustion-driven velocity boost. Subscript `r` is a reference state.

Coefficients (per Heywood Tab 12.5 and Woschni 1967):

| Phase             | c1     | c2          |
|-------------------|--------|-------------|
| Gas exchange      | 6.18   | 0           |
| Compression       | 2.28   | 0           |
| Combustion + expansion | 2.28 | 3.24e-3 m/(s·K) |

Engine-sim uses `c1 = 2.28` and `c2 = 3.24e-3` per phase. The race-calibration
retune drops `c1_combustion` to 0.7× the baseline (1.6) — known and tracked in
PARITY_FLAGS.toml as `woschni_c1_scale`.

### Eq. 3 — Wall temperature assumption

(Heywood Tab 12.4; widely used SI engine values.)

| Surface         | Steady-state T_w (K) | Range          |
|-----------------|----------------------|----------------|
| Piston crown    | 500-550              | 470-600        |
| Liner (mid)     | 380-430              | 360-450        |
| Head            | 440-490              | 400-520        |
| Valve (intake)  | 530-580              | 500-620        |
| Valve (exhaust) | 850-950              | 800-1000       |

For 1D bulk heat-transfer models, the *area-weighted mean* T_w is typically
420-470 K for an SI engine at steady-state WOT. Engine-sim uses a single
`T_wall` config knob (default 450 K); per-surface decomposition is a
future enhancement (see Phase 3 track #5).

### Eq. 4 — Heat-transfer area per crank angle

(Heywood Fig. 12.18; the simulator's `crates/engine-sim/src/cylinder/geometry.rs`
implements eq. 12.10 directly.)

```
A_HT(θ) = A_head + A_piston + A_liner(θ)
A_liner(θ) = π · B · y_p(θ)
y_p(θ) = (L + R) - R·cos(θ) - sqrt(L² - R²·sin²(θ))
```

Where L is connecting-rod length, R is crank radius, y_p is the distance from
piston crown to head. The simulator computes this exactly; no approximation.

### Eq. 5 — Total heat loss per cycle

(Heywood eq. 12.6, simplified — no zone-split.)

```
Q_loss = ∫₀^{4π} h_c(θ) · A_HT(θ) · (T_gas(θ) - T_wall) · dθ / ω
```

For 4-stroke SI engines at WOT, Heywood Tab 12.2 gives published values:

- Q_loss / Q_in ≈ 0.18-0.30 at low RPM, declining to 0.10-0.18 at high RPM
  (lower because gas residence time per cycle drops faster than h_c rises).

For CBR600-class engines at 13000 RPM, expect Q_loss / Q_in ≈ 0.10-0.15.

### Eq. 6 — Two-zone heat split (when two_zone_enabled = true)

(Implicit; the simulator implements per
`crates/engine-sim/src/cylinder/two_zone.rs`.)

```
dQ_loss/dθ = h_c · A_HT · [ (V_b/V) · (T_b - T_w) + (V_u/V) · (T_u - T_w) ]
```

With V_b/V from the two-zone volume-fraction relation (see
`heywood-combustion-ch9.md` eq. 2). The simulator does not split A_HT by zone
(flame-zone-only area is hard to bound in 1D); it assumes both zones see the
full instantaneous heat-transfer area weighted by their volume fractions.

## Constants / coefficients

| Constant            | Value           | Source                     |
|---------------------|-----------------|----------------------------|
| Woschni c (kPa form)| 3.26            | Heywood eq. 12.42, Woschni 1967 |
| Woschni c1 (gas-ex) | 6.18            | Heywood Tab 12.5           |
| Woschni c1 (compr/comb) | 2.28        | Heywood Tab 12.5           |
| Woschni c2 (combustion) | 3.24e-3 m/(s·K) | Heywood Tab 12.5      |
| Annand a (no comb)  | 0.35-0.5        | Heywood Tab 12.4 (Annand)  |
| Annand a (combustion) | 0.5-0.8       | Annand 1963 §5            |
| T_wall (1D bulk)    | 420-470 K       | Heywood Tab 12.4 (area-weighted) |
| Q_loss / Q_in       | 0.10-0.30 typical SI | Heywood Tab 12.2     |

## Expected ranges (what the solver should produce)

- `peak h_c` (Woschni, combustion phase): 1500-3500 W/m²·K at peak-power RPM,
  WOT. Higher at higher RPM (faster gas velocity).
- `mean h_c` (cycle-average): 400-900 W/m²·K.
- `Q_loss / Q_fuel`: 0.10-0.20 at 9000-13000 RPM (within Heywood's bands).
- If race calibration uses `c1_combustion = 0.7 · 2.28 = 1.6`, expect peak h_c
  reduced ~25 %, Q_loss / Q_fuel dropped to 0.07-0.12.

## Known disagreements

- **Annand vs Woschni for SI engines:** Heywood (Ch 12 §12.4) notes Annand was
  derived for *diesel* engines and underestimates h_c during the combustion
  spike in SI engines. Woschni's c2 term explicitly captures the
  combustion-pressure-rise effect Annand misses. Helios uses Woschni; Annand
  is a fallback / sanity-check option in some configs.
- **Woschni T-exponent:** 1967 paper has -0.53; some later authors (Hohenberg
  1979, restated in Heywood Ch 12 footnote) use -0.55. Difference is ~2 % in
  h_c at engine T's.
- **Race calibration scale factor:** The 0.7× drop on c1_combustion used in
  the Helios race calibration has no direct literature analog — it's empirical,
  tuned to close the CBR600 gap. Documented as a known tuning lever in
  PARITY_FLAGS.toml. Phase 1 finding #1 will sweep c1/c2 and document the
  literature-defensible range.
- **Hohenberg correlation** (not implemented here; Heywood eq. 12.45):
  `h_c = 130 · V^-0.06 · p^0.8 · T^-0.4 · (S_p̄ + 1.4)^0.8`. Gives ~5-15 %
  different h_c values; trade-off with Woschni varies by operating point.
  Phase 3 may add as an option.

## Solver implementation notes

- `crates/engine-sim/src/cylinder/heat_transfer.rs` implements Woschni; the
  per-phase coefficient logic uses crank-angle gates for "gas exchange",
  "compression", and "combustion+expansion".
- Annand is NOT currently implemented (Heywood Ch 12 §12.4 supports the choice
  for SI engines).
- Radiation term (Annand's `c·σ·T^4` part) is NOT implemented; Heywood notes
  it's < 5 % of total Q_loss for non-luminous flames typical of port-injected
  gasoline (CBR600's regime).
