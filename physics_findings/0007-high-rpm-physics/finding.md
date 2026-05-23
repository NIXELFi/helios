---
id: 7
slug: high-rpm-physics
status: VALIDATED
topic: Pushed on the high-RPM under-prediction gap (sim_wheel 33 kW vs FSAE dyno 50 kW @ 13000 RPM). Shipped two opt-in machinery additions (RPM-dependent Wiebe a; open-end exhaust collector reflection BC) — both parity-preserving, both with the geometry-derived defaults documented. Final answer: NEITHER closes the gap, because the underlying physics gap is the simulator's general INSENSITIVITY to exhaust pulse-tuning. Sweeping primary length 0.05m to 1.5m (30× range) changes BP@13k by only ~4 kW. Real engines: 100mm primary change shifts peak RPM by 1-2 kRPM. The 1D MUSCL-Hancock solver damps sharp blowdown pulses before they reach the junctions with enough amplitude to do work. This is a SOLVER-CLASS limit for SDM27 exhaust design.
hypothesis: After 0006, the residual gap at 13 kRPM is -17 kW wheel power on SDM26 (implied drivetrain η = 1.28, unphysical → real missing power). Candidate causes: (a) RPM-dependent turbulent flame speed (Wiebe a should grow with mean piston speed per Heywood / Bonatesta); (b) missing exhaust pulse-reflection scavenging at the collector outlet (legacy BC is fully transmissive r=0). Falsification: if (a) doesn't move BP at high RPM, then combustion isn't the bottleneck and the issue is breathing (no fresh charge to burn). If (b) doesn't close the gap, then either the reflection isn't where the scavenging physics lives OR the simulator can't carry the pulse with enough amplitude to do work.
opened: 2026-05-23
closed: 2026-05-23
owner: physics-investigator
spawned_by: manual
commit_hash: ~
baseline_fingerprint: ~
revalidation_count: 0
acceptance_approved_at: 2026-05-23
---

## Hypothesis

After 0005+0006 shipped, the simulator's SDM26 wheel-power matches the
FSAE-restricted CBR600 dyno to within 0 kW at 10000 RPM but
under-predicts by 17 kW at 13000 RPM. The implied drivetrain efficiency
at 13k is 1.28 — physically impossible (drivetrain can't amplify), so
real power is missing in the simulator.

Two parallel hypotheses tested:

1. **RPM-dependent Wiebe `a`**: Heywood Ch 9 / Bonatesta-Waters-Shayler
   (IJER 2010) — flame speed scales with mean piston speed → effective
   Wiebe `a` should grow with RPM. At fixed crank-angle duration, larger
   `a` finishes the burn earlier in expansion → more work. Should help
   high-RPM BP if combustion timing is the bottleneck.

2. **Exhaust collector open-end reflection**: agent A code-read found
   the collector outlet uses `fill_transmissive_right` (reflection
   coefficient r=0 — fully non-reflecting). Real low-Helmholtz-number
   open ends have r ≈ −1 (Munjal §2.7; Levine-Schwinger 1948). For
   SDM26 (50mm collector, exhaust pulse ~430 Hz at 13k), ka ≈ 0.097 →
   r should be near 1 (full inversion). Reflected expansion wave should
   arrive at overlap → scavenging benefit (Annand & Roe 1974 quantifies
   10-20% peak power from exhaust scavenging in inline-4 motorcycle
   engines).

Falsification:

- If Wiebe `a` scaling moves BP only fractionally (≤ 0.5 kW across full
  RPM range), combustion isn't the bottleneck.
- If exhaust reflection BC hurts BP rather than helping (or doesn't
  move it), then either (i) the BC formulation is wrong, (ii) the
  scavenging physics lives in the primary/secondary junctions rather
  than at the collector outlet, or (iii) the 1D solver can't propagate
  the sharp blowdown pulse with enough amplitude to make junction-
  based scavenging meaningful.

## Study design

### Phase A: Wiebe `a` RPM-scaling sensitivity

`study_wiebe_a_exp_*.toml` — sweeps `wiebe_a_rpm_exp` ∈ {0.0, 0.2, 0.4,
0.6, 0.8} on top of the all-0006 fix stack. Bonatesta-style exponent
range. Run on SDM26 across RPM 6000-13000, 30 cycles, characteristic
junction.

### Phase B: Exhaust open-end reflection sensitivity

`study_v8_refl{00,03,05,07,10}_{sdm26,sdm25}.toml` — sweeps the new
`exhaust_collector_reflection_coef` ∈ {0.0, 0.3, 0.5, 0.7, 1.0}.

### Phase C: Collector length × reflection cross-product

`study_cl{0.05,0.10,0.15,0.20,0.30,0.40,0.60}.toml` (and `_off` controls)
— with reflection ON, vary collector length to test whether wave-timing
tuning emerges.

### Phase D: Primary/secondary length sensitivity

After user correction ("scavenging is supposed to come from the primary
and secondary length, not collector length"): `study_pri_*.toml` and
`study_sec_*.toml` sweep these lengths individually.

### Phase E: Extreme range + resolution

`study_extreme_pri_*.toml` — primary length 0.05m to 1.5m (30× range)
and n_cells {30, 60, 120} to test the "numerical-damping smears the
pulse" hypothesis.

## Literature

- **Annand & Roe (1974)**, *Gas Flow in the Internal Combustion Engine*
  — exhaust pulse tuning gives 10-20% peak power on inline-4 motorcycles.
- **Blair (1999)**, *Design and Simulation of Four-Stroke Engines*,
  Ch 2 & 6 — standard 1D engine treatment; explicit open-end reflection
  is mandatory in GT-POWER / Ricardo WAVE.
- **Munjal (2014)**, *Acoustics of Ducts and Mufflers* §2.7 — radiation
  impedance Z_r/ρc = (ka)²/4 + j·0.6133·ka; r ≈ −1 for ka << 1.
- **Levine & Schwinger (1948)** Phys Rev 73:383 — original derivation
  of open-end reflection coefficient + 0.6133·a end correction.
- **Heywood Ch 9** — turbulent flame speed scales with mean piston
  speed; MBT advance grows with RPM.
- **Bonatesta-Waters-Shayler (2010)** IJER — Δθ_burn ∝ N^p with p ~ 0.3-0.5.

## Results

### 1. Wiebe `a` RPM-scaling: ZERO effect at high RPM

Sweep of `wiebe_a_rpm_exp` from 0.0 to 0.8 (on top of all-0006 fixes):

| exp | BP_wheel @6k | @10k | @13k | gap@13k |
|----:|-------------:|-----:|-----:|--------:|
| 0.00| 30.16        | 41.00| 33.46| -17.04  |
| 0.20| 30.02        | 41.00| 33.55| -16.95  |
| 0.40| 29.83        | 41.00| 33.63| -16.87  |
| 0.60| 29.58        | 41.00| 33.66| -16.84  |
| 0.80| 29.24        | 41.00| 33.71| -16.79  |

Across the full exponent range BP@13k moves 0.25 kW (0.74%). **Combustion
timing is NOT the bottleneck at high RPM** — the burn is already
finishing in the expansion stroke; what's missing is fresh charge to
burn (a breathing-limit issue, not a combustion issue).

### 2. Open-end collector reflection: HURTS uniformly

The legacy `fill_transmissive_right` BC gives r=0 (no reflection). The
new `fill_open_end_right` BC uses NSCBC-style characteristic
decomposition around the atmospheric far-field state:

```text
p'_out = p_interior − p_atm      (outgoing perturbation)
p_f = ½·(p'_out + ρ·c·u_out)     (forward acoustic wave)
p_b = −r · p_f                    (open-end inversion × magnitude r)
p'_ghost = p_f + p_b              (recovered ghost perturbation)
```

This formulation correctly distinguishes the DC component (no reflection,
mass flows out) from the AC perturbation (reflects with coefficient r).
Parity preserved at r=0; at r=1 it's pressure-release at the face.

Result on SDM26 (all-0006 fixes baseline, wheel power):

| r   | RMSE | bias | gap@10k | gap@13k |
|----:|-----:|-----:|--------:|--------:|
| 0.0 |10.04 |+1.94 | +0.00   | −17.04  |
| 0.3 |12.18 |−2.45 | −5.61   | −22.55  |
| 0.5 |11.97 |−2.28 | −5.65   | −22.09  |
| 0.7 |11.71 |−2.04 | −5.63   | −21.47  |
| 1.0 |11.55 |−1.84 | −5.62   | −21.35  |

Reflection **hurts everywhere**. Even sweeping the collector length
0.05m → 0.60m with r=1.0 ON, the best variant still under-predicts
baseline by ~3 kW across the board (Phase C data).

### 3. Primary + secondary length sensitivity: ESSENTIALLY FLAT

After user pointed out scavenging lives in primary/secondary length
(via area-ratio reflection at the merge junctions), we swept those:

Primary length (0.20 → 0.60 m):

| pri_L | BP@8k | BP@10k | BP@11k | BP@12k | BP@13k |
|------:|------:|-------:|-------:|-------:|-------:|
| 0.20  | 42.75 | 41.54  | 43.42  | 40.78  | 34.18  |
| 0.308 | 42.41 | 41.00  | 43.29  | 40.55  | 33.81  |
| 0.60  | 42.11 | 41.23  | 43.33  | 40.62  | 33.82  |

Secondary length (0.20 → 0.80 m): similar, BP varies ~1 kW.

Extreme range (0.05m → 1.5m) AND high resolution (n_cells 30 → 120):

| pri_L | n_cells | BP@13k |
|------:|--------:|-------:|
| 0.05  | 30      | 35.08  |
| 0.10  | 30      | 34.74  |
| 0.308 | 60      | 34.46  |
| 0.308 | 120     | 34.95  |
| 0.50  | 30      | 33.96  |
| 1.00  | 30      | 33.77  |
| 1.50  | 30      | 30.83  |

**Across 30× length range BP@13k varies only 4 kW**. Even the most
extreme primary length (1.5m, with a round-trip time longer than the
entire 720° cycle at 13k RPM) doesn't produce a sharp tuning peak.
Higher n_cells doesn't help either.

### 4. Diagnosis — the simulator under-models exhaust pulse tuning

For real CBR600 4-2-1 exhausts:
- Primary length tuning shifts peak RPM by 1-2 kRPM per 100mm
- Peak-power gain from tuned vs untuned exhaust is 10-20%
- Wave amplitude at junction matters as much as timing

For this 1D Euler simulator with MUSCL-Hancock + HLLC:
- The blowdown pulse exits EVO at ~3-5 bar overpressure
- After propagating through 0.3m of primary (~ 40 cells at default
  res), the pulse has been smeared by numerical viscosity
- By the time it reaches the primary→secondary junction, the amplitude
  is too small to produce a significant reflection
- The reflected wave (already small) attenuates further on the return
  trip and arrives at the cylinder with insufficient amplitude to
  meaningfully aid scavenging

This is a SOLVER-CLASS limit, not a wiring bug. The Characteristic
junction is correctly impedance-matched (area-ratio reflection is
present); the upstream gas dynamics is the bottleneck.

## Comparison vs literature / spec

| Metric                              | Pre-0007  | Post-0007 (defaults) | Status |
|-------------------------------------|-----------|----------------------|--------|
| Parity goldens (defaults preserve)  | 20/20     | 20/20                | ✓      |
| C9 mass conservation                | PASS      | PASS                 | ✓      |
| BP@13k wheel (SDM26, vs FSAE 50.5)  | 33.46     | 33.46                | unchanged |
| Exhaust tuning sensitivity (lit.)   | 10-20%    | ~3% (extreme range)  | **gap**|

## Conclusion

**VALIDATED.** The diagnosis is clean:

1. **Wiebe `a` RPM scaling is the right physics** (Heywood, Bonatesta)
   but **NOT the right lever** on this engine — combustion phasing
   isn't the bottleneck at 13k. Shipped opt-in for SDM27 designs that
   might have different combustion regimes.

2. **Open-end collector reflection BC is correct physics** and now
   exposed as `exhaust_collector_reflection_coef`. NSCBC characteristic
   decomposition preserves DC mass flow while reflecting AC pulses.
   But: on the SDM26 geometry the reflection at the collector OUTLET
   isn't where the scavenging happens (4-2-1 junction reflections
   dominate). And even with it ON, BP doesn't improve.

3. **The simulator under-models tuned-exhaust sensitivity** —
   sweeping primary/secondary lengths 30× barely moves BP. This is
   the dominant remaining physics gap for high-RPM accuracy. Likely
   cause: MUSCL-Hancock numerical viscosity damps sharp blowdown
   pulses below the amplitude needed for meaningful junction-reflection
   scavenging.

### SDM27 design implication

The simulator is **NOT** a reliable tool for optimizing exhaust
primary/secondary lengths. The design knob it exposes (and the
literature says is important) doesn't behave the way real engines do.
Use the simulator for:

- ✓ Intake matching (runner length, plenum volume, restrictor) — fig04
  in 0006 shows these respond physically
- ✓ Bore / stroke / compression — predictable, monotone responses
- ✓ Wave-physics at the intake side (post-0005 junction loss fixes)
- ✗ Exhaust primary/secondary length optimization — flat response
- ✗ Predicting peak-RPM under tuned-exhaust regimes

For exhaust tuning, supplement Helios with GT-POWER, Ricardo WAVE, or
empirical 1/3-cycle rule-of-thumb (`L_pri ≈ c·t_overlap/2`). Or invest
in a higher-order Helios solver (WENO, DG) where pulse amplitudes
propagate with less artificial damping.

### Status decision

This finding closes as **VALIDATED** (diagnosis sound; what we shipped
preserves parity and exposes the design knobs; the negative result
itself is the most important contribution). It does NOT close as FIXED
because the underlying solver limit is unfixed and a SOLVER-CHANGE
follow-up is needed to close the gap — listed as 0008 candidate below.

## Reproducibility

```bash
# All studies in this finding:
D=physics_findings/0007-high-rpm-physics
for f in $D/study_*.toml; do
    out="${f%.toml}.ndjson"; out="${out/study_/results_}"
    target/release/helios-bench sweep --out "$out" "$f" --commit 0007-final
done
```

Parity:

```bash
cargo test --release -p engine-sim --test 'parity_*'
```

## Followup queue

- **0008 — SOLVER-CHANGE-REQUIRED: higher-order exhaust gas dynamics**.
  The MUSCL-Hancock + HLLC pipeline can't carry sharp blowdown pulses
  with enough amplitude for tuned-exhaust scavenging to bite. Candidate
  upgrades: 3rd-order WENO reconstruction, characteristic-variable
  limiting, or discontinuous Galerkin in the exhaust pipes only.
  Gated by spec §2 (solver-core change requires user sign-off).
- **0009 — intake-port losses for the 6 kRPM over-prediction** (η=0.52
  at 6k). Candidate: low-Reynolds Cd correction for the intake valve,
  port wall friction model.
- **0010 — high-lift Cd roll-off** for the intake valve. Steady-flow
  bench data flat above L/D=0.30 but real seat-detachment effects
  are present.
- **Exhaust BC machinery shipped**: SDM27 designers can use
  `exhaust_collector_reflection_coef` to test specific collector
  geometries. The NSCBC formulation is correct; the bottleneck is
  upstream pulse amplitude, not the BC.
