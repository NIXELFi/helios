# Brief for the Fluent agent: what the 1D intake study (finding 0039) needs from CFD

Goal: Fluent and the 1D engine model should agree on two restrictor numbers. Fluent should also check what the 1D model cannot see. Everything below uses the 1D study's definitions, so results drop straight in.

## Conventions (please match)

- **Angles** are half-angles (wall to centreline). 5° half = 10° included.
- **Throat** is 20 mm.
- **Ambient:** p0 = 97.3 kPa total, T0 = 305 K, air as an ideal gas. These are the 1D model's own `p_ambient` / `T_ambient`. (Corrected 2026-09-30: an earlier version of this brief said 97 kPa / 300 K.)
- **Ideal choked flow** through the throat at those conditions is 0.0707 kg/s. The model uses Cd 0.95, giving 0.0672 kg/s.
- **Runner lengths** are measured from the head flange (engine/port excluded; today's runner = 248 mm).

## 1. The two numbers the 1D model consumes (highest priority)

For each geometry, sweep outlet (plenum) static pressure from about 0.55 to 0.99 of p0 and report mass flow, so the whole curve from unchoked to choked is captured.

1. **Throat discharge coefficient, Cd** = choked mass flow / ideal isentropic choked flow at p0, T0 (0.0707 kg/s at 97.3 kPa, 305 K).
   - The model assumes **0.95**.
   - Each 0.01 of Cd is worth about 0.3 % torque at 10.5-12.5k.
2. **Diffuser pressure recovery, R** = (p_plenum - p_throat) / (p0 - p_throat), static pressures, taken where the flow is just unchoked.
   - Equivalent check: choking begins at p_plenum/p0 = 0.528 + 0.472 R.
   - The model uses **R = 0.572** for the as-built venturi, so choke onset is at p_plenum/p0 of about 0.80.
   - The model predicts **0.575** for the short candidate.
   - Each 0.01 of R is worth about 0.2 % torque at the top end.

Best deliverable: a CSV per geometry with columns `p_out_over_p0, mdot_kg_s, p_throat_Pa, separated (y/n)`. The 1D model can take the mdot-vs-back-pressure curve directly.

## 2. Geometries to run

| # | Outlet | Half-angle | Diffuser | Converging side | Why |
|---|---|---|---|---|---|
| A | 38 mm | 3.2° | 161 mm | 8° from 36 mm (as built, 228 mm total) | baseline; anchors R = 0.572, Cd = 0.95 |
| B | 38 mm | 5.5° | ~94 mm | short radiused nozzle, r = 10-20 mm (~123 mm total) | **the recommended restrictor** |
| C | 36 mm | 5° | ~91 mm | same nozzle | 1D predicts equal to A |
| D | 38 mm | 6° | ~86 mm | same nozzle | separation margin |
| E | 34 mm | 8° | ~50 mm | same nozzle (~80 mm total) | 1D predicts -0.9 % top end; likely stall |

The 1D estimates use Idelchik's diffuser loss plus wall friction. If Fluent's R for B/C/D is within +-0.02 of A, the "cut the restrictor in half for free" conclusion stands.

## 3. What the 1D model cannot see (please check)

- **Separation / stall** in the 5.5-8° diffusers: wall shear sign, and where it starts. The 1D model assumes a clean conical diffuser.
- **The dump into the plenum:** total-pressure loss of the diffuser jet entering the plenum. The 1D plenum treats that expansion as nearly loss-free, which is a known artifact; it made small outlets look better than they are.
- **Throttle body upstream (3D):** the 32 mm butterfly at WOT just ahead of a short converging section. Does the plate wake lower Cd or trigger one-sided diffuser stall?
- **Pulsating back-pressure:** the engine pulls in pulses at 133-417 Hz (4 cyl, 4000-12500 rpm), and the 1D venturi is quasi-steady (no inertia in the diffuser air column). One transient case, with outlet pressure oscillating about +-5 kPa around a near-choke mean at about 300 Hz: is cycle-mean mass flow within about 1 % of the steady value?
- **Runner-to-runner distribution** in the plenum (flow split across the four trumpets), and whether a trumpet close to the plenum roof (fully extended, 298 mm) is starved. The 1D model joins all four runners at one node.
- **Bellmouth entry loss:** the model uses an entry loss coefficient K = 0.2 at the runner mouth.

## 4. Lower priority: plenum fill (throttle response)

The 1D tip-in runs say a 2.75 L plenum loses about 37 ms of full torque per closed-throttle snap vs 24 ms for today's 1.44 L (6000 rpm, from 40 kPa). That is why the study now recommends keeping 1.44 L. A transient fill through the restrictor from 40 kPa, for both volumes, would confirm or correct the ratio.

## 5. How we agree

- **Match:** Cd within +-0.01 and R within +-0.02 of the 1D values for geometry A.
- **If they differ:** Fluent's values win. The 1D study reruns with them (`study.make_cfg(R=..., cd=...)`, about 30 min), and both agents quote the rerun numbers.
- **If B/C/D separate or lose more than 0.02 of R vs A:** the recommended restrictor gets longer or shallower; report the shortest geometry that stays attached.

## Context

- **1D recommendation now:** VRLI 198 -> 298 mm runners in today's 1.44 L plenum volume, restrictor B, radiused converging side, fastest packageable actuator. Details in `finding.md` (this folder).
- **Existing Fluent tooling:** `Downloads/restrictor_opt` has a 2D-axisymmetric Fluent pipeline that already reports throat Cd; its `data/restrictor_maps/*.csv` are in a usable format.

## Addendum (2026-09-30): answers to the Fluent agent's questions

1. **Geometry A.** The model knows only: 36 mm inlet, 8° half-angle converging, 20 mm throat, 3.2° half-angle diffuser to 38 mm, 228 mm overall.
   - The converging cone (56.9 mm) plus the diffuser (160.9 mm) leave about 10 mm for the throat land and blends.
   - The as-built blend radii are not measured. Use a 10 mm land including blends, and run a sharp-vs-blended sensitivity on Cd.
   - The 32 mm throttle bore sits upstream of the 36 mm inlet.
2. **B-E converging side.** The 1D model has no converging geometry, only Cd; the length tables assume 25 mm converging plus 5 mm land.
   - Use one fixed nozzle for B-E so that only the diffuser varies: 30° half-angle cone, 20 mm blend radius into the throat, 5 mm land.
   - Treat the converging side as its own sub-study (cone 12/20/30°, blend 10/20 mm) and report Cd.
3. **Roughness.** The 1D friction term is smooth-wall (lambda = 0.014 at Re ~3e5). 60 um on 20 mm (eps/D = 0.003) roughly doubles it, which favours short diffusers further. Bracket A and B with smooth and 60 um walls.
4. **Where p_plenum is taken.** It is the static pressure at the diffuser exit plane: the venturi boundary fills the plenum's first cell, whose area is the diffuser outlet area. R = eta x (1 - sigma^2), with sigma = throat area / outlet area and eta = 0.62 (car-fitted).
   - A straight outlet pipe at exit diameter is the right domain for comparing R.
   - The plenum dump is a separate case (section 3).
5. **Objective.** Mass flow at the engine's operating back-pressure is the right objective; it weighs Cd and R correctly.
   - Sensitivity at 10.5-12.5k: about +0.3 % torque per +0.01 Cd and about +0.2 % per +0.01 R.
   - 1D operating points, baseline: mean p_plenum/p0 = 0.90-0.97 at 10.5-12.5k, with mdot = 0.051-0.057 kg/s (72-81 % of ideal choked).
   - 1D operating points, new intake: p_plenum/p0 = 0.91-0.94, mdot = 0.055-0.058 kg/s.
   - Weight p_out/p0 = 0.85-0.95.
   - VE (plenum-referenced) is about 0.90 at 10.5-12.5k. The model stops at 12.5k, so use 10.5 / 11.5 / 12.5k.

**The absolute recovery gap is the main thing to reconcile.** Clean-pipe CFD gives R of about 0.8 for a near-A geometry. Idelchik alone gives 0.87 for A. The 1D model's 0.572 is that 0.87 times a car-fitted factor of 0.657, from MAP-based intake pressure drop (findings 0036 and 0038).
- Either the installation loses about a third of the recovery (throttle body, dump, pulsation), or the fit absorbed another model error.
- A clean R of 0.8 on the car would be worth about +4 % at the top end, more than any other knob in 0039. The throttle-body, plenum-dump and pulsating-outlet cases in section 3 are therefore the highest-value runs.
- Until then, transfer CFD results as ratios: R_1D(geometry) = 0.572 x R_CFD(geometry) / R_CFD(A).
