# Next Agent Task List — Helios Physics Loop

**Branch:** `physics-fixes/math-corrections` at commit `6b4e6bc`
**Read first:** [`SESSION_HANDOFF.md`](SESSION_HANDOFF.md) (state of branch + production knob set + trust map + bugs already fixed)

This document is the **TODO queue** for the next agent. Tasks are
grouped by leverage and grouped roughly in the order you should
tackle them. Each task has: motivation, acceptance criteria,
implementation hint, estimated effort, and the source finding(s) it
came from.

---

## How to use this list

1. Read `SESSION_HANDOFF.md` end-to-end (it's <250 lines).
2. Pick a task from `Tier 1` if you have substantial time (~half a
   day each); pick from `Tier 2` or `Tier 3` for shorter pushes.
3. Each task closes a documented gap or extends a documented capability.
4. **Always preserve parity.** All 20 SDM25/SDM26 parity goldens must
   stay bit-exact green. Use opt-in flags (default OFF) for any change
   that would affect the existing test fixtures.
5. **Always run `cargo test --release -p engine-sim --test 'parity_*'`
   before commit.** If parity breaks, the change is wrong somewhere.
6. Write a finding doc in `physics_findings/NNNN-slug/finding.md`
   following the templates of 0005-0014.

---

## Tier 1 — Highest leverage (close known physics gaps)

### T1.1 — Low-RPM port-loss / pumping model

- **Motivation**: 0006/0007/0009 showed the simulator over-predicts BP
  by ~12 kW at 6000 RPM (implied drivetrain η = 0.52 — way below
  Cameron's 0.85 literature value). At low RPM the engine doesn't
  generate enough turbulence for the intake to fill efficiently, and
  real engines have higher pumping/throttling losses than the sim models.
- **Acceptance**: SDM26 implied η at 6 kRPM should land in [0.75, 0.95]
  on the production knob set, matching the literature drivetrain band.
  No degradation at peak RPM (η @ 10 kRPM should stay near 0.85).
  Spec C10 cross-cal: should also help SDM25.
- **Implementation candidates** (try in this order, single-knob-at-a-time):
  1. **Low-Reynolds Cd correction at the intake valve** — current
     `valve.rs:7-10` Cd(L/D) tables are steady-flow-bench data, no
     low-Re penalty. Heywood §6.2 + Frontiers 2019 give correction
     `Cd_eff = Cd · f(Re)` where `Re < ~10⁴` reduces Cd by 10-30%.
     File: `crates/engine-sim/src/cylinder/valve.rs` + `bcs/valve.rs`.
     Add opt-in `intake_valve_re_correction: bool` (default false).
  2. **Port wall friction**. Real ports have friction coefficient
     `f = 0.04-0.06` for engine-port roughness. The intake runner pipe
     in the sim has Reynolds-dependent friction (`pipe.rs`) but the
     SDM26 config sets `roughness = 4.6e-5` which may be too low. Try
     `roughness = 4e-4` and see if low-RPM BP drops in the right
     amount.
  3. **Manifold gas heat transfer at low RPM**. The sim has wall
     temperatures (`runner_wall_t = 320 K`) but the convective h
     scaling may under-model low-Mach heat transfer.
- **Effort**: 1-2 days for any of the three; full closure may need all
  three.
- **From**: 0006 §6, 0007 §residual gap, 0009 G3, SESSION_HANDOFF §5(2)

### T1.2 — Variable γ(T) per zone in two-zone combustion

- **Motivation**: 0010+0011 documented that `two_zone_enabled` shifts BP
  up uniformly by ~3 kW, making the model worse not better. Root cause
  per 0011 finding: constant γ=1.4 in the burned zone (T_b ~ 2500-2800 K)
  over-predicts expansion-stroke work because real γ ~ 1.25-1.3 at those
  temperatures. Burcat NASA-7 polynomials are already in the repo
  (`physics_findings/references/literature/burcat-nasa7-coefficients.md`).
  Implementing γ(T) would unlock `two_zone_enabled` as a defensible
  production default and likely close some residual gap at peak RPM.
- **Acceptance**: `two_zone_enabled` + variable γ(T) per zone gives
  RMSE ≤ single-zone baseline (currently 7.19 kW on the 8-12 kRPM band).
  Implied η at 10 kRPM stays at 0.85. C10 cross-cal: improvement on
  both SDM25 and SDM26 or no worse.
- **Implementation hint**: `crates/engine-sim/src/cylinder/combustion.rs`
  has the two_zone branch in the cylinder.advance() body. Look for
  `two_zone_active` blocks. Add a `gamma(T, composition)` function
  using NASA-7 coefficients for the 6 species we track (or just
  use a tabulated polynomial for the burned-gas mixture). Use γ_u(T_u)
  and γ_b(T_b) in the per-zone pressure-volume work and heat-loss
  calculations.
- **Effort**: 2-3 days (mostly implementing NASA-7 evaluation +
  wiring through the two-zone integration).
- **From**: 0011 conclusion + followup queue

### T1.3 — VVT (variable valve timing) for low-RPM realism

- **Motivation**: 0008/0009 noted that real CBR600RR has variable cam
  timing. The simulator uses fixed valve timing optimized for peak RPM,
  which over-fills the cylinder at low RPM (excess overlap = reversion).
  This is part of the +12 kW gap at 6 kRPM.
- **Acceptance**: Add `intake_valve_open_angle_low_rpm`,
  `intake_valve_open_angle_high_rpm`, `vvt_transition_rpm` fields to
  SDM26Config. Linearly interpolate valve open/close angles between
  the two RPM endpoints. Default behavior: low_rpm = high_rpm = current
  value (parity preserved). When enabled, low-RPM intake closes earlier
  → less overlap → lower VE at low RPM → closes some of the +12 kW gap.
- **Implementation hint**: `crates/engine-sim/src/cylinder/cylinder.rs`
  already has `intake_valve.open_angle_deg` etc. Make these RPM-aware
  via a method on ValveParams (mirror the pattern of
  `wiebe.spark_advance_at(rpm)` from 0006).
- **Effort**: 1 day.
- **From**: 0008 followup, 0009 G3, SESSION_HANDOFF §5(7)

---

## Tier 2 — Medium leverage (extends capabilities)

### T2.1 — Lean-misfire cliff fix (trivial)

- **Motivation**: 0009 G2 documented that `afr_eta_factor` barely
  engages at lean limit. At AFR=20 (φ=0.73), factor = 0.9955 — no
  practical effect. Real engines misfire here.
- **Acceptance**: After fix, `afr_eta_factor` at φ=0.7 (AFR=21) drops
  to ~0.5 (steep cliff); at φ=0.85 (AFR=17) drops to ~0.92 (mild).
  Matches Heywood Fig 4-7 shape. Existing tests still pass.
- **Implementation hint**:
  `crates/engine-sim/src/cylinder/combustion.rs` — `afr_eta_factor`
  method around line 130. Change the lean branch:
  ```rust
  if phi <= 0.6 {
      0.30  // hard misfire
  } else if phi <= 0.7 {
      0.30 + (phi - 0.6) * (0.85 - 0.30) / 0.1  // 0.30 → 0.85
  } else if phi <= 0.85 {
      0.85 + (phi - 0.7) * (1.0 - 0.85) / 0.15  // 0.85 → 1.0
  } else if phi <= 1.0 {
      1.0
  } else if phi <= 1.2 {
      1.0 - 0.5 * (phi - 1.0)
  } else {
      0.9 - 1.7 * (phi - 1.2)
  }
  ```
- **Effort**: 2 hours including test.
- **From**: 0009 G2, SESSION_HANDOFF §5(8)

### T2.2 — Knock-induced combustion derate (optional)

- **Motivation**: 0013/0014 made knock prediction a designer-facing
  diagnostic — `knock_integral > 1.0` flags but the sim doesn't
  derate. If the team wants the sim to AUTO-PROTECT (more like real
  engines with knock sensors + ignition retard), add a feedback path.
- **Acceptance**: Opt-in flag `knock_derates_combustion: bool` (default
  false). When true, reduce `eta_comb` by a Heywood-style empirical
  factor when `I_LW > 1.0`, e.g., `eta_factor = max(0.5, 2.0 / I_LW²)`.
  When false, behavior identical to today (parity preserved). Verify
  the BP curve drops cleanly when knock is predicted (no oscillation).
- **Implementation hint**: `crates/engine-sim/src/cylinder/cylinder.rs`
  — multiply `d_q_comb_dt` by the knock-derate factor in the advance()
  method. Use last cycle's `knock_integral_at_spark` (since the current
  cycle's hasn't been measured yet at the moment of combustion).
- **Effort**: half a day.
- **From**: 0013 followup, SESSION_HANDOFF §5(9)

### T2.3 — Spark-advance optimization with knock constraint

- **Motivation**: 0014 used the production MBT-map slope (1.5 °/krpm).
  At the C4 oversquare design with 110-oct fuel + CR=12, there's
  knock margin (I = 0.88, headroom to 1.0). The 0.12 margin could be
  spent on MORE spark advance to recover the last 0.5-1 kW of MBT.
- **Acceptance**: Sweep `spark_advance_rpm_slope_deg_per_krpm` ∈
  [1.0, 3.0] on C4+CR=12+oct110. Find the max slope where peak I < 1.0.
  Report the resulting peak BP gain.
- **Implementation hint**: Pure helios-bench sweep, no code change.
  Use the existing infrastructure. Output a finding documenting the
  knock-margin-bound MBT for SDM27.
- **Effort**: 2-3 hours.
- **From**: 0014 followup, 0008 implicit (MBT map slope was a literature
  estimate, not optimized).

### T2.4 — C4 prototype validation (when hardware available)

- **Motivation**: 0008/0014 recommend C4 (75-mm-bore oversquare) as
  the SDM27 winner. When a real prototype gets built, validate the
  +2.1 kW prediction (and the knock-margin predictions).
- **Acceptance**: Dyno-measured peak BP within ±3 kW of sim prediction.
  Knock behavior at the predicted boundary CRs matches.
- **From**: 0008 followup, 0014 followup, SESSION_HANDOFF §5(7)

---

## Tier 3 — Lower leverage / housekeeping

### T3.1 — Re-baseline production knob set at n_cells = 60

- **Motivation**: 0012 found that default `n_cells = 30` is ~1 kW
  under-resolved. The 0006/0008 conclusions hold at default resolution
  but the team should know whether the +2.1 kW C4-vs-C1 delta survives
  at higher resolution.
- **Acceptance**: Re-run 0008 candidate sweep at n_cells = 60.
  Recommendation ranking should not change. If it does, document
  the new ranking.
- **Implementation hint**: Add `runner_n_cells = 60` (etc.) to each
  0008 study TOML, re-run, re-plot. Pure sweep work, no code change.
- **Effort**: 2 hours.
- **From**: 0012 followup, SESSION_HANDOFF §5(8)

### T3.2 — Lower-octane real-world fallback validation

- **Motivation**: 0014 confirmed C4 at CR=10 + 95-oct is safe
  (I=1.00 right at the line). For teams that only have pump 91, verify
  CR=9 + 91-oct is safe.
- **Acceptance**: Run C4 at CR=9, oct=91 across the RPM band. If
  peak I < 1.0, confirm safe-for-pump operating point. If not,
  iterate down.
- **Effort**: 1 hour.
- **From**: 0014 followup, 0013 followup.

### T3.3 — Rich-AFR correction fine-tune

- **Motivation**: 0009 G1 / 0014 showed the rich-AFR Heywood-shape
  correction is somewhat aggressive — at φ=1.84 (AFR=8), factor=0.30
  vs literature ~0.50. Real engines lose ~50-60% of stoich BP at
  very rich, not 70%+.
- **Acceptance**: Re-fit the rich branch of `afr_eta_factor` against
  Heywood Tab 4.1 rich-region data. New shape should give:
  - φ=1.2: factor ≈ 0.90
  - φ=1.5: factor ≈ 0.70
  - φ=1.8: factor ≈ 0.50
- **Implementation hint**: same file as T2.1; change the rich branches.
- **Effort**: 2 hours.
- **From**: 0009 G1, 0010 followup.

### T3.4 — Apply_override completeness audit script

- **Motivation**: 7 of this session's 12 bugs (B6-B12) are the same
  failure mode — SDM26Config field exists but missing from
  apply_override. A simple programmatic check would prevent future
  recurrences.
- **Acceptance**: A script that compares every `pub` field in
  `SDM26Config` against the apply_override match arms + params table,
  and either reports missing entries OR flags them as
  intentionally-skipped (topology, arrays, tables — already documented
  in 0009 audit). Run it in CI or as a `cargo test`.
- **Implementation hint**: 0009's Python script in the analysis
  already does this (see commit history for the audit logic).
  Port it to a Rust test or shell script.
- **Effort**: 2-3 hours.
- **From**: SESSION_HANDOFF §5(9)

### T3.5 — Restrictor converging half-angle (B5 cleanup)

- **Motivation**: 0006 B4 fixed the `diverging_half_angle` being
  dropped from JSON loader. The `converging_half_angle` is still
  ignored. Effect is small (Idelchik for 12° converging cone:
  K ≈ 0.03) but should be wired through for consistency.
- **Implementation hint**: same place as B4 fix.
- **Effort**: 1 hour.
- **From**: 0006 B5 (noted but not done).

---

## Tier 4 — Solver-class changes (need user sign-off per spec §2)

### T4.1 — WENO third-order reconstruction in exhaust pipes

- **Motivation**: 0007 documented that the simulator's MUSCL-Hancock +
  HLLC pipeline damps sharp exhaust blowdown pulses too aggressively,
  so junction-based scavenging never gets to work. Even 4× n_cells
  doesn't close it (0012). Higher-order spatial reconstruction is the
  only known path to closing the −17 kW gap at 13 kRPM.
- **WHY THIS REQUIRES USER SIGN-OFF**: Per spec §2, changes under
  `crates/engine-sim/src/solver/` need explicit approval. Confirm
  before starting.
- **Acceptance**: Implement WENO5 (or equivalent) reconstruction in
  pipes (or just exhaust pipes if scoped). Verify sharp pulse
  propagation in a 1D shock-tube test. Re-run 0007 primary-length
  sweep; verify peak BP now shows sensitivity to primary length (real
  engines: 100mm primary change shifts peak RPM by 1-2 kRPM). Verify
  parity goldens still pass — they were generated with MUSCL-Hancock,
  so WENO would need a separate parity track or a config flag.
- **Effort**: 1-2 weeks for proper implementation + validation.
- **From**: 0007 conclusion + SESSION_HANDOFF §5(5).

### T4.2 — In-residual γ(T) for variable-γ chemistry

- **Motivation**: Same as T1.2 but extended to ALL γ usage in the
  solver (not just two-zone combustion). The HLLC Riemann solver and
  MUSCL-Hancock reconstruction both assume constant γ. Real combustion
  products have γ ~ 1.25; intake air has γ ~ 1.4. A per-cell γ(T,Y)
  evaluation would be more accurate but is a significant solver
  refactor.
- **WHY THIS REQUIRES USER SIGN-OFF**: Solver-class change.
- **Acceptance**: Per-cell γ(T) in the HLLC + MUSCL paths. Parity
  goldens at constant γ=1.4 must still hold. Variable-γ enabled by
  opt-in flag.
- **Effort**: 2-3 weeks.
- **From**: 0011 root-cause analysis, 0013 polytropic estimate uses
  hardcoded γ=1.33 (post-recalibration) — would benefit from real γ(T).

---

## Long-shot ideas (not on the queue, but worth considering)

- **Cross-engine validation against CRF250R single** (spec C10 / Phase 4
  — a true second engine, not just SDM25 vs SDM26). Repo already
  references this in `references/dyno/README.md`.
- **Mach-number-corrected valve Cd** at high lift (Frontiers 2019).
  Currently flat Cd above L/D=0.25. Probably small effect on this
  engine because valve operating Mach numbers stay modest, but worth
  characterizing.
- **Two-zone variable γ + recalibrated Woschni** as a complete
  combustion-model upgrade package (combines T1.2 + 0011 followup +
  0013 implications).
- **Charge cooling from fuel vaporization** — currently not modeled;
  real engines see 10-20 K intake-charge cooling from fuel evaporation
  in the port. Affects VE at all RPMs by 1-2%.
- **Residual gas mixing model** — `enable_residual_tracking = false`
  by default. Turning it on (and verifying it's plumbed correctly)
  would model trapped residual fraction's effect on the next cycle's
  effective AFR and γ.

---

## Quick-reference: where things live

| Concern | File |
|---------|------|
| Config struct + defaults | `crates/engine-sim/src/model/sdm26.rs` (lines 30-360) |
| apply_override + params table | `crates/cfd-core/src/params.rs` |
| Combustion (Wiebe, AFR, two-zone, knock) | `crates/engine-sim/src/cylinder/combustion.rs` + `cylinder.rs` |
| Junctions (Char + CV) | `crates/engine-sim/src/bcs/junction_characteristic.rs` + `junction_cv.rs` |
| Restrictor BC | `crates/engine-sim/src/bcs/restrictor.rs` |
| Valves | `crates/engine-sim/src/cylinder/valve.rs` + `bcs/valve.rs` |
| Simple BCs (transmissive, open-end) | `crates/engine-sim/src/bcs/simple.rs` |
| Pipe / MUSCL-Hancock | `crates/engine-sim/src/solver/` (parity-locked; see spec §2) |
| Configs | `crates/engine-sim/python_ref/configs/sdm26.json` + `sdm25.json` |
| Dyno data | `physics_findings/references/dyno/*.csv` |
| Literature corpus | `physics_findings/references/literature/*.md` |
| Findings | `physics_findings/NNNN-slug/finding.md` |
| Production knob set | `physics_findings/SESSION_HANDOFF.md` §2 |
| Trust map | `physics_findings/SESSION_HANDOFF.md` §3 |

---

*Author: Claude Opus 4.7 (session 2026-05-23)*
*Last updated alongside commit 6b4e6bc*
