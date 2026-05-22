# Heywood — Gas Exchange Processes (Ch. 6)

## Citation

- **Heywood, John B.** *Internal Combustion Engine Fundamentals*, 2nd ed., 2018.
  McGraw-Hill Education. ISBN 9781260116106.
  - Chapter 6 — "Gas Exchange Processes" (2nd ed.; 1st ed. Ch. 6, pp. 220-309).

## Scope

This chapter is the engine-sim solver's principal source for:
- Valve discharge coefficient `Cd` vs lift-to-diameter ratio (L/D)
- Choked-flow criterion at the valve
- Effective valve flow area vs lift
- Volumetric efficiency framework

## Equations

### Eq. 1 — Mass flow rate through a restriction

(Heywood eq. 6.5, p. 226 1st ed. — standard isentropic compressible-flow form.)

For subsonic, isentropic flow through an effective area A_e:

```
ṁ = (Cd · A_ref · p_0) / sqrt(R · T_0) · (p_T / p_0)^(1/γ) ·
    sqrt( (2γ / (γ-1)) · (1 - (p_T / p_0)^((γ-1)/γ)) )
```

Where:

| Symbol | Meaning                  |
|--------|--------------------------|
| Cd     | discharge coefficient    |
| A_ref  | reference (geometric) area |
| p_0, T_0 | upstream stagnation conditions |
| p_T    | downstream throat pressure |
| R      | specific gas constant    |
| γ      | ratio of specific heats  |

### Eq. 2 — Choked-flow criterion

(Heywood eq. 6.6.)

The flow chokes when `p_T / p_0 ≤ p_T*/p_0`, where:

```
p_T*/p_0 = (2 / (γ+1))^(γ/(γ-1))
```

For γ = 1.4 (air), `p_T*/p_0 = 0.528`. For γ = 1.30 (typical combustion
products at exhaust), `p_T*/p_0 = 0.546`. The simulator uses the per-cell γ
from the NASA-7 fits.

Choked mass flow:

```
ṁ_choked = Cd · A_ref · p_0 / sqrt(R · T_0) · sqrt(γ) · (2/(γ+1))^((γ+1)/(2(γ-1)))
```

### Eq. 3 — Effective valve flow area vs lift

(Heywood eq. 6.13 + Fig 6.15.)

Three flow regimes for a poppet valve:

- **Stage 1** (small lift, L/D < ~0.125): seat-controlled. Flow area is the
  frustum of a cone defined by valve seat angle β and lift L:
  ```
  A_eff = π · L · cos β · (D_v - L · sin β · cos β)
  ```
  For 45° seat (β = 45°): A_eff ≈ π · L · (D_v - L/2) · (√2/2).

- **Stage 2** (medium lift, 0.125 ≤ L/D ≤ 0.25): port-controlled. Approximately:
  ```
  A_eff ≈ π · D_p · (some function of L)
  ```
  Heywood gives a piecewise approximation; in practice tabulated Cd vs L/D
  captures the transition.

- **Stage 3** (large lift, L/D > 0.25): fully open, flow rate plateaus at the
  port-throat limited value.

### Eq. 4 — Discharge coefficient vs L/D

(Heywood Fig 6.16 — typical poppet valve, 45° seat, sharp-edged port throat.)

Tabulated Cd ranges:

| L / D    | Cd (intake) | Cd (exhaust) |
|----------|-------------|--------------|
| 0.05     | 0.55-0.65   | 0.50-0.60    |
| 0.10     | 0.65-0.72   | 0.60-0.68    |
| 0.15     | 0.70-0.77   | 0.66-0.73    |
| 0.20     | 0.73-0.80   | 0.70-0.76    |
| 0.25     | 0.74-0.81   | 0.71-0.77    |
| 0.30+    | 0.74-0.82 (plateau) | 0.71-0.78 (plateau) |

Engine-sim's existing `cd_table` in SDM26 config (see
`crates/engine-sim/src/intake.rs` and `exhaust.rs`) tabulates these per-valve.
Phase 1 finding #6 will audit the table against this Heywood reference + flow
bench data for the CBR600 specifically.

### Eq. 5 — Mach-number correction to Cd

(Heywood §6.3, restated from Annand-Roe.)

At low flow Mach numbers, Cd is approximately Mach-independent. Above
M ≈ 0.3-0.5, compressibility effects modify Cd:

```
Cd(M) ≈ Cd_inc · sqrt(1 - M²)  (rough Annand-Roe approximation)
```

This is a *negative* correction — Cd drops as Mach rises. The simulator
currently uses M-independent Cd (parity); Phase 1 finding #2 (Mach-corrected
Cd table) will validate against flow-bench Mach-sweep data.

### Eq. 6 — Volumetric efficiency definition

(Heywood eq. 6.21.)

```
η_v = ṁ_actual / (ρ_atm · V_d · (N/2)) = ṁ_actual · 2 / (ρ_atm · V_d · N)
```

For a 4-stroke engine; N is engine speed in revs/s. Engine-sim reports
`ve_atm` matching this convention.

Typical SI engine η_v values (Heywood Fig 6.13):

| RPM     | η_v (NA, no tuning)| η_v (with intake tuning) |
|---------|--------------------|--------------------------|
| 2000    | 0.65-0.75          | 0.85-0.95                |
| 4000    | 0.75-0.85          | 0.95-1.05                |
| 8000    | 0.70-0.85          | 0.95-1.10                |
| 13000   | 0.55-0.70          | 0.75-0.90                |

CBR600-class engines tuned for 13000 RPM peak: η_v ≈ 0.85-0.95 in the
10000-13000 RPM band (consistent with the simulator's outputs in
two_zone_results.md, which show ~0.85-0.95 across the race band).

## Constants / coefficients

| Constant            | Value           | Source             |
|---------------------|-----------------|--------------------|
| p_T*/p_0 (γ=1.4)    | 0.528           | Heywood eq. 6.6    |
| p_T*/p_0 (γ=1.30)   | 0.546           | Heywood eq. 6.6    |
| Cd plateau (intake) | 0.74-0.82       | Heywood Fig 6.16   |
| Cd plateau (exhaust) | 0.71-0.78      | Heywood Fig 6.16   |
| Critical M for Cd corr | ~0.3-0.5     | Heywood §6.3       |

## Expected ranges (what the solver should produce)

At CBR600 race-calibration operating points:

- **Peak intake Cd (during max lift)**: 0.75-0.82.
- **Choking onset (intake)**: only at very high RPM with restrictor; per
  physics_synthesis.md the restrictor reaches ~53 % of choke at 12000 RPM, so
  the engine is NOT choke-limited.
- **Peak exhaust Cd**: 0.71-0.78.
- **η_v**: 0.85-0.95 in race band (10000-13000 RPM).
- **Pressure ratio across intake valve during peak flow**: 0.85-0.92 (well
  above choke threshold).

## Known disagreements

- **Cd plateau values:** Heywood gives ranges 0.74-0.82; Lumley Ch 6 gives
  0.65-0.78 for "typical" port-injection (slightly lower). The difference is
  port-geometry-specific. Engine-sim's `cd_table` should be tuned for the
  specific port being modeled; finding #6 will audit.
- **Mach-number correction:** Heywood Annand-Roe form vs Hohenberg's
  empirical fits — both predict ~5-10 % Cd drop at M = 0.5, but different
  shapes. Finding #2 will pick one.
- **Valve seat angle effects:** Heywood assumes 45° seat. 30° and 60° seats
  shift Cd peak by ~2-5 % and shift the L/D where the plateau begins. The
  CBR600 uses 45° (standard); fine.

## Solver implementation notes

- `crates/engine-sim/src/intake.rs` and `exhaust.rs` implement the
  isentropic flow + Cd-table lookup.
- Choking is checked per-step; once chocked, flow rate uses eq. 2's choked form.
- Cd table is in SDM26Config; verify exact field name.
- M-correction is NOT implemented (parity); Phase 1 finding #2 opens.
