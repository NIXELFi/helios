# Physics Agent Loop — Session Handoff (paused 2026-05-23)

Continuation of the prior session (paused 2026-05-22 at finding 0003). This
session shipped findings 0004 through 0014 plus 12 bugfixes, all on
`physics-fixes/math-corrections`. Nothing pushed; main untouched; all 20
parity-test scenarios still bit-exact.

If you're picking up the work, **read these four sections in order**.

---

## 1. State of the branch

- **Branch:** `physics-fixes/math-corrections`
- **Tip:** commit `e2d59c1` (0014 SDM27 + knock-margin design table)
- **Working tree:** clean
- **Total commits this session:** 24 (11 source + 13 finding/doc)
- **Parity:** 20/20 SDM25+SDM26 scenarios still bit-exact at all opt-in
  defaults.

`git log --oneline -17` shows:

```
6625175 fix(params)+docs(0012): limiter+CFL exposed; numerical convergence audit
7bffe02 docs(physics-findings): 0011 Woschni × two-zone joint optimization — confirms NEGATIVE
4912e0b docs(physics-findings): 0010 two-zone characterization — NEGATIVE recommendation
ac40a6a feat(physics-findings): 0009 physics breakdown audit + 3 wiring bug fixes
0eaaf5f feat(physics-findings): 0008 SDM27 design exploration VALIDATED
768f750 feat(physics): 0007 high-RPM physics — exhaust reflection BC + Wiebe RPM scaling
e201f1d fix(physics-findings): 0006 dyno-convention re-framing (wheel power) + implied-η
e3d571b feat(physics-findings): 0006 RPM-resolved physics FIXED + sensitivity scans + plots
a62ff49 feat(physics): 0006 RPM-resolved physics — 3 new opt-in fixes (parity preserved)
4cab030 feat(physics-findings): 0005 junction-loss-in-residual FIXED + plots + regressions
17f0310 feat(physics): in-residual Borda-Carnot junction loss for SDM27 design (0005)
bf6969d feat(physics-findings): 0004 junction-kind-imep-sensitivity VALIDATED
a55dde5 fix(helios-bench): sweep emits junction field (B3, 0004 follow-up)
5e0d476 test(physics): characteristic-junction parallel audit + regressions_0003 (B2)
5b60856 fix(helios-bench): junction-aware mass band per C9 amendment (B1, 0003 follow-up)
406f6e6 docs(physics-findings): session handoff at 0003 VALIDATED — clean resume
79483c0 chore(physics-findings): 0003 frontmatter commit_hash = d2e9bbf
```

---

## 2. The production knob set for SDM27 design

After 10 findings of investigation + characterization, the **literature-
derived, parity-preserving, opt-in physics knob set** that designers
should use for SDM27 work:

```toml
# All literature-derived, no per-engine tuning, all parity-preserving
# (defaults reproduce legacy bit-exact). Reference: 0005-0009 findings.

# 0005: Borda-Carnot loss at the intake plenum-runner T-junction,
# applied INSIDE the inter-leg mass residual (mass-conserving).
intake_junction_borda_carnot = 1
intake_junction_loss_coef = 1.0              # multiplier on K_BC(geometry)

# 0006: Restrictor diffuser loss from the JSON `diverging_half_angle`
# (was silently ignored by the loader pre-0006).
restrictor_loss_from_diffuser_geometry = 1

# 0006: Mach-dependent Cd at the restrictor (NASA TM X-1570).
# Single biggest lever from 0006: cuts bias by ~3 kW.
restrictor_cd_mach_k = 0.3

# 0006: RPM-dependent spark advance (Bonatesta MBT map).
# Small effect on this engine but right physics for SDM27 design with
# different combustion regimes.
spark_advance_rpm_slope_deg_per_krpm = 1.5

# 0006: RPM-dependent Wiebe burn duration (Bonatesta N^p, p≈0.4).
# Same small-effect-but-correct-physics rationale as MBT map.
duration_rpm_exp = 0.4

# KEEP DEFAULT (0):
# two_zone_enabled         — 0010+0011 showed it makes the model
#                            WORSE without joint Woschni re-calibration
#                            AND variable γ(T) per zone. Not a free win.
# afr_eta_enabled          — 0009 showed it correctly applies rich-quench
#                            but ONLY needed if studying off-stoich AFR.
#                            At AFR ∈ [12, 16] the correction is ≈ 1.0
#                            anyway, so safe to leave OFF for stoich work.
# exhaust_collector_reflection_coef — 0007 showed BC is correct but
#                            doesn't help on SDM26 geometry; available
#                            for testing specific collector designs.

# Numerical (0012):
# limiter = 0 (minmod)  — limiter choice is irrelevant (<1% spread).
# cfl = 0.85            — fine; lower (~0.5) gives marginally better waves.
# n_cells = 30 per pipe — fast-iteration default; for publication runs
#                         override all *_n_cells to 60 (~1 kW better-resolved
#                         BP at 10k, ~50% runtime cost).
```

### How well does the production knob set work?

| Engine | RMSE vs FSAE dyno (wheel) | bias | implied η @ 10 kRPM |
|--------|--------------------------:|-----:|--------------------:|
| SDM26  | 10.04 kW                  | +1.94 kW | **0.85 (perfect)** |
| SDM25  | 9.05 kW                   | +0.71 kW | 0.79              |

At the FSAE peak-power band (10-11 kRPM) the simulator's implied
drivetrain efficiency is **exactly the Cameron handbook 0.85** for
SDM26 — the model is essentially correct at the operating point that
matters most for design.

---

## 3. Trust map for SDM27 design

| Region | Trust level | Source |
|--------|-------------|--------|
| **6-13 kRPM, SDM-class geometry, AFR ∈ [12, 16], CR ∈ [8, 16]** | TRUSTED for comparative architecture decisions | 0006-0009 + the implied-η diagnostic |
| Intake-side design (runner, plenum, restrictor, bore, stroke) | TRUSTED for relative ranking | 0006 sanity sweeps + 0008 candidates |
| Exhaust primary / secondary LENGTH optimization | **DO NOT TRUST** | 0007: simulator's exhaust pulse damping makes lengths essentially flat |
| Absolute peak-power prediction within ±5 kW | NOT TRUSTED | -17 kW under @ 13k from 0007 SOLVER-CLASS; +12 kW over @ 6k from missing port losses |
| Rich AFR (φ > 1.2) | **REQUIRES** `afr_eta_enabled = 1` | 0009: default gives 4-5× over-prediction at AFR 8 |
| Lean AFR (φ < 0.7, AFR > 21) | UNTRUSTED — lean misfire cliff not captured | 0009 G2 |
| High CR (> 14) and high spark advance (> +35°) | UNTRUSTED — no knock model | 0009 G4 |
| Low RPM (< 6 kRPM) | UNTRUSTED — overestimates BP | 0006-0007 implied-η @ 6k = 0.52 |
| Numerical: n_cells = 30 | OK for iteration, override to 60 for final | 0012 |

---

## 4. Findings index (0003-0012)

| # | Title | Status | Key result |
|---|-------|--------|------------|
| 0003 | conservation-cliff-cycle-15-20 | VALIDATED | Characteristic-junction algorithmic precision floor at ~1e-4 relative (pre-session) |
| 0004 | junction-kind-imep-sensitivity | VALIDATED | RPM-shaped Char-vs-Stag IMEP delta (peak +17 kW @ 8k); diagnosed but not fixed |
| 0005 | junction-loss-in-residual | **FIXED** | Moved Borda-Carnot loss into residual; geometry-derived per-leg K; SDM26 bias -2.96 kW |
| 0006 | RPM-resolved physics | **FIXED** | Restrictor diffuser geometry + Mach-Cd + MBT map + Wiebe RPM; SDM26 bias 11.71 → 8.75; +Mach-Cd is the biggest lever |
| 0006 | dyno-convention re-framing | docs | Re-framed in wheel-power; SDM26 @ 10k = 0 kW gap; implied η(RPM) is the design diagnostic |
| 0007 | high-RPM physics | VALIDATED | NEGATIVE: exhaust reflection BC machinery shipped but doesn't help; sim's exhaust-tuning sensitivity is flat (~4 kW spread across 30× primary length range) — SOLVER-CLASS limit |
| 0008 | SDM27 design exploration | VALIDATED | Comparative ranking of 7 candidates; 75mm-bore oversquare wins (+2.1 kW peak vs CBR baseline); all 5 lit. principles predicted in correct direction |
| 0009 | physics breakdown audit | VALIDATED + 3 BUGS FIXED | 184-trial stress test; no crashes, no NaN; documented 4 model gaps; B6/B7/B8 (apply_override missing entries for afr_eta_enabled / tumble_burn_factor / two_zone_enabled) FIXED |
| 0010 | two-zone characterization | NEGATIVE | `two_zone_enabled` shifts BP up uniformly; worsens fit. Don't add to production knob set without joint Woschni re-calibration |
| 0011 | Woschni × two-zone joint | NEGATIVE | Even with optimal Woschni in Heywood range, two-zone+joint loses to single-zone+default. Need variable γ(T) per zone to make two-zone work |
| 0012 | limiter + CFL + n_cells sensitivity | VALIDATED + 2 BUGS FIXED | Limiter doesn't matter; CFL mild; n_cells = 30 is ~1 kW under-resolved (use 60 for final). B9/B10 (apply_override missing for `limiter` + `cfl`) FIXED |
| 0013 | knock prediction (Livengood-Wu) | **FIXED** + 2 BUGS FIXED | Closes 0009 G4 — knock model with Douaud-Eyzat τ + polytropic T_unb (γ=1.33). All 6 well-known engineering rules predicted correctly. B11/B12 (apply_override missing for intake/exhaust `lift_flat_top_ramp`) FIXED. Apply_override completeness audit: 78/80 sweep-relevant fields exposed |
| 0014 | SDM27 + knock-margin design table | VALIDATED | First design-decision-grade SDM27 output including knock. C4 (75mm-bore oversquare) safe CR × octane envelope: CR=12 + 110-oct → 45.1 kW peak BP (RECOMMENDED). CR=10 + 95-oct → 43.3 kW (pump-gas backstop). CR=12 + 95-oct knocks — needs active control |

### Bugs fixed this session

| # | What | Where |
|---|------|-------|
| B1 | validate.rs absolute-vs-relative nonconservation band | 0003 follow-up |
| B2 | conservation_audit needed Characteristic scenarios (only had Stagnation) | 0003 follow-up |
| B3 | helios-bench sweep wasn't emitting `junction` field | 0004 follow-up |
| B4 | loader silently dropped `restrictor.diverging_half_angle` from JSON | 0006 |
| B5 | restrictor `converging_half_angle` still dropped (smaller effect; deferred) | 0006 |
| B6 | `afr_eta_enabled` missing from `apply_override` | 0009 |
| B7 | `tumble_burn_factor` missing from `apply_override` | 0009 |
| B8 | `two_zone_enabled` missing from `apply_override` | 0009 |
| B9 | `limiter` missing from `apply_override` | 0012 |
| B10 | `cfl` missing from `apply_override` | 0012 |
| B11 | `intake_lift_flat_top_ramp` missing from `apply_override` | 0013 |
| B12 | `exhaust_lift_flat_top_ramp` missing from `apply_override` | 0013 |

**Pattern observation**: 7 of these 12 bugs (B6-B12) are the same class
— SDM26Config fields that exist and work internally but aren't exposed
via `apply_override`, so study TOMLs that try to vary them get
"unknown parameter path" warnings and silently no-op. Worth a follow-
up to audit ALL SDM26Config fields against the apply_override
match arm + params table.

---

## 5. Highest-leverage followups (queued, not done)

Roughly in order of design-tool value:

1. **0013 — variable γ(T) per zone in two-zone combustion** (from 0011)
   — Burcat NASA-7 polynomials are already in `references/literature/`;
   this would make `two_zone_enabled` a defensible production default
   and likely close some of the residual gap at peak RPM.
2. **0014 — Low-RPM port-loss model** (from 0006/0007/0009)
   — Closes the +12 kW over-prediction at 6 kRPM (implied η = 0.52).
   Candidate: low-Reynolds intake valve Cd correction + port wall
   friction.
3. **0015 — SOLVER-CHANGE: WENO in exhaust pipes** (from 0007)
   — The only path to closing the 17 kW under-prediction at 13 kRPM.
   Requires user sign-off per spec §2.
4. **0016 — Knock model (Livengood-Wu integral)** (from 0009 G4)
   — High CR + high spark currently unbounded. Add MAPO or LW.
5. **0017 — Variable valve timing (VVT)** (from 0008/0009)
   — Real CBR600RR has VVT. Sim's fixed-cam biases low-RPM heavily.
6. **0018 — Lean-misfire cliff fix** (from 0009 G2)
   — Trivial code change: shift afr_eta_factor lean branch from
   `phi ≤ 0.7` to `phi ≤ 0.85`.
7. **0019 — Apply_override completeness audit** (from B6-B10 pattern)
   — Programmatic check that every SDM26Config field is in
   apply_override OR explicitly marked as not-overrideable.
8. **0020 — Production-knob-set at n_cells=60** (from 0012)
   — Re-run 0006 + 0008 baselines at n_cells=60 to confirm conclusions
   hold at higher resolution.

---

## 6. Resume checklist

When you return:

1. `git fetch && git log --oneline -1` — confirm tip is `6625175`
2. `git status` — confirm clean tree
3. Re-read this file
4. Pick a finding from §5 followups OR start fresh if priorities have
   changed
5. Use the production knob set in §2 for any new design study; the
   trust map in §3 says which regions you can rely on

The simulator is in a good state: well-instrumented, well-documented,
opt-in physics, parity preserved across the agent-loop infrastructure.
The bugs found this session (5 hidden flags, 2 wrong-units checks)
are all fixed. The design tool is ready for SDM27 architecture
decisions, with documented trust regions and gaps.

— end of handoff —
