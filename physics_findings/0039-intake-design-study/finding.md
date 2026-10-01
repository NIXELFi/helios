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

4. **Restrictor: cut it roughly in half for free.** Wall friction included (Idelchik), a 5° half-angle (10° included) diffuser to a 36 mm outlet, about 121 mm total, matches the as-built 228 mm venturi. 38 mm/5° (133 mm) is +0.2 %. 34 mm/8° (80 mm) costs -0.9 % top end. Below about 70 mm the loss climbs fast (dump: -11 %).
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
