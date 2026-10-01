# Brief for the Fluent agent: what the 1D intake study (finding 0039) needs from CFD

Goal: Fluent and the 1D engine model should agree on two restrictor numbers. Fluent should also check what the 1D model cannot see. Everything below uses the 1D study's definitions, so results drop straight in.

## Conventions (please match)

- **Angles** are half-angles (wall to centreline). 5° half = 10° included.
- **Throat** is 20 mm.
- **Ambient:** p0 = 97 kPa total (Phoenix baro, range 96.8-97.8), T0 = 300 K, air as an ideal gas.
- **Ideal choked flow** through the throat at those conditions is 0.0711 kg/s. The model uses Cd 0.95, giving 0.0675 kg/s.
- **Runner lengths** are measured from the head flange (engine/port excluded; today's runner = 248 mm).

## 1. The two numbers the 1D model consumes (highest priority)

For each geometry, sweep outlet (plenum) static pressure from about 0.55 to 0.99 of p0 and report mass flow, so the whole curve from unchoked to choked is captured.

1. **Throat discharge coefficient, Cd** = choked mass flow / 0.0711 kg/s (ideal isentropic choked flow at p0, T0).
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
