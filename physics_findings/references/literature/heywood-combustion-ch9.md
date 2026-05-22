# Heywood — Combustion in Spark-Ignition Engines (Ch. 9)

## Citation

- **Heywood, John B.** *Internal Combustion Engine Fundamentals*, 2nd ed., 2018.
  McGraw-Hill Education. ISBN 9781260116106.
  - Chapter 9 — "Combustion in Spark-Ignition Engines" (pp. 451-557 in 2nd ed.;
    the 1st-ed. counterpart is Ch. 9, pp. 371-470).
- Cross-reference: 1st ed. equation numbers shifted; where this document cites
  "eq. 9.X" the number is from the 2nd ed. unless otherwise marked
  `[1st ed.: eq. ...]`.

## Scope

This chapter is the engine-sim solver's principal source for:
- Wiebe (Vibe) heat-release form
- Two-zone burned/unburned thermodynamic split
- Mass-fraction-burned curve shape vs crank-angle
- MBT spark advance trends with RPM
- Combustion efficiency η_c vs equivalence ratio
- Flame development + propagation phase durations

## Equations

### Eq. 1 — Wiebe (Vibe) mass-fraction-burned

(Heywood 2nd ed. eq. 9.65, p. 391 in 1st ed.; widely also cited as eq. 9.32 or
the "Vibe function". Original: I. I. Vibe, 1956.)

```
x_b(θ) = 1 - exp( -a · ((θ - θ_0) / Δθ)^(m+1) )
```

Variables:

| Symbol | Meaning                                   | Typical range |
|--------|-------------------------------------------|---------------|
| x_b    | mass fraction burned (0 = unburned, 1 = burned) | 0..1    |
| θ      | crank angle                               | rad or deg    |
| θ_0    | start-of-combustion crank angle           | spark advance |
| Δθ     | total combustion duration                 | 20-60 deg     |
| a      | efficiency parameter                      | 5 (≈99 % burned) |
| m      | shape parameter                           | 2-4 (SI engines) |

Heywood notes (p. 391) that `a = 5` yields x_b = 0.993 at θ = θ_0 + Δθ; `a = 6.9`
yields x_b = 0.999. Most ICE practitioners use `a = 5`.

Shape parameter `m` per Heywood Table 9.5: 2 for fast-burn / pent-roof chambers,
3 for typical hemispherical, 4 for slow-burn open chambers.

### Eq. 2 — Two-zone energy balance

(Heywood eq. 9.49-9.53, pp. 388-389.)

For burned (b) and unburned (u) zones at common pressure P (no inter-zone heat
transfer, pressure equilibrium):

```
m_b · u_b(T_b, P) + m_u · u_u(T_u, P) = U_cyl
V = V_b + V_u
m_b · R_b · T_b / V_b = m_u · R_u · T_u / V_u = P
```

Where `u_b`, `u_u` are zone-specific internal energies (from NASA-7 fits or
Burcat tables, depending on composition). Heywood uses ideal-gas-mixture
relations; differences from real-gas effects are < 1 % at engine conditions.

Volume fractions (derived from ideal-gas + pressure equilibrium):

```
V_b / V = m_b · T_b · R_b / (m_b · T_b · R_b + m_u · T_u · R_u)
```

If species mass fractions are similar between zones (early flame): R_b ≈ R_u
and the formula simplifies to V_b/V = m_b·T_b / (m_b·T_b + m_u·T_u). The
engine-sim implementation uses this simplified form (see `two_zone_results.md`
in the repo root).

### Eq. 3 — Mass-averaged γ

(Implicit in eqs. 9.51-9.53; the simulator uses the form below.)

```
γ_eff = (m_b · γ_b(T_b, χ_b) + m_u · γ_u(T_u, χ_u)) / m_total
```

Where χ_b, χ_u are composition vectors. Heywood (p. 388-389) discusses that
γ_b is typically 1.20-1.27 at burned-gas temperatures 2400-3200 K, while
γ_u stays near 1.32-1.37 for unburned gasoline-air mixtures (T_u ≈ 700-1200 K).

### Eq. 4 — MBT spark advance correlation

Heywood Table 9.5 (1st ed.) / Fig. 9.20 (2nd ed.) gives MBT spark advance
(degrees BTDC) vs RPM for a typical SI engine:

| RPM   | MBT advance (deg BTDC) |
|-------|------------------------|
| 1500  | 12-18                  |
| 3000  | 16-24                  |
| 5000  | 20-30                  |
| 8000  | 24-35                  |
| 12000 | 28-40                  |

The simulator's default 25° BTDC is consistent with the 5000-8000 RPM band for a
"typical" SI engine; CBR600-class (peak ~13000 RPM) needs ~32-35°. See
physics_synthesis.md §A1 for the simulator's actual MBT-vs-RPM behavior.

### Eq. 5 — Combustion efficiency vs equivalence ratio

(Heywood Fig. 4-3 and Fig. 9.43; the model below is the AVL fit, also used by
Annand-Roe.)

For φ = (A/F)_stoich / (A/F), η_c as a function of φ:

```
η_c(φ) ≈ {
  0.98 - 0.40 · (1 - φ)^1.5         if φ < 1.0  (lean)
  0.95 + 0.05 · (1 - (φ-1)/0.3)^2    if 1.0 ≤ φ ≤ 1.2  (slightly rich)
  monotone decline beyond            if φ > 1.2  (rich quench)
}
```

The exact fit varies by author; the *qualitative* shape is robust:
- Lean: η_c approaches 1.0 from below as φ → 1; drops steeply for φ < 0.7.
- Peak: φ ≈ 1.0-1.1.
- Rich: declines as combustion becomes incomplete; below φ ≈ 1.2 (AFR ≈ 12.3)
  power drops sharply.

Engine-sim's default `eta_comb` is RPM-only (no φ dependence); enabling
`afr_eta_enabled` swaps in a φ-dependent fit. See physics_synthesis.md §2.3.

### Eq. 6 — Flame development + propagation phase durations

(Heywood Fig. 9.13, Tab. 9.4.)

For a typical SI engine at 1500 RPM, WOT, stoichiometric:

- Spark-to-2% MFB: 8-14 deg (flame development)
- 2% to 90% MFB: 25-40 deg (propagation)
- 90% to 100% MFB: 5-15 deg (termination)
- **Total burn duration:** typically 35-60 deg.

For high-RPM bike engines (CBR600 class), faster combustion is enabled by
tumble-driven turbulence; published values:

- 2-90 % MFB: 18-28 deg at 10000-13000 RPM (per Lumley Ch 5 + SAE 950618)

Engine-sim's default Wiebe duration is 50 deg in the SDM26 baseline; the
`tumble_burn_factor` opt-in flag shortens this. See PARITY_FLAGS.toml.

### Eq. 7 — Indicated mean effective pressure (IMEP)

(Heywood eq. 2.18, p. 49.)

```
IMEP = (1 / V_d) · ∮ P · dV
```

Where V_d is displaced volume and the cycle integral runs over one complete
4-stroke cycle (720 deg). The engine-sim solver computes IMEP per-cycle from
the actual P(V) trace; convergence is achieved when consecutive cycles differ
by < `convergence_tol_imep` (typically 1e-3 bar in 30-cycle runs).

## Constants / coefficients

| Constant       | Value          | Source            |
|----------------|----------------|-------------------|
| Wiebe a (99%)  | 5.0            | Heywood eq. 9.65  |
| Wiebe m (SI)   | 2-4 (default 3)| Heywood Tab 9.5   |
| Burn duration  | 35-60 deg (1500-5000 RPM) | Heywood Tab 9.4 |
| Burn duration  | 18-28 deg (10000-13000 RPM, tumble) | Lumley Ch 5 |
| MBT advance    | 25-40 deg (5000-12000 RPM) | Heywood Tab 9.5 (interpolated) |
| η_c (φ=1)      | 0.95-0.98      | Heywood Fig 4-3   |
| η_c (φ=0.7)    | 0.85-0.90      | Heywood Fig 4-3   |
| η_c (φ=1.2)    | 0.85-0.92      | Heywood Fig 4-3 (rich roll-off) |

## Expected ranges (what the solver should produce)

When the solver runs the SDM26 baseline at the canonical CBR600-restricted
calibration (race tune, 4-cyl, 20 mm restrictor, AFR ~12.5, spark advance per
MBT-vs-RPM):

- **IMEP** at peak-power RPM (10000-13000): 9.0-11.5 bar.
- **Brake power**: 41-52 kW at 9000-13000 RPM (per references/dyno).
- **Combustion duration (10-90 % MFB)**: 18-28 deg crank.
- **Peak P_cyl**: 80-95 bar at peak-power RPM, WOT.
- **Peak burned-zone T_b** (two-zone): 2700-3300 K.
- **Peak unburned-zone T_u** (two-zone): 1000-1200 K.

If `T_b` is hitting the 3500 K clamp (per two_zone_results.md), the
energy-conservation inversion is pushing physically too hot; this is a
known-investigated topic (see Phase 1 seeded finding #5).

## Known disagreements

- **MBT advance at high RPM:** Heywood Tab 9.5 stops at ~5000 RPM. Lumley Ch 5
  Tab 5.6 gives 28-32 deg at 8000 RPM for SI-bike engines, consistent with
  Heywood's slope but at the lower end. The CBR600 service manual gives
  factory-set ignition timing of 38° BTDC at 13000 RPM — at the high end of
  the Heywood extrapolation.
- **Wiebe `m` for fast-burn:** Heywood gives 2 for pent-roof. Ferguson &
  Kirkpatrick (Ch 5) prefers m=2.5 for "modern" 4-valve pent-roof. The
  difference shifts the peak P_cyl crank-angle by ~1-2 deg; within typical
  engineering uncertainty.
- **η_c rich slope:** Heywood Fig 4-3 shows mild decline below φ=1.1.
  Lumley Ch 4 shows a steeper drop below φ=1.2 due to charge-cooling
  interactions. Engine-sim currently has no φ-dependent η_c (parity); see
  physics_synthesis.md §2.3 for the open AFR-η_c investigation.

## Solver implementation notes

- `crates/engine-sim/src/cylinder/wiebe.rs` implements eq. 1 with `a = 5`.
  Default `m = 3`, configurable per cylinder via SDM26Config.
- `crates/engine-sim/src/cylinder/two_zone.rs` (when `two_zone_enabled = true`)
  implements eqs. 2-3. See two_zone_results.md for measured impact.
- MBT advance is a config knob, not solved internally; the orchestrator's
  finding #13 will validate MBT-vs-RPM defaults against multi-engine corpus.
