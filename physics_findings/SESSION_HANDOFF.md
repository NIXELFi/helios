# Physics Agent Loop — Session Handoff (paused 2026-05-22)

Last working session on this branch landed Phase 0 (the agent-loop infrastructure)
and the first three Phase 1 findings. The user paused the session after finding 0003
landed, planning to pick back up later. This doc lets the next session resume cleanly.

If you're a future me / future Claude / a human teammate reading this:
**read the four numbered sections below in order.** Everything you need to continue
is here or one click away.

---

## 1. Where to start reading

In this order:

1. [`docs/superpowers/specs/2026-05-22-physics-agent-loop-design.md`](../docs/superpowers/specs/2026-05-22-physics-agent-loop-design.md) — design spec (C1–C12 constraints, agent fleet, lifecycle). Three rounds of adversarial spec review baked in.
2. [`docs/superpowers/plans/2026-05-22-physics-agent-loop-phase-0.md`](../docs/superpowers/plans/2026-05-22-physics-agent-loop-phase-0.md) — Phase 0 implementation plan (now executed). Has a "Known Issues" appendix preserving plan-review-v1 findings.
3. This file (you are here).
4. The three finding markdowns:
   - [`physics_findings/0001-limiter-revalidation/finding.md`](0001-limiter-revalidation/finding.md) — VALIDATED
   - [`physics_findings/0002-fmep-b-vs-heywood-typical/finding.md`](0002-fmep-b-vs-heywood-typical/finding.md) — STALE (was NEEDS-FIX)
   - [`physics_findings/0003-conservation-cliff-cycle-15-20/finding.md`](0003-conservation-cliff-cycle-15-20/finding.md) — VALIDATED (and the most important read of the three)

---

## 2. State of the branch

- **Branch:** `physics-fixes/math-corrections`
- **Remote:** `origin/physics-fixes/math-corrections` — fully pushed. **51 commits ahead of main** as of this handoff.
- **Tip commit:** `79483c0 chore(physics-findings): 0003 frontmatter commit_hash = d2e9bbf`
- **Working tree:** clean (verified `git status` returns "nothing to commit").
- **Do NOT push to `main` and do NOT cut a release** without explicit user approval. This was the standing user instruction from the start of the project and remains in force.

`git log --oneline -10` should show, from newest:

```
79483c0 chore(physics-findings): 0003 frontmatter commit_hash = d2e9bbf
d2e9bbf feat(physics-findings): 0003 conservation-cliff-cycle-15-20 VALIDATED
4e36990 lock: reap 0002-fmep-b-vs-heywood-typical
7a2d0ff merge(physics): 0002 fmep-b-vs-heywood-typical (NEEDS-FIX)
3384469 feat(physics-findings): 0002 fmep-b-vs-heywood-typical — NEEDS-FIX
decfe09 lock: spawn 0002-fmep-b-vs-heywood-typical
e8d6616 orchestrator(0002): seed fmep-b-vs-heywood-typical study + finding skeleton
dee90ec feat(physics-findings): 0001-limiter-revalidation VALIDATED
ffd7921 chore(parity): refresh parity_offnominal_rust_invariants baseline
33d8876 fix(helios-bench): validate uses nonconservation, not mass_drift (C9)
```

If you don't see those, something has gone wrong between sessions — verify with
`git log --oneline -10` and reconcile before continuing.

---

## 3. What Phase 0 + first 3 findings established

### Infrastructure (Phase 0 — all complete)

- **`crates/helios-bench`** — Rust binary, 7 subcommands (`run` / `sweep` / `validate` / `compare` / `plot` / `fingerprint` / `locks`). 46+ tests pass. Built per-worktree.
- **`crates/helios-mcp`** — in-house stdio JSON-RPC MCP server wrapping helios-bench (per spec C11 "CLI is canonical"). 21 tests.
- **`physics_findings/`** — registry with templates, ORCHESTRATOR.md, PARITY_FLAGS.toml, 10-doc literature corpus (Heywood Ch 6/9/12/13, Woschni 1967, Chen-Flynn 1965, Engelman 1973, Lumley, Ferguson, Burcat NASA-7), CBR600 FSAE + stock dyno CSVs.
- **`.physics_locks/`** — O_EXCL lock manifest + orchestrator mutex (Win+POSIX), amendment protocol.
- **`.githooks/pre-commit`** — manifest enforcement + parity-suite gate (~47 tests, ~80–110s per commit). Activated via `core.hooksPath = .githooks`. Requires `HELIOS_PHYSICS_AGENT=1` env marker inside agent worktrees.
- **`scripts/physics/{spawn,reap,process-amendments,process-stale-queue}-worktree.{ps1,sh}`** — verified end-to-end.
- **`.claude/agents/physics-{orchestrator,researcher,skeptic,implementer,doctor}.md`** × 5.
- **`crates/cfd-core/tests/regressions/`** ready for `regressions_<NNNN>_<slug>.rs` files (cargo's flat-discovery convention; no subdirectories).

### Findings landed (Phase 1, first 3)

#### Finding 0001 — `limiter-revalidation` — VALIDATED

Bit-exact reproduction of SDM26 / characteristic / 10000 RPM parity golden through
the new helios-bench pipeline. `imep_bar = 11.19471975808179` vs golden
`11.194719758081801` — 1 ULP, ~1e-15 relative. `step_count = 6460` matches
exactly. **Proved the pipeline introduces zero numerical drift relative to the
existing parity-tested code path.**

This also caught **bug B1**: `helios-bench validate` was using `mass_drift_kg`
(a cycle-to-cycle convergence delta) as the C9 mass-conservation gate. Real
field is `nonconservation` (FP-roundoff closure error of the mass-balance equation).
Fixed in commit `33d8876` with two new regression tests. The agent loop catching
its own bug, in the loop.

#### Finding 0002 — `fmep-b-vs-heywood-typical` — STALE (was NEEDS-FIX)

Asked: is `fmep_b = 0.1` (engine-sim default, source comment self-flagged as
"on the high side") defensible against the CBR600 dyno, or is it absorbing
other model error? Heywood Tab 13.3 typical motorcycle range is 0.04–0.05.

**Sweep at 25 cycles SDM26 (and SDM25) at 10000 RPM showed brake_power
51.43–54.85 kW** — 8–12 kW *over* the dyno band of ~38–43 kW at that RPM.
Lowering fmep_b *raised* brake_power further out of band; matching the dyno
would require `fmep_b ≈ 0.15–0.20`, far outside Heywood. The investigation
deferred because the data showed mass-conservation residual jumping from
~1e-17 to ~1e-7 between cycle 15 and 20 — six orders of magnitude over the
spec C9 band. That cliff dominated everything else.

**Re-categorized as STALE after finding 0003** explained the cliff
(see below). The brake_power overshoot is real physics, not a conservation
artifact. The right next question is "what's making IMEP creep upward past
cycle 17?" — not "what's the right `fmep_b`?".

Side-effects of finding 0002 that DID land:

- `cfd_core::params::apply_override` extended with `fmep_a` / `fmep_b` / `fmep_c`
  match arms + new `Friction` schema group + two regression tests. Defaults
  unchanged; parity preserved.
- `physics_findings/references/literature/heywood-friction-ch13.md` and
  `chen-flynn-1965.md` corrected — they originally claimed `fmep_b · P_max`;
  the real form is `fmep_b · S_p̄` (mean piston speed in m/s). The corpus
  is now consistent with the implementation.

#### Finding 0003 — `conservation-cliff-cycle-15-20` — VALIDATED (outcome b)

The mass-conservation cliff is **NOT a bug** — it's an algorithmic precision
floor of the characteristic-junction boundary condition.

- `crates/engine-sim/src/bcs/junction_characteristic.rs:639` — `CharacteristicJunction::absorb_fluxes()` is a no-op. The junction has no CV mass state.
- The secant Newton solver at `junction_characteristic.rs:238–239` converges on `|last_mass_residual| < 1e-13 kg/s` — that's a *mass-flux* residual, not a *mass-closure* residual.
- Per-step inconsistencies between the secant's `muscl_face_reconstruction` (lines 189–208) and the subsequent MUSCL-Hancock step's actual face flux integrate over cycles.
- The Python reference (`crates/engine-sim/python_ref/models/sdm26.py:1004–1016`) has the same structural design. **The behavior is parity-locked. Any "fix" would break the goldens.**

Per-cycle profile measured at SDM26 / 10000 RPM / characteristic junction:

| Cycle | nonconservation (kg) | Note |
|---|---|---|
| 1 | +5.7e-7 | warm-up transient |
| 2–17 | 1e-18 → 8e-17 | settling at machine epsilon |
| 18 | -4.8e-8 | **cliff onset** |
| 19–20 | ~-1.3e-7 | |
| 25 | +1.8e-7 | matches 0002 |
| 30 | +3.9e-7 | monotonic plateau |

SDM25 / 10000 RPM cliffs at cycle 17 (within 10% of SDM26). SDM26 / 10000 RPM
*Stagnation* (CV) junction stays at machine-epsilon throughout 30 cycles — no
cliff. SDM26 char at 6000 RPM cliffs at cycle 13 (more steps per cycle).

**Crucial implication for the existing `conservation_audit_report.md` claim
of "machine-eps conservation across 16 scenarios + 1270 runs":** that claim
is true *only* for the Stagnation/CV junction configs that audit tested.
Every production calibration, every parity test, every finding so far runs
`JunctionKind::Characteristic`. The old audit has a coverage gap. This was
unknown until finding 0003.

---

## 4. Outstanding work — resume here

### 4a. Small inline cleanups (do these first; each ~5–10 min, no agent needed)

1. **B1 fix** — `crates/helios-bench/src/cmd/validate.rs:148` checks `nc.abs() > MASS_REL_BAND` (absolute) but the band is documented as relative. Divide by per-cycle intake mass (~0.5 g) before comparing. Add a test that fails the current absolute check but passes the relative one.
2. **Spec C9 amendment** — the `±1e-10 relative per cycle` band needs junction-kind-awareness. CV/Stagnation: ±1e-10 achievable. Characteristic: ~1e-4 relative algorithmic floor. Update `docs/superpowers/specs/2026-05-22-physics-agent-loop-design.md` C9 to specify both bands and reference finding 0003's diagnosis.
3. **B2** — `crates/cfd-core/tests/conservation_audit.rs` should add parallel `JunctionKind::Characteristic` scenarios alongside the existing Stagnation ones. Reproduce 0003's per-cycle measurements as regression tests.

These three should be one or two commits each. They unblock finding 0004 from inheriting the same flawed tooling that bit finding 0002.

### 4b. Highest-value next investigation — Finding 0004

**Topic:** IMEP-vs-cycle-count on characteristic-junction SDM26 / SDM25.

**Hypothesis:** IMEP at cycle 25 is ~10–15% higher than at cycle 5 on
characteristic-junction runs. The 0002 fmep_b sweep showed brake_power
51.43–54.85 kW at cycle 25 vs the dyno band of ~38–43 kW at 10000 RPM
(an 8–12 kW overshoot). 0003 ruled out a conservation artefact. So IMEP
itself must be creeping upward past cycle 17. Why?

**Likely candidates:**

- Variable-γ chemistry not modeled (constant-γ ideal gas over-predicts
  peak pressure once burned-zone temperatures exceed ~2500 K)
- Woschni miscalibration on characteristic junction (the characteristic-
  vs-CV difference in mass-flow detail likely changes the cylinder-mass-
  history that Woschni's c1·B^(-0.2)·p^0.8·T^(-0.53)·w^0.8 depends on)
- The closure error in the characteristic junction biases pressure-trace
  integration slightly high (since the cliff is monotonic in one direction)

**This is the actual path to closing the 12 % unrestricted gap that
motivated the whole branch.** Far higher leverage than fmep_b retuning.

**Sketch:**

- Per-cycle IMEP capture (already need this for finding 0004; reuse the
  `--per-cycle` work from 0003 if it landed an extension to `helios-bench run`)
- Both junctions, both calibrations, 30 cycles, 10000 RPM
- Compare IMEP trajectory cycle-by-cycle between Stagnation and Characteristic
  for the same config. The delta is the contribution of the cliff to IMEP.
- Compare IMEP trajectory between cycle 5 (where 0001 validated bit-exact)
  and cycle 25 (where 0002 saw overshoot). The delta over cycles 5→25
  on Stagnation isolates the variable-γ / Woschni contribution from the
  cliff contribution.

### 4c. Other queued items (deferred until 0004 lands)

- **0005 — NASA-7 polynomial pin verification.** Burcat 2005-09 recommended by
  `references/literature/burcat-nasa7-coefficients.md`; engine-sim's thermo
  code may use a different snapshot. Cross-check.
- **0006 — CBR600 BSFC + EGT data gap.** Only power/torque published in the FSAE
  / 600RR forum corpus. Findings that need BSFC validation should declare
  `LITERATURE-AMBIGUOUS` candidacy in their `[acceptance]` block. Document this
  policy.
- **0007 — Pre-existing parity-test build warnings.** `parity_solver.rs` has
  unused imports for `LIMITER_MINMOD/VAN_LEER/SUPERBEE`; `parity_sweep_full_sdm26.rs`
  has an unused field `bmep_bar`. Trivial cleanup, but doesn't ship until somebody
  files it as a finding (the loop's discipline — touch source, write a finding).
- **0008+ — the spec's original Phase 1 seeded queue:** Woschni c1/c2 sensitivity
  full sweep, Mach-number-corrected Cd table, two-zone Woschni retune, heat-transfer
  area per crank angle, residual-gas fraction modeling, friction decomposition,
  Wiebe shape `m` parameter audit, MBT spark vs RPM against multiple engines, knock
  prediction (Livengood-Wu / MAPO), valve-overlap mass exchange, exhaust pulse
  reflection magnitude. Some of these will become much sharper questions once
  0004 reveals which physics gap is dominating the IMEP creep.

---

## 5. Resume checklist

When you return:

1. `git fetch && git log --oneline -5` — confirm tip is `79483c0` (or newer if work
   happened elsewhere; reconcile if so).
2. `git status` — confirm clean tree.
3. Re-read this file + the three finding markdowns. They're the prior art.
4. Land the three small inline cleanups in §4a — they don't need agent dispatch.
5. Dispatch finding 0004 (IMEP-vs-cycle-count) — the highest-leverage next step.
6. After 0004's verdict, decide whether the original Phase 1 seeded queue still
   makes sense as written, or whether 0004 has redirected priorities.

The agent loop is real and working. Three findings in, one VALIDATED bit-exact
reproduce, one STALE that taught us where the real question lives, one VALIDATED
that reframed the entire "remaining gap" investigation. The loop catches its own
bugs. Keep going.

— end of handoff —
