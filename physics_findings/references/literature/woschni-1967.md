# Woschni 1967 — Universally Applicable Equation for the Instantaneous Heat Transfer Coefficient

## Citation

- **Woschni, G.** "A Universally Applicable Equation for the Instantaneous Heat
  Transfer Coefficient in the Internal Combustion Engine." *SAE Transactions*,
  vol. 76 (1967), paper 670931, pp. 3065-3083. DOI: 10.4271/670931.
- Often cited shorthand: "Woschni 1967" / "Woschni eq. 8" (the correlation form
  used in practice is eq. 8 of the original paper).

## Scope

This is the *original* derivation of the Woschni correlation. The engine-sim
solver's heat-transfer model is a direct implementation of this paper's
"combustion + expansion" phase form. Heywood Ch 12 (see
`heywood-heat-transfer-ch12.md`) restates the correlation but loses some of
Woschni's nuance — this file preserves the original assumptions.

## Equations (from the paper, 1967 numbering)

### Eq. 6 — Nusselt-Reynolds relation (starting point)

Woschni begins with a Nusselt-Reynolds relation analogous to flow in a pipe:

```
Nu = C · Re^0.8 · Pr^0.4
```

Treating Pr as approximately constant for engine gas mixtures (~0.7), the Pr
term is absorbed into C.

### Eq. 7 — Convective coefficient (derived)

Defining `h_c = Nu · k / B` and substituting `Re = ρ · w · B / μ` with gas
property correlations from Mu et al. (cited in Woschni's §3.2):

```
h_c = C · k(T) · B^(-1) · (ρ · w · B / μ(T))^0.8
```

Using `ρ = p / (R · T)` and the gas property power-laws `k(T) ∝ T^0.75`,
`μ(T) ∝ T^0.62`:

```
h_c = C' · B^(-0.2) · p^0.8 · T^(-0.53) · w^0.8
```

This is the *form* used by every "Woschni-style" correlation since.

### Eq. 8 — Final coefficient (the form everyone cites)

Woschni's published constants (paper §3.3, derived from his test-engine data):

```
h_c [W/m²·K] = 3.26 · B^(-0.2) · p^0.8 · T^(-0.53) · w^0.8
```

With:
- B in meters
- p in kPa  (this is the original paper's convention — note the unit!)
- T in K
- w in m/s

### Eq. 9 — Characteristic velocity `w`

(Woschni eq. 9.)

```
w = C_1 · S_p̄ + C_2 · (V_s · T_r / (p_r · V_r)) · (p - p_motored)
```

Variables:

| Symbol  | Meaning                          | Units            |
|---------|----------------------------------|------------------|
| S_p̄    | mean piston speed                | m/s              |
| V_s     | swept volume                     | m³               |
| T_r, p_r, V_r | reference state (typically IVC) | K, kPa, m³ |
| p       | instantaneous cylinder pressure  | kPa              |
| p_motored | motored (no combustion) pressure | kPa            |
| C_1     | piston-speed weighting           | varies (see below)|
| C_2     | combustion-driven weighting      | m/(s·K) (Woschni: 3.24e-3) |

### Eq. 10 — Phase-dependent C_1, C_2

(Woschni Tab 1.)

| Phase                          | C_1   | C_2 (m/(s·K)) |
|--------------------------------|-------|---------------|
| Gas exchange (intake + exhaust)| 6.18  | 0             |
| Compression (IVC to spark)     | 2.28  | 0             |
| Combustion + expansion         | 2.28  | 3.24e-3       |

Woschni's reasoning:
- During gas exchange, piston motion is the dominant velocity scale; the
  swirl/tumble multiplier (~6.18) reflects port-driven flow.
- During compression (no combustion), only piston motion matters; C_1 = 2.28
  is a "natural convection + piston-driven" boundary-layer coefficient.
- During combustion, the rapid pressure rise drives an additional gas-velocity
  term proportional to (p - p_motored). The C_2 coefficient is derived from
  flame-propagation gas-acceleration arguments.

The motored pressure `p_motored` is the no-combustion compression line, computed
by integrating the polytropic relation from IVC.

## Constants / coefficients

| Coefficient | Value          | Phase                    |
|-------------|----------------|--------------------------|
| C (leading) | 3.26           | All (W/m²·K, kPa, K, m)  |
| C_1         | 6.18           | Gas exchange             |
| C_1         | 2.28           | Compression              |
| C_1         | 2.28           | Combustion + expansion   |
| C_2         | 0              | Gas exchange + compression |
| C_2         | 3.24e-3 m/(s·K) | Combustion + expansion |

These are the *published* values. Woschni notes in §4 that they were calibrated
on a diesel engine; SI engine adaptations have been published (Han et al. 1997,
Hohenberg 1979) with modestly different leading constants.

### Race-engine adaptation (engine-sim convention)

The Helios race-calibration drops `C_1_combustion` from 2.28 to 1.60 (≈ 0.7×)
to better match measured CBR600 IMEP / Q_loss. This is empirical and is not in
the original Woschni paper. Rationale (per physics_synthesis.md):

- Pent-roof small-bore combustion chambers have lower wall-to-volume ratios
  than the diesel-style chambers Woschni calibrated on.
- High-tumble bike engines may have *different* turbulent boundary-layer scaling
  than Woschni's assumption.

This is tracked as `woschni_c1_scale` in PARITY_FLAGS.toml. Finding #1
(Woschni c1/c2 sensitivity sweep) is the open investigation to ground this
0.7× factor in published bike-engine literature.

## Expected ranges (what the solver should produce)

At CBR600-class operating points (10000-13000 RPM, B = 0.067 m, S_p̄ ≈ 22-26 m/s,
peak P ≈ 85-95 bar = 8500-9500 kPa):

- **Peak h_c (combustion phase)** with Woschni default constants:
  ≈ 3.26 · 0.067^-0.2 · 9000^0.8 · 2800^-0.53 · 50^0.8
  ≈ 3.26 · 1.78 · 1614 · 0.0146 · 25.1
  ≈ **3430 W/m²·K** at peak combustion.
- **Cycle-averaged h_c**: ≈ 600-900 W/m²·K (heavily dominated by gas-exchange
  and compression phases).
- **Q_loss / Q_fuel**: 0.12-0.18 (typical SI, default constants).
- **With race-calibration `C_1 × 0.7`**: peak h_c drops to ~2400 W/m²·K;
  Q_loss / Q_fuel drops to ~0.08-0.12.

## Known disagreements

- **Diesel-vs-SI applicability:** Woschni's 1967 calibration was a 4-cylinder
  *diesel* engine. SI engine adaptation requires re-fitting C_1. Han et al.
  (SAE 970872) recommend C_1 ≈ 4.6 for SI engines during combustion
  (mixing-controlled view), versus Woschni's 2.28 (boundary-layer view). The
  community has not converged; Heywood Ch 12 uses Woschni's 2.28 by convention.
- **T-exponent:** Woschni 1967 gives -0.53 (paper eq. 8). Hohenberg 1979
  (SAE 790825) updates to -0.4 based on better gas-property correlations at
  high T. Heywood Ch 12 footnote mentions both. Difference is ~3-5 % in h_c.
- **Leading constant in different unit systems:** "3.26" assumes p in kPa,
  h_c in W/m²·K, B in m. Some texts publish "130" assuming p in bar — that's
  the same correlation, just unit-converted. Beware copy-paste errors when
  comparing simulator code to published values.
- **C_2 = 3.24e-3:** Woschni 1967 §3.3 gives this from a fit; many later
  authors round to 3.2e-3 or 3.5e-3. Difference is < 5 % in h_c during the
  combustion-driven phase.
- **Race-calibration 0.7× factor:** No direct literature analog. Documented
  as an empirical tuning lever; finding #1 will scan c1 ∈ [0.5×, 1.5×] of
  default and compare against measured.

## Solver implementation notes

- The C_1, C_2 phase split is implemented via crank-angle gates in
  `crates/engine-sim/src/cylinder/heat_transfer.rs`.
- `p_motored` is computed by tracking a parallel cylinder state with
  `dQ_combustion = 0`; this is exact (matches Woschni's intent) but adds ~10 %
  to per-step compute.
- The T-exponent constant (-0.53 vs -0.55 vs -0.4) is a config knob; the
  Helios default uses -0.53 per Woschni 1967.

## Cross-references

- Heywood Ch 12 restatement: `heywood-heat-transfer-ch12.md` eq. 2.
- Two-zone heat-loss split: `heywood-combustion-ch9.md` + `two_zone_results.md`.
- Phase 1 open investigation: orchestrator queue #1.
