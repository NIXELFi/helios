# Exp4 brief: why our 1D model may have about 1/6 of the car's in-phase VE ripple (literature scan, 2026-09-29)

The target problem: the car's VE ripple and dyno torque ripple are both 8.7 % std. The model's is 3.0-3.4 %, and the regression slope of model VE on car VE is 0.16.
The model phase is roughly right. The model is either over-damped or under-driven.
Tags: [lit] means from a source, [ours] means our inference, [code] means something in helios engine-sim.

## Ranked by likely impact

1. **Numerical amplitude loss in the pipes (limiter clipping of the blowdown and suction peaks).**
   - [lit] Finite-volume TVD / FCT schemes add local dissipation at sharp gradients by design. OpenWAM's authors (Payri, Galindo, Serrano, Arnau) compared high-resolution schemes on exactly this trade-off.
   - [lit] Winterbone & Pearson (*Theory of Engine Manifold Design*) prefer FV over MOC for accuracy, but amplitude still depends on the scheme.
   - [ours] 0032 checked grid convergence on VE / torque levels, not on ripple amplitude.
   - [ours] A steep blowdown front crossing about 1.3 m of pipe with van Leer MUSCL at about 9 mm cells can lose a real part of its peak.
   - [code] `physics.use_weno5_in_pipes` and `limiter=2` (superbee) already exist, so this test is cheap.
   - Refs: https://openwam.webs.upv.es/docs/ ; https://www.researchgate.net/publication/245371601
2. **The restrictor boundary as a wave absorber (the quasi-steady venturi with a loss).**
   - [lit] UMN FSAE coupled WAVE-VECTIS at 14k rpm: the 20 mm throat was choked about 60 % of every cycle, and "not completely choked even at 90 % of redline".
   - [lit] The same study found the time-averaged total-pressure drop "did not correlate with VE". The pulsed restrictor matters dynamically, not as a mean loss.
     Source: Claywell, Horkheimer, Stockburger (UMN), https://www.realis-simulation.com/documents/university-of-minnesota-fsae_coupled-wave-vectis-simulation-of-an-intake-restricted-engine.pdf
   - [ours] A throat that is momentarily choked is an acoustically hard (reflective) end for the plenum.
   - [ours] A quasi-steady inlet with a diffuser-loss term (our 0032 venturi) acts as a partly absorbing termination. That would damp the plenum/runner system resonances, which are the ripple.
3. **Quasi-steady valve Cd under strong pulsation.**
   - [lit] Brahma 2019: measured pulsating-flow Cd ranged 0.60-0.90 on the engine against the steady 0.60-0.62, and 0.25-0.60 at low Re.
   - [lit] The Cd shift is driven by the pulsation amplitude relative to dynamic and mean Δp, not by the Strouhal number.
   - [lit] Quasi-steady 1D codes mis-estimate flow under strong pulsation.
     Source: Brahma, Front. Mech. Eng. 5:25 (2019), https://www.frontiersin.org/journals/mechanical-engineering/articles/10.3389/fmech.2019.00025/full
   - [lit] Counterpoint: over the normal speed range, steady-flow Cd "predicts dynamic performance with reasonable precision" (ENCIT 2012, https://abcm.org.br/anais/encit/2012/links/pdf/ENCIT2012-158.pdf).
   - [ours] This is a medium candidate. The lift and Cd tables in our config are unverified (0034), which may matter more.
4. **Multidimensional junction and plenum effects (1D under-spreads).**
   - [lit] UMN: coupled 1D-3D gave a larger cylinder-to-cylinder VE spread than WAVE alone, with the same 1-4 / 2-3 grouping as our car. 1D-only under-predicts the variation.
   - [lit] "Placement of bends can still have a large impact on intake tuning."
   - [lit] Bassett, Pearson, Fleming & Winterbone, SAE 2003-01-0370: the directional pressure-loss junction, validated on a shock tube and on a high-performance four-cylinder engine (https://www.sae.org/publications/technical-papers/content/2003-01-0370/).
   - [ours] Our 0035 momentum merge is this model class. It raised shape r, but its effect on amplitude was small. The plenum-runner junction remains a constant-pressure node.
5. **The exhaust blowdown drive (the EVO pressure and pulse temperature).**
   - [lit] Caton & Heywood 1981 (Int J Heat Mass Transfer 24(4):581-595): exhaust-port heat transfer is dominated by large-scale motion, and one steady correlation is not accurate.
   - [lit] Rapid cooling during early blowdown is attributed to mixing and choked-valve flow.
   - [lit] Pulsating-flow Nusselt enhancement is 1.05-1.35 for real valve profiles, and up to about 3× at high velocity-amplitude ratios.
     Sources: https://www.sciencedirect.com/science/article/abs/pii/S1359431119336981 and https://www.researchgate.net/publication/225734132
   - [ours] More wall heat loss damps the pulses, so this does not fix under-amplitude.
   - [ours] What sets the pulse amplitude is the cylinder pressure at EVO. If the Wiebe / Woschni settings under-predict p_EVO, the exhaust pulse is weak everywhere.
6. **Friction.**
   - [lit] Winterbone & Pearson use a friction multiplier for extra momentum losses.
   - [ours] Unsteady-friction models add damping.
   - [ours] Our Blasius smooth-pipe friction is already the low-damping end, so this is an unlikely cause of under-amplitude.

## FSAE / 600cc context (numbers)

- **fsae.com user report on WAVE vs dyno:** "similar local peaks and troughs", but WAVE was shifted about 1000 rpm high and read about 10 % low.
  - The rpm-shifted but same-shape pattern echoes our dyno-vs-ECU axis offset.
  - Source: https://www.fsae.com/forums/archive/index.php/t-10982.html
- **Typical 1D-vs-test accuracy:** ±5 % is achievable with good inputs, and up to 15 % is common with limited data (Honda 600 FSAE WAVE/GT-Power study, https://trid.trb.org/view/1803273).
  - One GT-Suite FSAE DoE study reported a maximum VE divergence of 6 % against the dyno.
- **Early-stage calibration:** Ammendola et al. (E3S 2020, UNINA FSAE) calibrated a 1D model to WOT torque with only a few tests, using Pareto optimisation over the calibration parameters (https://www.researchgate.net/publication/346370052).
- **4-2-1 vs 4-1:** the practitioner consensus is that a 4-2-1 is smoother with more but smaller tuning points, and a 4-1 is peakier.
  - I found no restricted-CBR600 A/B dyno data.

## Lambda-lag sanity check (our 90 ms WOT / ~300 ms overrun)

- [lit] Transport delay is set mainly by exhaust mass flow. At high rpm / high load, the sensing element's own response dominates.
  - ECUs model lambda delay against rpm / load, and the Link G4X (the car's ECU) has lambda delay compensation.
  - Sources: https://www.hpacademy.com/forum/general-tuning-discussion/show/transport-delay/ ; https://www.aemelectronics.com/blog/post/all_about_widebands/ ; https://forums.linkecu.com/topic/18235-wideband-lambda-delay-compensation/
- [lit] LSU 4.9: t90 is quoted as "well under 150 ms", and controller update rates are about 20 ms (vendor pages; the Bosch datasheet is https://www.bosch-motorsport.com/content/downloads/Raceparts/Resources/pdf/Data%20Sheet_69034379_Lambda_Sensor_LSU_4.9.pdf).
- **Verdict:** 90 ms at WOT and 10.8k rpm, and about 300 ms on low-flow, cold overrun, are both physically consistent. The 0035 conclusion stands.
  - Worth checking: the G4X's own lambda delay table.

## Three experiments to run next in our code

1. **Numerics amplitude test.** Run AB_ex / M_LL1_G130 at 12 points across 6-10k in four configurations: baseline van Leer; `physics.limiter=2`; `physics.use_weno5_in_pipes=true`; and 2× `n_points` on every pipe.
   - Metric: the ripple std over 5.5-10k and the regression slope on `proxy_wotA`.
   - If the slope rises from 0.16 toward 0.3 or more, numerical diffusion is part of the gap.
2. **Restrictor impedance test.** At 8k, compare the plenum pressure-oscillation amplitude and the VE ripple for three restrictor boundaries:
   - the 0032 venturi (as now);
   - a lossless isentropic nozzle;
   - a closed or reflecting end, as a bound.
   - If the ripple grows, re-model the restrictor's dynamic reflection (the choked fraction of the cycle) instead of a steady loss.
3. **Blowdown and valve-drive audit.** Log p_EVO and the peak port pressure against rpm, and check them against about 4-6 bar at WOT.
   - Then scale the exhaust Cd ×1.15 and the intake Cd ×1.10 (the Brahma-type pulsating-Cd uplift) and measure the ripple slope.
   - Growth with the right phase would point at the drive (valve flow), not at damping.
