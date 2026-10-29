---
id: 36
slug: map-reference-level-calibration
status: INVESTIGATED
topic: A MAP-based airflow reference from the raw ECU log replaces PW·λ as the car shape target. Six parallel experiments (MAP reference, damping audit, excitation sensitivity, literature, intake restriction, exhaust wall temperature) found three model errors - sea-level ambient, over-recovering restrictor diffuser, cold exhaust walls - and showed ripple amplitude is set by exhaust blowdown strength and exhaust-pipe heat loss (numerics and friction are not it). The corrected config `sdm26_asbuilt_cal` fits a single constant drivetrain efficiency (0.94); speed-dependent loss models lose on cross-validation. It reaches team-dyno RMSE 2.01 kW (6-12.5k) / 1.69 kW (7-11.5k), was 2.78 / 2.36, matches the car's intake pressure drop within 0.5 kPa, and carries 0.62 of the car's in-phase VE ripple (was 0.29).
hypothesis: The model/car shape gap after 0035 is partly the reference (PW·λ) and partly missing wave amplitude; the dyno level gap is boundary conditions, not combustion.
opened: 2026-09-29
closed: ~
owner: physics-implementer (Claude, agent experiments)
spawned_by: Nick 2026-09-29 ("experiment using agents on some new stuff")
commit_hash: ~
baseline_fingerprint: fix/engine-sim-accuracy-0929 @ a1fd642e
revalidation_count: 0
acceptance_approved_at: ~
---

## TL;DR

- **New car reference.** Restrictor mass flow from (baro − MAP) is a tune-independent airflow measurement.
  - MAP-VE (`references/ecu/ve_map_reference.csv`, built by `scripts/mapve.py`) peaks at 6.0k and 8.75k, the same as the dyno. It correlates r 0.88 with dyno torque.
  - Its 7.5-8k dip is only −0.09 (sensitivity band −0.075 to −0.11).
  - PW·λ overstated the ripple ~2× and shifted it up in rpm, which also explains 0035's "dyno rpm axis" puzzle. **Retire PW·λ as the shape target.**
- **Three model errors found:**
  1. **Ambient** was sea level (101.3 kPa, 300 K). Tempe is ~97.3 kPa and ~305 K intake. This alone gave the biggest dyno gain.
  2. **Venturi diffuser recovery:** the model's intake Δp was about half the car's. `restrictor_diffuser_efficiency` 0.62 matches the car's baro − MAP curve over 4-10.75k within 0.5 kPa, including the ~1.2 kPa floor at 4-5k.
  3. **Exhaust wall temperatures** were 650/550/500 K. Realistic WOT header walls are 900/750/650 K. The cold walls pulled heat out of the blowdown pulses and damped the waves.
- **What sets the ripple amplitude:** exhaust blowdown strength (EVO, exhaust lift, exhaust Cd) and exhaust-pipe heat loss.
  - The model is numerically converged for amplitude: superbee, WENO5, CFL 0.3 and 2× cells all agree within ±0.05.
  - Friction is not the limiter, and intake valve area does nothing.
- **`sdm26_asbuilt_cal` (new experimental example config):**
  - It combines the as-built geometry, the logged tune (λ at the WOT-measured lag), the 0035 momentum collector and exhaust γ/R, and fixes 1-3.
  - The engine level stays at the shipped values (combustion efficiency 0.94, stock FMEP).
  - The **only fitted number is a constant drivetrain efficiency, 0.94** (§5). A constant fraction beats every speed-dependent loss model on cross-validation.
  - No wave knob was fitted.
  - Team-dyno RMSE is 2.01 kW over 6-12.5k, 1.69 over 7-11.5k and 1.80 over 10.5-12.5k, with bias +0.04 (the logged-tune config was 2.78 / 2.36 / 3.02).

![fig](fig_0036.png)

## 1. MAP-based airflow reference (experiment 1)

- **Method.** The mass flow through the 20 mm throat (Cd 0.97, T0 305 K) is computed from p0 = baro and plenum MAP, as compressible nozzle flow to the throat, with diffuser recovery η in `MAP = pt + η(p0 − pt)`. VE_map = ṁ / (ρ0·Vd·rpm/120), using the same WOT filter and 250 rpm bins as the proxies.
- **Baro is not logged.** 97.3 kPa is the Tempe standard. At 96.3 kPa the 4-5k absolute VE becomes implausible.
- **Sensitivity** (`references/ecu/ve_map_sensitivity.csv`): baro ±0.5-1 kPa, η 0-0.8, a Δp^n law with n 0.45-0.55, 50 ms MAP lag, 51 ms smoothing, and slow vs fast sweep halves. Depth is −0.075 to −0.108 in every case, and the peaks always sit at 6.0k and 8.5-8.75k.

| reference | ripple std 5.5-10k | 7.5-8k depth | peaks | r vs dyno torque |
|---|---|---|---|---|
| MAP-VE (base) | 0.044 | −0.089 | 6000 / 8750 | **0.88** |
| PW·λ, WOT lag (0035) | 0.087 | −0.254 | 6500 / 9000 | 0.53 |
| dyno torque / mean | 0.058 | −0.157 | 6000 / 8500 | - |

MAP falls monotonically through 7.25-8.25k (93.3 → 92.4 kPa). A 20 % airflow dip would need MAP about 1.5 kPa above trend, while the binned MAP std is 0.33 kPa. The PW·λ excess comes from the fuel side: closed-loop trim, the λ floor and transient fuelling.

## 2. Experiments (details, CSVs and figures in `experiments/`)

All experiments ran on sdm26_asbuilt_exhaust + momentum collector (M10) unless noted, over 28-32 rpm points at 30 cycles. "Slope" is the in-phase regression slope of model VE on car MAP-VE over 5.5-10k (1.0 would match the car's ripple). The M10 base has slope 0.49 and r 0.80.

- **Damping audit** (exp 2; new knobs `physics.pipe_friction_multiplier`, `pipe_heat_transfer_multiplier`, `exhaust_heat_transfer_multiplier`; default 1 = parity):

  | variant | ripple std | r / slope vs MAP-VE |
  |---|---|---|
  | base (M10) | 0.034 | 0.80 / 0.49 |
  | exhaust heat ×0 | 0.059 | 0.76 / 0.79 |
  | intake heat ×0 | 0.033 | 0.81 / 0.48 |
  | all heat ×2 | - | slope 0.18 |
  | friction ×0 | 0.028 | slope 0.36 |
  | friction ×2 | - | slope 0.53 |
  | superbee, WENO5, CFL 0.3, 2× cells | - | slope 0.45-0.48 |

  (`damping_audit.csv`)
- **Excitation** (exp 3; `ranking.csv`): slope change per plausible half-range.
  - EVO ±10°: 0.76 (earlier) to 0.22 (later).
  - Exhaust lift ±15 % and exhaust Cd ±20 %: 0.30 → 0.65.
  - Lift-shape exponent 1.0/1.6: 0.60 → 0.39.
  - IVC ±10°: 0.39 → 0.59.
  - Spark +5° reduces the slope by 0.06. Intake Cd and intake lift have no effect.
  - No input moves the peak or trough rpm. The strongest levers are the least-measured inputs.
- **Literature** (exp 4; `literature_brief.md`, some sources paywalled):
  - It confirms the WOT λ lag of about 90 ms against about 300 ms on overrun.
  - Its top amplitude suspects were numerical diffusion (ruled out by exp 2), restrictor wave absorption (no amplitude effect in the venturi family, exp 5) and unsteady valve Cd.
- **Intake restriction** (exp 5; `exp5_summary.csv`):
  - Ambient 97.3 kPa / 305 K takes dyno RMSE 6-12.5k from 3.46 to 2.54 kW, and 10.5-12.5k from 4.93 to 2.30.
  - Diffuser η 0.62 takes the intake-Δp RMSE from 2.74 to 0.44 kPa and gives the best MAP-VE r (0.82), but it lowers the level by 2.7 kW.
  - The legacy choked restrictor and η ≈ 0 grossly over-restrict.
  - The in-phase slope stays at 0.44-0.50 in all intake variants.
- **Exhaust wall temperature** (exp 6; `exp6_summary.csv`, on the exp 5 intake baseline):

  | walls / heat setting | slope | ripple std | de-biased RMSE |
  |---|---|---|---|
  | 650/550/500 K (base) | 0.47 | 0.033 | 2.10 |
  | 900/750/650 K | 0.71 | 0.050 | 1.92 |
  | 1000/850/750 K | 0.78 | 0.057 | - |
  | exhaust h ×0.3-0.5 | 0.66-0.68 | - | - |

  - The car's ripple std is 0.044.
  - Mean EGT stays at about 1200 K in every variant.
  - Realistic walls are the physical version of the heat multiplier, so no multiplier is used.

## 3. Level calibration, first pass (`scripts/`). Superseded by §5.

This first pass fitted combustion efficiency and FMEP at a fixed drivetrain efficiency of 0.85. The shipped config uses §5 instead.


- **Base config** = logged-tune config + momentum collector + exhaust γ 1.30 / R 295 + ambient 97.3 kPa / 305 K + diffuser η 0.62 + walls 900/750/650 K.
- **λ map:** the logged-tune λ map was rebuilt at the WOT-measured lag (`references/ecu/proxy_wotA.csv`). The 270 ms map was shifted about 250 rpm where λ changes fastest (errors up to 0.08 λ). The corrected map left the fit unchanged.
- **Bend/muffler losses (0035) are left out.** They cut the slope from 0.62 to 0.55, and their K values are handbook guesses.
- **Method:** combustion efficiency sets the indicated level (two engine runs, at 0.94 and 0.98, interpolated). FMEP only enters post-cycle as brake = (IMEP − FMEP)·Vd/4π; the reconstruction matches the engine within 0.023 N·m. So an FMEP scale × η grid was fitted offline against dyno power over 6-12.5k (wheel = brake × 0.85).

| η_comb | best FMEP scale | RMSE 6-12.5k | bias |
|---|---|---|---|
| 0.94 (shipped) | 0.60 | 2.45 | −0.57 |
| 0.96 | 0.675-0.70 | 2.31 | −0.35 |
| **0.98 (chosen, physical ceiling)** | **0.775** | **2.19** | −0.31 |
| 1.00 (fit optimum, unphysical) | 0.875 | 2.07 | −0.27 |

- **The fit pins η_comb at its upper bound.** The residual pull comes from 8-9.5k, where the dyno's 8.5k torque peak (49.5 N·m wheel) is sharper than the model's (about 45). η is capped at 0.98.
- **FMEP ×0.775** gives 1.47 bar at 9k (was 1.90), which is plausible for a 600 cc four.
- **The drivetrain efficiency (0.85) is an assumption** and trades directly against this level. §5 fits it instead.
- **First-pass verification run** (`run4.csv`, config CAL2):

| config | r / slope vs MAP-VE | intake Δp RMSE | dyno RMSE 6-12.5 | 6-8.5 | 7-11.5 | 10.5-12.5 | bias | dyno-T r |
|---|---|---|---|---|---|---|---|---|
| sdm26_asbuilt_realtune (0034) | 0.80 / 0.29 | 2.85 kPa | 2.78 | 2.77 | 2.36 | 3.02 | −0.10 | 0.65 |
| first pass (CAL2: η_comb 0.98, FMEP ×0.775, drivetrain 0.85) | 0.81 / 0.65 | 0.50 kPa | 2.18 | 2.57 | 1.76 | 2.05 | −0.29 | 0.71 |
| **shipped `sdm26_asbuilt_cal` (§5)** | **0.82 / 0.62** | **0.49 kPa** | **2.01** | **2.50** | **1.69** | **1.80** | +0.04 | 0.64 |

## 5. Drivetrain-efficiency refit and linearity (`scripts/dtfit.py`, `fig_dt.py`)

- **The refit.** Engine level is back to the shipped values (combustion efficiency 0.94, FMEP a/b/c 0.5/0.1/0.00075), which is the A_e94 run. Wheel power is modelled as a function of that brake power and speed, fitted to the dyno over 6-12.5k.
- **Loss models tested:**
  - a constant fraction;
  - a fraction plus a constant loss torque (bearing, seal, chain and tyre drag, so the loss grows ∝ω);
  - a fraction plus ω² or ω³ loss (windage, tyre on the roller);
  - a fraction plus ω + ω²;
  - a constant power offset.

| wheel-power model (500 rpm dyno grid, n = 14) | fitted | RMSE | leave-one-out RMSE | BIC |
|---|---|---|---|---|
| **η·Pb (constant, linear)** | **η 0.938** | 2.01 | **2.14** | **22.1** |
| η·Pb − c1·ω | η **1.05** (unphysical), c1 4.9 | 1.94 | 2.21 | 23.8 |
| η·Pb − c2·ω² | η 0.985 | 1.92 | 2.21 | 23.6 |
| η·Pb − c3·ω³ | η 0.970 | 1.91 | 2.19 | 23.4 |
| η·Pb − c1·ω − c2·ω² | η 0.970, c1 < 0 | 1.92 | 2.52 | 26.2 |
| η·Pb − c0 | η 0.893, c0 < 0 | 1.99 | 2.51 | 24.5 |

- **The linear model wins on both cross-validation and BIC.** Restricting the fit to 7-12.5k gives the same ranking.
- **The raw 25-rpm dyno trace (n = 261) prefers the extra terms**, but its points are strongly autocorrelated, which inflates n. The fits it prefers are unphysical (η 1.05-1.22).
- **The extra terms only tilt the implied efficiency from about 0.96 at 6k to 0.92 at 12k.** The residuals are dominated by the engine's peak shape (6k, 8.5k), not by a smooth speed trend (`fig_drivetrain.png`).
- **Why the dyno can't settle it:** a speed-dependent drivetrain loss has the same functional form as engine friction. Friction power is FMEP·Vd·ω/4π with FMEP = a + b·sp + c·sp², so it scales as ω, ω² and ω³. Any such term is indistinguishable from an FMEP change. Separating them would need a coast-down/loss run on the dyno or a motored FMEP measurement.
- **0.94 is an effective value.** It is at the high end for a chain-drive chassis dyno (component estimates give about 0.89-0.93), so it probably also absorbs a slightly high stock FMEP. It replaces the unphysical need for η_comb = 1 in §3.

| config | dyno RMSE 6-12.5 | 6-8.5 | 7-11.5 | 10.5-12.5 | bias |
|---|---|---|---|---|---|
| §3 first pass (η_comb 0.98, FMEP ×0.775, drivetrain 0.85) | 2.18 | 2.57 | 1.76 | 2.05 | −0.29 |
| **§5 shipped (η_comb 0.94, stock FMEP, drivetrain 0.94)** | **2.01** | **2.50** | **1.69** | **1.80** | **+0.04** |

- **Airflow results are nearly unchanged:** MAP-VE r 0.82, slope 0.62 (first pass 0.81 / 0.65).
- **Torque-shape correlation is lower:** 0.64, against 0.71 for the first pass.
  - Combustion efficiency 0.98 raised torque more at 8-9.5k than elsewhere, because the rich logged λ interacts with the O2-limited burn.
  - So combustion efficiency is not a pure level knob.
  - The shipped fit still wins on every RMSE band, and its η_comb stays physical.

![drivetrain](fig_drivetrain.png)

## 4. What is still wrong

1. **Peaks are about 250 rpm late:** the model has 6.25k / 9.0k against the car's 6.0k / 8.75k. The broad 9-10k shoulder over-reads MAP-VE slightly.
2. **The dyno's torque peaks are sharper than the model's.** The model under-reads 6.0k by about 7 N·m and 8.25-9.5k by 2-5 N·m, and over-reads 6.5-7.5k by about 1.5 N·m. Part of this is the remaining amplitude gap (slope 0.62).
3. **Below 5.5k** the dyno is written off (the README calls it a pull-settle artefact), so it was not scored.
4. **The strongest remaining levers are unmeasured:** exhaust valve lift and Cd, and EVO at real lash. A flow-bench Cd/lift curve for the exhaust valve and a measured exhaust cam profile would do more than any further modelling. So would a baro logger channel or a key-on baro reading, and head port lengths.

## Model support added

- `physics.pipe_friction_multiplier`, `physics.pipe_heat_transfer_multiplier` and `physics.exhaust_heat_transfer_multiplier` (default 1.0; commits 515c4d78, afcce638). These are diagnostic knobs and are unused by the new config.
- `sdm26_asbuilt_cal.json` is registered in `cfd_list_examples`. It is in the warning-free/validation lists of engine-sim and cfd-core, and the desktop crate compiles (`cargo check`, 2026-09-29).
- `references/ecu/ve_map_reference.csv`, `ve_map_sensitivity.csv` and `scripts/mapve.py`.

## Reproducibility

- `scripts/gen.py` writes the configs. `make("x", losses=False, afr_wot=True)` plus `drivetrain_efficiency = 0.94` reproduces the shipped `sdm26_asbuilt_cal.json`, apart from its name and description. That run is `A_e94`, which the shipped config reproduces bit-for-bit at 9k.
- `scripts/dtfit.py` runs the drivetrain linearity test and `fig_dt.py` draws `fig_drivetrain.png`. Set `SDM_DYNO_RAW` to the raw Dynojet `SDM.CSV`.
- `run1.py`, `run3.py` and `run4.py` run the sweeps (`HUNTEXP` = the 0035 driver built on this branch). `levelfit.py` does the offline η × FMEP fit, and `fig36.py` draws the figure.
- `scripts/lib.py` is the 0035 scoring plus `analyze5` (MAP-VE, intake Δp, de-biased RMSE).
- `experiments/*` are the as-run scripts of the six experiments. They point at the session scratch directory and are kept as a record.
- All model rows are in `model_rows.csv`.
