---
id: 28
slug: dyno-rmse-recalibration
status: SHIPPED
topic: Python parity retired as a constraint (v4.3.3 mandate); recalibrated the Rust solver defaults to minimize banded wheel-power RMSE against BOTH real team dynos. Winner = production knobs + van Leer/CFL 0.5 numerics + flat-top cam lift + low-Re valve Cd + collector reflection 0.15 + eta_comb 0.94. SDM26 WOT RMSE 4.40 -> 2.56 kW (-42% vs production, -56% vs legacy); SDM25 6.02 -> 4.54 kW; both high-RPM bands roughly halve. Shipped as SDM26Config::calibrated() + the app configs' physics section.
hypothesis: The remaining model-vs-dyno gap is dominated by (a) numerical dissipation (always-minmod + CFL 0.85 damping the runner/header acoustics that drive high-RPM VE) and (b) validated-but-disabled physics (flat-top lift, low-Re Cd, collector reflection) kept off only for Python parity. Enabling them and re-trimming one combustion knob should cut banded RMSE on BOTH engines without per-engine fitting.
opened: 2026-06-10
closed: 2026-06-10
owner: physics-investigator
spawned_by: Nick 2026-06-10, v4.3.3 physics-accuracy mandate ("not worried about python parity AS LONG AS the new rust solver is more accurate")
commit_hash: ~
baseline_fingerprint: v4.3.2 (3776652)
revalidation_count: 1
acceptance_approved_at: 2026-06-10
---

## Method

Staged variant matrix on BOTH engines (C10 anti-overfit guard), 19 RPM
points (4500-13500 x 500), 30 cycles, characteristic junction, scored as
banded wheel-power RMSE/bias (sim brake x 0.85) against the real team
dynos from finding 0018. Stages: numerics (limiter/CFL) -> valve physics
(flat-top lift + low-Re Cd) -> collector reflection {0.10/0.15/0.30} ->
bias trims (eta_comb / mach_k / AFR-eta). 27 variants total; see
`run.py`, `analyze.py`, `summary.csv`.

## Result (wheel-power RMSE / bias, kW)

| Band | legacy | production (0021) | **0028 shipped** |
|------|-------:|------------------:|-----------------:|
| SDM26 WOT 6-13.5k | 5.80 / +0.51 | 4.40 / +1.47 | **2.56 / +1.04** |
| SDM26 peak 7-11.5k | 4.85 / +3.20 | 4.53 / +3.11 | **2.71 / +1.48** |
| SDM26 high 10.5-13.5k | 7.68 / -0.90 | 5.13 / +0.74 | **3.34 / +2.13** |
| SDM25 WOT 6-13.5k | 6.54 / -0.79 | 6.02 / +0.28 | **4.54 / -0.10** |
| SDM25 peak 7-11.5k | 3.25 / -1.46 | 3.01 / -0.77 | **2.81 / -1.95** |
| SDM25 high 10.5-13.5k | 7.51 / -6.19 | 5.63 / -5.39 | **3.08 / -2.41** |

Both engines improve in every WOT/high band -> no C10 violation. The
dyno's high-RPM power plateau (the 12.5k recovery both dynos show, which
legacy physics misses entirely) is now reproduced; see
`fig_0028_calibration_vs_dyno.png`. The "shipped" rows were re-verified
end-to-end through the actual app config JSONs (no overrides), matching
the winning variant to the digit.

## Shipped knob set (delta from production)

- `limiter = 1` (van Leer), `cfl = 0.5` — the dead-knob fix made the
  limiter selectable, but the default was still minmod @ CFL 0.85: the
  most dissipative legal combination. Less dissipation = stronger runner/
  header waves = the high-RPM VE the dyno shows. NOT a fitted knob — this
  is numerics quality with literature-standard values.
- `intake/exhaust_lift_flat_top_ramp = 0.25`, low-Re Cd correction ON
  (finding 0015): real cam profiles dwell near max lift; sin^2 understates
  mean effective flow area.
- `exhaust_collector_reflection_coef = 0.15` (finding 0007): partial
  open-end reflection at the collector exit. 0.15 beat 0.10/0.30 on the
  two-engine score; the valve stack alone over-predicts (+6 kW bias) —
  the two ship together or not at all.
- `eta_comb = 0.94` (was 0.96): single bias trim, physically motivated —
  combustion efficiency at AFR 13.1 (rich) is 0.93-0.95 in Heywood; 0.96
  was an optimistic stoich-adjacent value.

Rejected: two-zone default-on (+8.8 kW bias — needs its own heat-loss
re-calibration first), AFR-eta default-on (double-counts the eta_comb
trim), mach_k > 0.10 (re-introduces the 0021 SDM25 over-fit), Superbee
(no gain over van Leer, more aggressive).

## Where it lives

- `SDM26Config::calibrated()` (`crates/engine-sim/src/model/sdm26.rs`) —
  `default()` stays frozen as the Python-parity baseline so the entire
  kernel parity suite still runs untouched.
- App configs `apps/desktop/src-tauri/resources/cfd/configs/sdm2{5,6}.json`
  (`physics` section + `combustion_efficiency` 0.94), readable because the
  loader's optional `physics` section now covers the numerics/valve/
  exhaust knobs.
- The UI now compares wheel-to-wheel (a chassis dyno measures downstream
  of the driveline; the old on-screen RMSE compared sim BRAKE power to
  wheel dyno data and silently flattered the sim by ~15%), shows the
  banded agreement on the Performance screen, and can score events on the
  MEASURED dyno curve (`torqueCurveFromDyno`) — zero engine-model error
  for as-built scoring.

## Caveats / next

- Below 6k both dynos read far under every model variant (closed-throttle
  / run-in artifacts in the dyno data, finding 0018) — excluded from
  scoring bands, same as 0021.
- SDM26 retains a +1-2 kW optimistic bias in the peak band; the honest
  next step is exhaust wall-temperature + Woschni joint calibration, not
  another global trim.
- Two-zone + knock-aware combustion remains the right long-term model;
  re-calibrate its heat split before defaulting it on.
