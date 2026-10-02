---
id: 39
slug: intake-design-study
status: INVESTIGATED
topic: Full SDM26 intake design study on a grid-converged plenum - plenum volume/shape, runner length, VRLI (telescoping, in-plenum), restrictor venturi length/angle/Cd, throttle tip-in - scored on dyno bands and four real on-throttle duty cycles under the team's packaging limits.
hypothesis: Within the packaging the team has (runners no longer outside the head flange, plenum may grow, restrictor must get much shorter) there is a design that meets VRLI P1 (+5 % avg torque 6-12k) robustly across real driving.
opened: 2026-09-30
closed: ~
owner: physics-implementer (Claude)
spawned_by: Nick 2026-09-30 (resume of the 09-29/30 overnight session lost to a crash; "we can go bigger plenum", "we need to shorten our restrictor pretty significantly")
baseline_fingerprint: feat/vrli-tool @ 7a8e40d6 (sdm26_asbuilt_cal, neutral tune), plenum_n_cells = 160
---

## TL;DR

1. **The 20-cell plenum was not grid-converged.** Every earlier run (0036 calibration, 0037 VRLI, 0038 UQ) used 20 cells for a bell that flares 38 -> 167 mm (260 mm at 3.5 L) in 120 mm. The 3.5-vs-1.44 L top-end delta went -4.6 % -> -0.2 % at 12k from 20 -> 320 cells (`diag/plenum_cells.py`), and absolute torque at 9-12k moved about 1.5 N·m. Runner-length effects move < 1 pt (`diag/runner_vs_cells.py`), and the runner mesh (40 cells) is converged (`diag/runner_cells.py`). This study reruns everything at 160 cells (within about 0.5 % of the limit). **0036/0037/0038 should be re-checked on a 160-cell plenum.**
2. **A static intake cannot do much inside the envelope:** at most about +1 % (bigger plenum, 2.75-3.5 L). A bigger plenum is a small, consistent gain (+0.6-0.8 % 6-12k), mostly at 8-10k, not at the top end in 1D.
3. **VRLI with the trumpets telescoping INSIDE the plenum (CDR Concept A) meets P1 robustly:**

| design (runner above head flange; +80 mm port) | box | 6-12k | driver 7-10.5k | 4 real duty cycles | worst of all scores* |
|---|---|---|---|---|---|
| **248 -> 398 mm, 150 mm stroke** | **2.75 L** | **+6.2 %** | +6.2 % | +5.6..+6.0 % | **+5.6 %** |
| 248 -> 398 mm, 150 mm stroke | 3.5 L | +6.7 % | +6.7 % | +5.8..+6.5 % | +5.8 % |
| 248 -> 398 mm, 150 mm stroke | 1.44 L | +5.3 % | +4.8 % | +4.8..+5.3 % | +4.8 % |
| long end capped at today's 248 mm (shorten-only), 50 mm stroke | 3.5 L | +3.7 % | - | +2.5..+3.0 % | +1.7 % |
| long end capped at +40 mm, 125 mm stroke | 3.5 L | +5.3 % | +3.7 % | +3.4..+4.2 % | +3.4 % |
| best static (no VRLI) | 2.75-3.5 L | +0.6-0.8 % | - | +0.2..+1.0 % | +0.2 % |

\* worst over: 6-12k, 7-10.5k, the four duty cycles, and each duty cycle re-scored with the model's rpm axis shifted 4 % (0036: model features sit about 4 % late).

4. **Restrictor (SUPERSEDED by the Fluent addendum at the end: the short diffusers separate; a 120 mm restrictor costs about 0.8 % top end, not zero).** Original Idelchik-based estimate: cut it roughly in half for free. Wall friction included (Idelchik), a 5° half-angle (10° included) diffuser to a 36 mm outlet, about 121 mm total, matches the as-built 228 mm venturi. 38 mm/5° (133 mm) is +0.2 %. 34 mm/8° (80 mm) costs -0.9 % top end. Below about 70 mm the loss climbs fast (dump: -11 %).
5. **Throat Cd matters as much as the diffuser:** each 0.01 of Cd is about 0.3 % top-end torque (0.95 -> 0.99: +1.1 %; 0.95 -> 0.85: -3.6 %). A well-radiused converging side is the cheapest gain available.
6. **Bigger plenum costs throttle response:** time to 90 % torque after a snap from 40 kPa, 6000 rpm, as-built runner: 105 ms (1.44 L) -> 148 ms (2.75 L) -> 173 ms (3.5 L).

## Recommendation

**VRLI-in-plenum, 2.75 L box, runner 248 mm retracted -> 398 mm extended (150 mm stroke), plus a ~120-135 mm restrictor (5° half-angle, 36-38 mm outlet, radiused converging side).** 2.75 L keeps most of the 3.5 L gain (+6.2 vs +6.7 %) for about 25 ms less tip-in lag than 3.5 L. Mass at 150 mm stroke is about 1.3 kg on the CDR model (C2 limit 1.5 kg).

What it needs: a plenum tall enough for the travel (stroke + about 40 mm, i.e. about 190 mm, vs 120 mm today). A tall plenum costs about 0.5 % at 2.75 L in the 1D shape runs (double height, `04_plenum_shape.png`), so budget about +5.5-6 %.

## Data

- **Static grid G1:** 7 plenum volumes (0.5-3.5 L, bell diameters scaled) x 16 runner lengths (133-408 mm above flange) x 4000-12500 rpm in 500 rpm steps, neutral tune, 20 cycles (last 5 averaged), 160-cell plenum. 2016 points.
- **Plenum shape G2:** 0.75 / 1.44 / 2.75 L at half and double height.
- **Restrictor G3/G3b:** outlet 30-50 mm x half-angle 3.2-8°, and Cd 0.93/0.97, at 1.44 L (and 2.75 L for a subset), as-built runner. **G4:** torque vs venturi recovery R (0 = dump .. 0.572 as-built) at 1.44 and 3.5 L.
- **Throttle tip-in:** 92 runs, constant rpm (6000/8500), throttle snap from 40 kPa, 14 cycles.
- **Duty cycles** (`data/duty_*.csv`, on-throttle = TPS >= 60 %, rpm > 3000). No log in the vault has working on-power upshifts, so a synthetic cycle covers that:

| duty cycle | median on-throttle rpm | source |
|---|---|---|
| 4-16 driver selection | 5.5k | 20 MoTeC `.ld` files (`ld_reader.py`), single gear (2nd) |
| Josh AX 4-26 | 7.4k | G4X CSV; upshifts broken |
| 4-16, ideal shifting | 7.7k | synthetic: 4-16 speed traces re-driven in the best gear 1-3 on the dyno curve (`duty_cycles.py`) |
| 4-19 mock endurance | 8.6k | 49 s of full throttle only |

- **Scoring** (`candidates.py`): estimated wheel torque = calibrated sim today x the model's torque ratio vs as-built.
  - Duty-cycle score: time-weighted torque ratio.
  - VRLI: rate-feasible dynamic-programming schedule at 200 mm/s actuator and 3000 rpm/s sweeps, re-optimised per duty cycle (the ECU table is free).
  - Trumpets displace 40 mm-bore plenum air: 5.0 cm³/mm for four runners.

## Caveats

1. **The restrictor outlet-diameter trend in G3 is a 1D artifact.** After a small outlet, the plenum bell acts as a near-lossless second diffuser, so smaller outlets look better. Size the outlet from `11_restrictor_length.png` (G4 x Idelchik map); the angle trend at a fixed outlet is sound. Confirm the short venturi (and its Cd with the throttle plate upstream) in Fluent. `Downloads/restrictor_opt` has the Fluent pipeline, and its maps can replace the Idelchik recovery here.
2. **1D plenum.** Big-plenum benefits (runner-to-runner isolation, restrictor pulsation damping) are what a 1D pipe represents worst, so the top-end plenum effect is likely under-predicted.
3. **Model level.** The model carries about 0.62 of the car's airflow ripple (0036), so tuning gains are probably under-predicted. The rankings are the trustworthy part.
4. **Stroke.** The stroke cap is 150 mm (the grid edge at +160 mm); the VRLI gain has not saturated there.
5. **Quasi-steady VRLI transients** (0037 caveat 4).
6. **Tip-in** is at constant rpm, and fuel-film/ECU transients are not modelled.

## Reproducibility

- `runner.py` (detached, resumable, 15-min pushed checkpoints) runs `study.py` -> `tipin_study.py` -> `charts.py`.
- Then `restrictor_short.py` and `candidates.py`.
- `nothrottle.py --watch` must run alongside: Windows 11 EcoQoS otherwise holds the engine processes at 25 % of a core.
- Raw team logs (`data/ld_raw`, `ld_traces`, `josh_raw`) are gitignored.
- 20-cell results are kept in `results_c20.ndjson`.

## Addendum (2026-10-01): trade-off study inside the team's packaging limits

**Constraints (Nick):** the fully extended runner is at most 300 mm above the head flange (lengths exclude the port and engine; today's runner is 248 mm), and the stroke is at most 100 mm. Scripts: `vrli_stroke.py` (stroke sweep), `vrli_combos.py` (every combination: retracted 108-248 mm x stroke 0-200 mm x 4 boxes, 4546 designs, `charts/combos/combos_all.csv`) and `tradeoff.py` (`charts/tradeoff/`). Restrictor and throat-Cd effects are applied as per-rpm torque ratios (G4 recovery sweep with Idelchik + wall friction, and the Cd sweep).

**How the two ends work.** The **extended** length sets the midrange (7-10.5k) and with it the worst case. The **retracted** length sets the top end (10.5-12.5k): about +10 % when retracted to 150-190 mm, about +4.5 % when retracted to 248 mm. Inside the limits the 300 mm reach is the binding constraint: each 10 mm of reach is worth about 0.25 pts of worst case, and stroke beyond 100 mm adds about 0.1 pt at 300 mm.

**What matters most** (worst-case swing around the recommended package, `T1_what_matters.png`):

| knob | swing (pts) |
|---|---|
| VRLI stroke 0-100 mm | 3.1 |
| actuator speed 50 mm/s to instant (200 mm/s baseline) | 2.2 |
| placement of the 100 mm window | 2.1 |
| long-end reach 248-300 mm | 1.9 |
| restrictor length 60-228 mm (flat above ~120 mm) | 1.9 |
| throat Cd 0.90-0.99 | 1.3 |
| plenum box 1.44-3.5 L | 0.9 |
| ECU table per duty cycle vs single table | 0.2 |
| taller plenum 120 -> 140 mm (estimate) | 0.2 |

**Packages** (`T6_decision_table.png`):

| package | box | runner (mm, retracted -> extended) | restrictor | worst | 6-12k | mid | top | mass | plenum height | t90 |
|---|---|---|---|---|---|---|---|---|---|---|
| today | 1.44 L | 248 fixed | 228 mm | 0 | 0 | 0 | 0 | - | 120 | 105 ms |
| short restrictor only | 1.44 L | 248 fixed | 123 mm (38 mm outlet, 5.5°) | +0.0 | +0.1 | +0.1 | +0.1 | - | 120 | 105 ms |
| static, bigger plenum | 2.75 L | 233 fixed | 123 mm | +0.3 | +0.7 | +0.4 | +0.7 | - | 120 | 149 ms |
| VRLI 50 mm | 1.44 L | 248 -> 298 | 123 mm | +2.1 | +2.9 | +2.2 | +4.7 | 0.69 kg | 120 | 105 ms |
| VRLI 80 mm | 2.75 L | 213 -> 293 | 123 mm | +3.1 | +4.3 | +3.6 | +6.6 | 0.89 kg | 120 | 149 ms |
| VRLI 100 mm | 1.44 L | 198 -> 298 | 123 mm | +2.7 | +3.9 | +2.7 | +6.3 | 1.02 kg | 140 | 105 ms |
| **VRLI 100 mm (recommended)** | **2.75 L** | **198 -> 298** | **123 mm** | **+3.4** | **+4.8** | **+3.6** | **+7.8** | **1.02 kg** | **140** | **149 ms** |
| same, with a Cd 0.98 nozzle | 2.75 L | 198 -> 298 | 123 mm | +3.7 | +5.4 | +4.2 | +8.7 | 1.02 kg | 140 | 149 ms |

**Pick:** VRLI, 2.75 L box, runner 198 -> 298 mm (100 mm stroke), a 38 mm-outlet / 5.5° venturi of about 123 mm, and a well-radiused converging side (Cd about 0.98). That gives +3.7 % worst case and +5.4 % on 6-12k, so P1 is met on the dyno metric.
- **Fallbacks:** the 80 mm version (213 -> 293) if the plenum must stay 120 mm tall (-0.3 pt), or 1.44 L if throttle response outranks torque (-0.7 pt, t90 105 vs 149 ms).
- **Actuator:** do not go below 200 mm/s; at 100 mm/s about 1 pt is lost.

## Addendum (2026-10-01): direct simulation of the recommended intake, and lap time

**Setup** (`newintake_sim.py`, `newintake_report.py`, `charts/newintake/`). The recommended package was simulated directly, with no design-grid interpolation:
- 2.75 L box, VRLI 198 -> 298 mm above the flange, and the 40 mm-bore trumpets displacing plenum air in the engine (`vrli_trumpet_od` / `vrli_displacement_ref`).
- Venturi recovery 0.5746, i.e. the ~123 mm 38 mm / 5.5° venturi with wall friction included.
- Every trumpet position in 10 mm steps at every rpm, 4000-12500 rpm in 250 rpm steps, 160-cell plenum: 455 runs.

**Results** (gain vs today's intake):

| case | worst | 6-12k | 4-6k | 7-10.5k | 10.5-12.5k |
|---|---|---|---|---|---|
| 1st/2nd-gear sweep (200 mm/s actuator) | +3.5 % | +5.5 % | +3.3 % | +4.0 % | +8.3 % |
| slow sweep (steady ECU table) | +4.4 % | +5.9 % | +5.5 % | +4.4 % | +10.0 % |
| + Cd 0.98 nozzle (table) | +5.0 % | +6.6 % | +5.6 % | +5.0 % | +11.2 % |
| design-grid prediction (rate-limited) | +3.4 % | +4.9 % | +2.9 % | +3.7 % | +7.8 % |

- **The grid was right.** The design grid was accurate to 0.1 pt in the worst case and slightly conservative elsewhere. Individual rpm points differ by up to ~2.5 % between grid and direct runs.
- **Peak wheel power:** 63.0 -> 64.7 hp (65.4 with Cd 0.98).
- **The ECU table** retracts steadily from 298 mm (7.5-9k) to 198 mm (11-11.9k). It then jumps back to long above 12k, and that jump costs up to 8 % in fast sweeps. Cap the table short above ~11.5k.

**Lap time** (fsae-sim vehicle model, quasi-static lap bound from `car_envelope_curve.mjs --curve`; engine = team chassis-dyno curve x the direct-sim torque ratio):

| course | today | new intake | change |
|---|---|---|---|
| autocross, optimised line | 42.447 s | 42.314 s | -0.13 s (-0.12 rpm-offset corrected) |
| autocross, time-optimised line | 39.956 s | 39.735 s | -0.22 s (-0.24) |
| endurance, 2 laps, optimised line | 252.48 s | 251.63 s | -0.84 s (-0.75), i.e. ~-0.4 s/lap |

That is about -4 s over a ~10-lap 22 km endurance. The endurance time-optimised line was inconsistent (+0.25 / -0.12 s), so the endurance number carries about +-0.3 s.

## Addendum (2026-10-01): the new intake on real ECU logs, and the throttle-response trade-off

`real_ecu.py` drives the 198 -> 298 mm VRLI (direct 1D torque grids, 200 mm/s servo model) with every usable real session: Josh AX 4-26 (4 G4X logs), 4-16 driver selection (20 MoTeC runs, single gear), 4-19 mock endurance (6 runs). `real_ecu_compare.py` compares the 2.75 L box against today's 1.44 L box (`newintake_sim.py --box 1.44`, 455 more direct runs). Charts in `charts/real_ecu/`.

On-throttle torque gain vs today's intake (TPS >= 60 %, time-weighted):

| event | on throttle | median rpm | 2.75 L box | 1.44 L box | instant actuator (2.75 / 1.44) | best fixed runner in the box |
|---|---|---|---|---|---|---|
| AX 4-16 | 387 s | 5.9k | +1.9 % | +2.1 % | +4.2 / +4.3 % | +0.3 / +0.8 % |
| AX 4-26 | 60 s | 7.8k | +2.8 % | +2.7 % | +5.0 / +4.3 % | -0.1 / +0.3 % |
| endurance 4-19 | 48 s | 8.8k | +3.6 % | +3.1 % | +5.1 / +4.1 % | +0.2 / +0.4 % |

- **Real driving is harder on the actuator than the sim lap.** The 200 mm/s servo captures only about half of the instant-actuator gain. In the 2.75 L box, 400 mm/s gives +2.3 / +3.1 / +3.8 % and 800 mm/s gives +2.7 / +3.3 / +3.9 %.
- **Throttle response decides the box.** The tip-in runs give the 2.75 L box +15.9 ms (6000 rpm) / +10.6 ms (8500 rpm) of lost full-torque time per closed-throttle snap vs today; the 1.44 L box gives +2.6 / -0.1 ms.
  - Real logs contain about 50-80 snap-equivalents per on-throttle minute, with each re-application weighted by lift depth and by duration against a 0.18 s plenum drain time.
  - First-order time estimate, in seconds per on-throttle minute, with the extra speed discarded at every lift, 1st gear excluded and 300 kg effective mass:

| event | 2.75 L: torque gain / lag / **net** | 1.44 L: torque gain / lag / **net** |
|---|---|---|
| AX 4-16 | 0.51 / 0.36 / **+0.15** | 0.64 / 0.05 / **+0.59** |
| AX 4-26 | 0.29 / 0.19 / **+0.10** | 0.30 / 0.02 / **+0.28** |
| endurance 4-19 | 0.52 / 0.28 / **+0.23** | 0.46 / 0.02 / **+0.44** |

**Revised pick: keep today's 1.44 L plenum volume for the VRLI (198 -> 298 mm).** On the dyno bands the 2.75 L box is better (6-12k +5.9 vs +4.8 %, steady table), but on real driving the 1.44 L box nets 2-4x more time because it keeps today's throttle response. A faster actuator (400+ mm/s) is the next lever.

Caveats: the time estimate is first-order and the lag model comes from constant-rpm snaps off a 40 kPa manifold. No log has working on-power upshifts.

## Addendum (2026-10-01): Fluent restrictor results, and the retraction of "half the length for free"

A second Claude session ran the restrictor in Fluent 2026 R1: 2D axisymmetric, SST k-omega, 60 um rough wall, 97.3 kPa / 305 K, mesh-converged (400x80 vs 800x120 differ by 0.001 % in Cd). It followed `FLUENT_BRIEF.md`; its curves are in `C:/Users/nick5/restrictor_opt/data/restrictor_maps/brief_<NAME>.csv`. `fluent_ingest.py` fits the 1D venturi boundary (Cd, R) to each curve, using static pressure at the diffuser exit plane as the plenum pressure, and reruns the engine.

| geometry | length | Cd | R (curve fit) | fit rms | diffuser flow | top end vs A | 6-12k vs A |
|---|---|---|---|---|---|---|---|
| A: as-built, 38 mm / 3.2° | 228 mm | 0.974 | 0.724 | 0.08 % | attached, R flat at 0.72 | 0 | 0 |
| B: 38 mm / 5.5°, short nozzle | 120 mm | 0.979 | 0.679 | 0.51 % | separated everywhere | -0.8 % | -0.6 % |
| C: 36 mm / 5°, short nozzle | 117 mm | 0.979 | 0.683 | 0.35 % | attached only at light flow | -0.7 % | -0.5 % |
| D: 38 mm / 6°, short nozzle | 112 mm | 0.979 | 0.662 | 0.67 % | separated everywhere | -1.2 % | -0.8 % |
| E: 34 mm / 8°, short nozzle | 77 mm | 0.979 | 0.566 | 1.02 % | separated everywhere | -3.1 % | -2.1 % |

Torque columns use the ratio transfer to the car-fitted level: R_1D = 0.572 x R_CFD / R_CFD(A), Cd_1D = 0.95 x Cd_CFD / Cd_CFD(A).

- **Retraction.** The Idelchik-plus-friction estimate (B equal to A) was wrong: diffusers of 5° and steeper separate. The 120 mm restrictor costs about 0.8 % at the top end and 0.6 % on 6-12k. All of the loss is in the diffuser; the short 30° + 20 mm-blend nozzle has slightly better Cd than the long 8° cone.
- **The 1D venturi form is sound.** Two parameters reproduce the CFD curve of the attached geometry to 0.08 % rms. Recovery is constant with load for attached flow and falls with load for separated diffusers (B: 0.688 at light load, 0.648 near choke).
- **Open: the absolute gap.** Clean-flow CFD gives A a Cd of 0.974 and R of 0.724; the 1D model's car-fitted values are 0.95 and 0.572.
  - With the CFD values taken at face value, the engine makes +4.4 % at the top end and +2.6 % on 6-12k, as much as the VRLI.
  - Either the installation (throttle body, the plenum dump, pulsating flow) loses that, or the car fit absorbed another model error.
  - Pending from Fluent: the 3D throttle body, a plenum-dump case and a pulsating outlet.
- **Pending:** A's diffuser behind the short nozzle (about 191 mm), 4.0° and 4.5° diffusers (about 159 / 144 mm), smooth-wall variants, and a shape optimiser on the engine's operating range (p_exit/p0 0.85-0.95 at 10.5 / 11.5 / 12.5k).

**Wall roughness (Fluent A_SMOOTH / B_SMOOTH, same day).** The 60 um sand-grain wall is an assumed as-printed finish. Against a smooth wall it costs about 0.011 of Cd and 0.06-0.08 of R on either geometry.

| geometry | wall | Cd | R (fit) | top end vs rough A | 6-12k vs rough A |
|---|---|---|---|---|---|
| A (228 mm) | 60 um | 0.974 | 0.724 | 0 | 0 |
| A (228 mm) | smooth | 0.987 | 0.787 | +1.6 % | +1.0 % |
| B (120 mm) | 60 um | 0.974 | 0.679 | -0.8 % | -0.6 % |
| B (120 mm) | smooth | 0.989 | 0.757 | +1.0 % | +0.7 % |

Bore finish is worth about 1.8 % at the top end on the short restrictor, more than the length trade. A smooth 120 mm restrictor beats today's rough 228 mm one. The real bore finish is unmeasured: measure it, or smooth it and re-dyno.

**Stall boundary (Fluent A_NOZ and F, 2026-10-01).** Both use the short 30° + 20 mm-blend nozzle and stay attached across the engine's operating range.

| geometry | length | Cd | R (fit) | top end vs today | 6-12k vs today |
|---|---|---|---|---|---|
| A: as-built | 228 mm | 0.974 | 0.724 | 0 | 0 |
| A_NOZ: 3.2° diffuser, short nozzle | 186 mm | 0.979 | 0.745 | +0.5 % | +0.4 % |
| **F: 4.0° diffuser, short nozzle** | **154 mm** | 0.978 | 0.726 | **+0.2 %** | +0.1 % |
| B: 5.5° diffuser, short nozzle | 120 mm | 0.974 | 0.679 | -0.8 % | -0.6 % |

A 154 mm restrictor (4.0° half-angle to 38 mm, short nozzle) matches today's at 74 mm shorter. **G (4.5°, 140 mm) also stays attached at every unchoked point: Cd 0.977, R 0.712, -0.2 % top end and -0.1 % on 6-12k vs today.** The stall boundary lies between 4.5° and 5.5° (38 mm exit); while attached, R falls about 0.016 per half degree.

A licence outage on 2026-10-01 truncated the A_SHARP and N_12_20 sweeps (their header Cd values were invalid; both files were deleted). `fluent_ingest.py` now skips any sweep without a choked plateau.

**Intermediate roughness (Fluent A_KS20 / B_KS20, 20 um sand grain).** Going from 60 um to 20 um recovers about 60 % of the smooth-wall gain in R and about 70 % of the gain in Cd; the short restrictor B at 20 um matches today's A at 60 um. Engine numbers are in `charts/fluent/fluent_engine.csv`.

**Plenum dump (Fluent dump_A / dump_B) and the leading hypothesis for the gap.** Dumping the diffuser straight into a 167 mm bore does not change the restrictor's recovery (A: 0.717-0.722 at the exit plane, +0.01 referenced to plenum pressure). So the steady dump does not explain the car-fitted 0.572.

Leading candidate: **losses upstream of the restrictor**, which the 1D model does not have (it feeds the venturi ambient total pressure) and which a fit to plenum pressure books as poor diffuser recovery.
- For Fluent's clean A (Cd 0.974, R 0.724) to give the same plenum pressure as the car-fitted model at the same mass flow, the restrictor inlet must sit 2.5-3.3 kPa below ambient at 9-12.5k. That is a loss coefficient of about 1.4 on the 32 mm throttle-bore dynamic pressure.
- An air filter plus a WOT butterfly plausibly supplies much of that.
- **Test:** tap a pressure sensor between the throttle body and the restrictor throat and log it at WOT above 9k.
- If confirmed, the loss is recoverable (filter, throttle path) and worth up to about +4 % at the top end.
- Remaining candidates: pulsating flow and a bore rougher than 60 um.

**Reference moved to the car's actual part (Fluent A_CAD, 2026-10-01).** The as-built restrictor read from the team's CAD is worse than the cone stand-in A: Cd 0.965 on the 20 mm rule area and R 0.692, against 0.974 and 0.724.
- Its throat is 19.947 mm (0.53 % under the rule area), its land is 10 mm, and its diffuser's wall angle grows from 0 to 3.65°.
- All comparisons are now against A_CAD: R_1D = 0.572 x R/0.692, Cd_1D = 0.95 x Cd/0.965. The table is `charts/fluent/fluent_engine.csv`; the old one against A is `fluent_engine_refA.csv`.

Engine torque vs today's actual restrictor (60 um wall unless noted):

| geometry | length | top end 10.5-12.5k | 6-12k | diffuser flow |
|---|---|---|---|---|
| A_CAD: as-built | 228.5 mm | 0 | 0 | attached |
| A_NOZ: 3.2° + short nozzle | 186 mm | +1.5 % | +1.0 % | attached |
| F: 4.0° + short nozzle | 154 mm | +1.0 % | +0.7 % | attached |
| **G: 4.5° + short nozzle** | **140 mm** | **+0.7 %** | **+0.5 %** | attached |
| B: 5.5° + short nozzle | 120 mm | 0.0 % | 0.0 % | separated |
| C: 5° to 36 mm | 117 mm | +0.1 % | +0.1 % | attached only at light flow |
| D: 6° | 112 mm | -0.4 % | -0.3 % | separated |
| E: 8° to 34 mm | 77 mm | -2.3 % | -1.6 % | separated |
| B, 20 um wall | 120 mm | +1.2 % | +0.8 % | separated |
| B, smooth wall | 120 mm | +1.9 % | +1.3 % | separated, less |

The candidates assume a 20.000 mm throat against 19.947 mm on the as-built part. That is 0.53 % more area, but worth only about 0.15 % at the top end and 0.1 % on 6-12k (Cd sweep: +0.3 % per +0.01 of Cd), because the engine runs unchoked; Fluent's engine-match gives 0.07 %. The gains are shape, not throat size. (An earlier version of this note said 0.5 %; that holds only at full choke.)

**Inlet (Fluent, real Bosch bore from CAD, no plate or shaft).** The bare throttle-body mouth loses K = 0.19 on the 32 mm bore dynamic pressure, about 0.4-0.5 kPa at 53-60 g/s. The vault's slip-on bellmouth cuts that to K 0.07-0.08, worth +0.34 % airflow at the top end. The restrictor behind either is unchanged.
- This is about a sixth of the 2.5-3.3 kPa needed to explain the car-fitted recovery.
- The plate and shaft (3D case) or the 1D fit itself must account for the rest; the pressure tap between throttle body and throat is still the direct test.

**Throttle response cross-check.** A lumped fill model on the CFD restrictor curve gives the 2.75 L plenum +11.6 ms (6000 rpm) / +9.7 ms (8500 rpm) of lost time over 1.44 L, against +13 / +12 ms in the 1D tip-in runs. The volume penalty is confirmed.

**WITHDRAWN (rested on a CAD simplification; the real shaft is about plate-thin across the bore, 8-12 % blockage, K about 0.02-0.2). Original hypothesis: the throttle shaft is the upstream loss (not yet CFD).** The throttle-body CAD shows a full round 10 mm shaft across the 32 mm bore, so at WOT it blocks about 39 % of the bore (open area about 490 of 804 mm²; the restrictor throat is 312.5 mm²).
- A sudden-expansion estimate behind the shaft gives K = 0.4-1.1 on the bore dynamic pressure. With the mouth and bore (0.19 from Fluent) the total is 0.6-1.3, against the 1.4 needed to reconcile clean-flow CFD with the car-fitted recovery.
- If the 3D case confirms it, a slimmer or flattened shaft, a larger throttle body, or a different throttle type is worth more than anything left in the restrictor shape: up to about +3 % at the top end.
- No physical test (flow bench, pressure tap) is planned for now.

**Bore finish on the as-built wall (Fluent A_CAD_KS20 / A_CAD_SMOOTH).** The effect on the real part matches the stand-in. Engine torque vs today's part as-printed is in `charts/fluent/fluent_engine.csv` (rows A_CAD_KS20, A_CAD_SMOOTH); all three finishes stay attached in the operating range.

## Addendum (2026-10-01): the quasi-steady restrictor boundary, and an opt-in inertance

Fluent ran the as-built restrictor with a pulsating outlet (300 Hz, +-5 kPa around 0.92 p0). The real throat flow swings +-4.7 g/s and lags by more than a quarter cycle, and the cycle-mean flow is only 0.64 % below the steady flow at the mean pressure. A quasi-steady element on the same waveform loses 5 %.

The 1D model's venturi was exactly that quasi-steady element. `diag/plenumwave.py` samples the plenum cell at the restrictor exit: it pulses at firing frequency by +-2.7 to 6 kPa, and the boundary delivers 0.8-6.9 % less than the steady flow at the mean pressure (worst at 6-10.5k).

**Fix (engine commit 9ce7a4ba):** `physics.restrictor_inertance` (integral dx/A, 1/m) lags the venturi flow: I dmdot/dt = p_sustain(mdot) - p_plenum.
- The default 0 keeps the old path bit-identical.
- The geometric value needs no tuning: about 270 for the as-built diffuser and 400 for the whole venturi give a time constant of about 1.2 ms, against 1.25 ms implied by Fluent's amplitude ratio.

**Effect** (`diag/inertance_check.py`, 1.44 L box, VRLI 198-298 mm at its ECU table, I = 400):
- As-built torque moves -0.6..+1.1 % by rpm (+0.3 % on 6-12k).
- The VRLI gain is slightly larger with the inertia on:

| band | quasi-steady | inertial |
|---|---|---|
| 6-12k | +5.0 % | +5.3 % |
| 7-10.5k | +3.6 % | +3.9 % |
| 10.5-12.5k | +8.5 % | +9.2 % |

So every VRLI result in this finding stands and is slightly conservative.

This error lowers the model's plenum pressure at a given flow, so it cannot explain the car-fitted recovery being below CFD's; the old calibration absorbed it elsewhere. A recalibration of 0036 with the inertance on is the proper follow-up.

**The car's intake pressure drop, self-referenced (`diag/car_intake_dp.py`).** 0036 fitted the venturi recovery to baro - MAP with baro assumed 97.3 kPa. Check: Josh AX 4-26 (G4X, MAP at 200 Hz), engine-off MAP minus MAP at sustained WOT, 500 rpm bins.
- Engine-off MAP reads 97.0-97.2 kPa in all four sessions, so the assumed baro was right.

| rpm | car dp | 1D fit (0.95 / 0.572) | Fluent A_CAD (0.965 / 0.692) | A_CAD + bare inlet (K 0.19) |
|---|---|---|---|---|
| 7000 | 3.2 kPa | 3.3 | 2.3 | 2.5 |
| 9000 | 6.5 kPa | 6.8 | 4.7 | 5.1 |
| 10000 | 7.9 kPa | 7.5 | 5.2 | 5.6 |

- The car-fitted recovery reproduces on independent data: implied R is 0.55-0.60 over 6.5-10k (with the model's mass flow).
- The gap to clean-flow CFD is real: about 2 kPa at 9-10k, of which the bare inlet is about 0.4.
- **Leading candidate now: a bore rougher than the assumed 60 um.** On the as-built wall R falls 0.773 / 0.742 / 0.696 at 0 / 20 / 60 um; extrapolated, 0.57 needs roughly 170 um of sand-grain, which is plausible for printed layer lines across the flow. Fluent runs at 120 and 200 um are requested.
- If confirmed, finishing the bore is worth about +3 % at the top end, not +1.2 %.

**Two consistent readings of the car data (2026-10-01).** Throat undersize (printed about 19.8 mm) explains only 0.2 kPa of the 2 kPa gap, and bore roughness is unlikely to be much above 60 um (PPA-CF, 0.08 mm layers). The whole gap is equivalent to the car flowing 7-14 % more air than the model at 7-10k, with clean-flow recovery (Fluent, 19.8 mm throat, bare inlet).

| | A: as calibrated (0036) | B |
|---|---|---|
| airflow, 7-10k | model's (37-53 g/s) | +8-14 % (41-58 g/s, VE 1.05-1.10 atm-referenced) |
| venturi recovery | 0.572, cause unknown | about 0.70, as clean CFD |
| drivetrain efficiency | 0.94 | 0.82-0.87 at the same brake efficiency (fsae-sim uses 0.85) |
| fits dyno power and baro - MAP | yes | yes |

- 0036 fitted two numbers, recovery and drivetrain efficiency, and they trade against each other; dyno power and MAP cannot separate them.
- B needs the model to under-breathe by about 10 %. The model does not do that by itself: with R 0.69 it gains only about 3 %.
- **What would settle it:** fuel flow (injector pulse width and injector rating; the 4-26 CSV export has no pulse-width channel), a coast-down or driveline-loss measurement, or the pressure tap ahead of the throat.
- **What depends on it:**
  - The restrictor and VRLI rankings do not: they are ratios.
  - The absolute "+3-4 % available from the restrictor" exists only under A.
  - Under B the engine runs nearer choke at the top end (about 87 % of choked flow at 10k, against 77 %), so top-end gains from runner tuning would be smaller than modelled and the restrictor's Cd and recovery would matter more.
