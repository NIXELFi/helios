# Physics Agent Loop — Design Spec

**Date:** 2026-05-22
**Branch:** `physics-fixes/math-corrections`
**Status:** approved (verbal) — revised v3 after spec review v2 (C-1 amendment protocol, C-2 orchestrator mutex, C-3 hooksPath + no-verify policy)

## 1. Purpose

Make the Helios `engine-sim` Rust solver as accurate as possible by giving Claude agents a closed-loop ability to (1) form hypotheses about model behavior, (2) run isolated simulation studies, (3) validate against literature and reference data, (4) propose and implement fixes, (5) regress-test and document each fix.

The existing branch already closed the obvious silent-wiring bugs and added five opt-in physics levers. This project picks up from there and pushes through the remaining ~12% unrestricted gap to real CBR600 dyno (documented in [two_zone_results.md](../../../two_zone_results.md) and [physics_fixes_report.md](../../../physics_fixes_report.md) Appendix), audits every config knob against published norms, and extends solver coverage (multi-zone chemistry, quasi-3D port corrections, knock prediction, etc.).

There is no time or budget constraint. The sole optimization target is model accuracy.

## 2. Non-goals

- **Pushing to `main` or cutting a release.** All work stays on `physics-fixes/math-corrections` (or stacked sub-branches) until the user explicitly approves a merge + release.
- **Replacing the 1D Euler solver core.** Concrete line: any change under `crates/engine-sim/src/solver/` (time-stepping, reconstruction, Riemann solver, limiters themselves) is out-of-scope without explicit user sign-off. New *source terms*, new *closure models*, and new *constitutive relations* anywhere in the codebase are in-scope. If an investigation concludes the solver core must change to make further progress, that finding is logged with status `SOLVER-CHANGE-REQUIRED` and surfaced to the user — never auto-implemented.
- **Changing user-facing CFD tab UX in this work-stream.** Internal-only registry + (optional) dashboard.

## 3. Constraints — must hold throughout the project

**C1. Reversibility.** Every change is committed to the branch with a coherent message. No `git push --force`, no destructive operations. No new releases. Bad merges are corrected by follow-up *revert* commits, never by history rewriting.

**C2. Agent isolation — concrete mechanism.** Concurrent investigations run in separate `git worktree` clones with separate `CARGO_TARGET_DIR` paths. Each worktree has its own `Cargo.lock` (worktrees share `.git` but get a fresh checkout). The main checkout is reserved for the orchestrator and the doctor; researchers and implementers only run inside worktrees. Worktree mutation rules in §4.5.

**C3. Source-file lock — real primitive, declared upfront, with amendment protocol and orchestrator mutex.**

*Lock format.* Before a worktree spawns, the orchestrator declares the investigation's *write claim manifest* — a complete list of source files the agent may modify. The manifest is a JSON document at `.physics_locks/NNNN-slug.lock` with fields `{id, slug, worktree_path, spawned_by: cron|manual, spawned_at, files: [...]}`. Locks cover not only `*.rs` source but also `Cargo.toml`, `Cargo.lock`, `crates/engine-sim/src/model/*.rs`, schema files, and `crates/cfd-core/tests/regressions/`. Live locks list their worktree path; stale-lock detection is by missing worktree (cleaned up at orchestrator startup).

*Orchestrator mutex (resolves v2 C-2).* All `.physics_locks/` mutations — reading the existing manifests, computing collisions, and writing the new manifest — are serialized through `.physics_locks/_orchestrator.mutex`, acquired by `O_EXCL` create. The mutex file holds `{pid, hostname, acquired_at}`. Stale-mutex detection: if `mtime > 120 s` *and* the recorded `pid` is not running, the next orchestrator reclaims it. Both cron-spawned and manual orchestrators use the same mutex — there is no orchestrator that bypasses it.

*Per-file claim check.* Inside the mutex, the orchestrator reads all existing `.physics_locks/*.lock` files and `O_EXCL`-creates the new one only if no `files[]` entry collides. On collision, the spawn is rejected and the investigation queues.

*Amendment protocol (resolves v2 C-1).* If the researcher discovers mid-investigation that it needs to edit a file not in its manifest:
1. Researcher writes `worktrees/agent-NNNN-slug/pending_amend.json` listing the additional files and a one-line justification.
2. Researcher continues read-only work (or pauses). Pre-commit hook refuses to stage the new files until the amendment lands.
3. Orchestrator polls each dispatch cycle for `pending_amend.json` files across active worktrees.
4. Inside the orchestrator mutex, the orchestrator runs the same `O_EXCL` collision check against all other live locks. On no-collision: rewrites `.physics_locks/NNNN-slug.lock`, commits to main, deletes `pending_amend.json`. On collision: writes `pending_amend.rejected.json` with the colliding lock's id; researcher must split the investigation or wait.

*Pre-commit hook scope.* Refuses to stage files outside the manifest. Refuses any change to `crates/engine-sim/python_ref/` (parity anchor, locked by default). Refuses any change to `.physics_locks/` from inside a worktree (only the main checkout writes there).

**C4. Reproducibility — explicit determinism contract.** Every recorded `results.ndjson` is reproducible bit-faithfully on the same `(target_triple, rustc_version, libm_provider)` from `study.toml` + commit hash. To make this true:
- `study.toml` requires a `seed: u64` field (no default; absent = error).
- `study.toml` requires an `[environment]` block recording `target_triple`, `rustc_version`, `rayon_threads` (must be 1 for any "recorded" run; multi-thread is allowed only for exploratory runs which are flagged `recorded: false`), and `libm_source` (`rust-builtin` | `system`).
- `helios-bench` writes the environment block as the first NDJSON line of the result file, so any future replay verifies it.
- Reduction-order-sensitive aggregates (cross-trial summaries) are computed in a stable order (sorted by trial id), never in `par_iter` collection order. Any cross-trial aggregate that iterates a `HashMap` must use `BTreeMap` or sort keys explicitly — Rust's default `HashMap` randomizes seed per-process and would otherwise inject nondeterminism.

**C5. Parity preservation — pre-merge gate, not periodic sweep.** All default-flag opt-in flags are enumerated in `physics_findings/PARITY_FLAGS.toml`. On every worktree commit, a git pre-commit hook runs `cargo test -p engine-sim --test 'parity_*'` and `cargo test -p cfd-core --test 'parity_*'` with all parity flags at their default values. Hook failure blocks the commit. Doctor agent additionally re-runs parity on every merge into the investigation branch as a belt-and-suspenders check; doctor failure auto-reverts the merge (per C1, via revert commit not history rewrite) and re-opens the finding.

*Hook installation and bypass policy (resolves v2 C-3).* The hooks live in-repo at `.githooks/` and are activated via `core.hooksPath = .githooks` set in `.git/config` at repo init and re-asserted by the worktree spawn script in §4.5 step 2. The spawn script verifies `git config --get core.hooksPath` returns `.githooks` after worktree creation; mismatch aborts the spawn. `--no-verify` is policy-forbidden — the pre-commit hook self-checks an environment marker (`HELIOS_PHYSICS_AGENT=1` set by the spawn script) and refuses to run inside an agent worktree unless the marker is present, so a manual `--no-verify` outside an agent worktree is permitted (for the orchestrator's own emergency commits) but never inside a research worktree. The doctor's per-merge gate is the authoritative backstop: a `--no-verify`'d commit that somehow lands in the worktree branch still fails at merge time.

**C6. Validation tolerance — pre-registered per finding, skeptic-reviewed pre-run.** Every `study.toml` includes an `[acceptance]` block with:
- A list of metrics being validated (e.g., `peak_power_kW`, `bsfc_g_per_kWh`, `woschni_c1`).
- A target value and tolerance band per metric, each justified by a literature citation (paper, equation, edition).
- Optional bilateral tolerance (`±5%`) vs. one-sided (`>= 0.95 * target`).

The skeptic agent reviews the `[acceptance]` block *before the study runs* and acks or challenges the band's literature justification (a pre-run challenge restarts the design phase). After the run, the skeptic checks results strictly against the pre-registered band — bands cannot be changed post-hoc except through an explicit "amend acceptance" round counted in the §4.3 disagreement loop. If results disagree, the verdict is `NEEDS-FIX`. If literature itself is ambiguous, the finding documents that and may close as `LITERATURE-AMBIGUOUS` (a terminal but explicitly non-validating state).

**C7. Status states — finite, terminal, with one re-open path.** States: `INVESTIGATING`, `FIX-IN-PROGRESS`, `VALIDATED`, `FIXED`, `CEILING-LIMIT`, `LITERATURE-AMBIGUOUS`, `SOLVER-CHANGE-REQUIRED`, `ABANDONED`, `STALE`. Terminal states (`VALIDATED`/`FIXED`/`CEILING-LIMIT`/`LITERATURE-AMBIGUOUS`/`SOLVER-CHANGE-REQUIRED`/`ABANDONED`) do not re-open by agent action *except* via the staleness rule (C8). `STALE` is the only re-openable state and is set only by the doctor.

**C8. Staleness — baseline fingerprinting, skeptic-validated, two-tier check.** Every finding records a `baseline_fingerprint` block listing content-hashes (SHA-256) of every source file the study transitively reached. The list is researcher-authored but skeptic-validated:
- `helios-bench fingerprint --suggest <study.toml>` walks `cargo build --build-plan` from the study's entry point and proposes a superset of relevant files.
- The researcher selects a subset (typically the suggested set minus pure-leaf utility crates) and lists it in `finding.md`.
- The skeptic checks the fingerprint against the suggested superset as part of VALIDATED/FIXED sign-off (DoD §6). A fingerprint that omits files the suggester proposed without written justification fails skeptic review.

*Per-merge fast path vs. periodic full sweep.* On every merge into the investigation branch, the doctor recomputes fingerprints *only for files touched by the merge's diff* and flags any closed finding whose listed files include any diff entry. The full sweep (every closed finding × every listed file) runs once daily or every 25th merge, whichever is sooner — this is the authoritative backstop and catches fingerprints that drifted by accident. The fast path is cacheable; the full sweep amortizes.

A `STALE` finding is automatically re-queued for re-validation (status flips back to `INVESTIGATING`). The DoD in §7 incorporates this: project complete = "zero non-terminal findings AND zero `STALE` findings."

*STALE re-open lifecycle.* The finding keeps its original `NNNN` id. The worktree dir uses a `revalidation_N` suffix (`worktrees/agent-0042-woschni_revalidation_1/`) so re-runs don't collide with the original. The `finding.md` body grows a `## Revalidations` section that accumulates each pass — single audit trail per finding.

*STALE-during-merge.* If during a per-merge doctor sweep the doctor discovers that finding #X *just went STALE because of the merge currently being evaluated for finding #Y*, the #Y merge proceeds (blocking it would deadlock — the merge is what caused the staleness). The doctor emits a STALE event into a queue (`physics_findings/_stale_queue.ndjson`) that the orchestrator processes on its next dispatch cycle. Note that #X and #Y cannot have overlapping *write* claims at this point (the lock manifest in C3 prevents that); the staleness arises because #Y wrote a file that #X's fingerprint *read* — read dependencies are not lock-protected, only write claims are.

**C9. Physical vs numerical precedence.** When a fix improves physical accuracy but degrades a numerical invariant (mass / energy / momentum conservation, positivity, monotonicity at physical states) beyond stated tolerance, the numerical invariant wins. The fix is downgraded to `CEILING-LIMIT` with a note documenting why. Tolerance bands:
- **Mass conservation:** `± 1e-10` relative per cycle. (Current behavior is machine epsilon ~1e-18; this band allows new source terms — heat-transfer with variable density, residual-gas remixing — without flagging arithmetic noise as a violation. The actual measured value is recorded per finding so drift is visible.)
- **Energy conservation:** `± 0.5%` per cycle.
- **Momentum conservation:** `± 0.5%` per cycle.
- **Positivity** (density, pressure, temperature, species mass fractions): absolute. Any negative state is a hard failure regardless of magnitude.
- **Monotonicity at physical states:** absolute; no overshoots in pressure or temperature across a single time step beyond CFL-implied bounds.

**C10. Calibration-over-fit guard.** Any finding that *tunes* a coefficient (vs. fixes a wiring bug) reaches `FIXED` only after passing validation against at least two distinct reference engines. Until the second engine validates, the fix sits at `FIX-IN-PROGRESS` even if CBR600 numbers improve.

*Phase reconciliation.* To prevent Phase 1 / Phase 2 stalling on the absence of a second corpus, Phase 0 step 0.2 pulls in *one* additional reference engine dataset (recommendation: a published FSAE single-cylinder dyno, or the Ford SP-type port-injection benchmark from Heywood Appendix D). Phase 4 broadens this to ≥2 *additional* engines (i.e., ≥3 total). With Phase 0 corpus in place, any Phase 1 tuning fix has a working 2-engine validation path. *Bug-fix* findings (e.g., wiring errors like the limiter / junction-loss / AFR-η bugs already closed on this branch) are exempt from C10 — they fix incorrect behavior and need only the original CBR600 calibration regression to confirm no regression.

**C11. CLI is canonical.** `helios-bench` (CLI) is the reproducibility unit. `study.toml` + `helios-bench run` is the contract. `helios-mcp` (MCP server) is a convenience skin over the same crate; it cannot expose any capability the CLI does not. Reproducibility examples in `finding.md` always use the CLI.

**C12. No autonomous merges to `main`.** Investigation merges into `physics-fixes/math-corrections` may be agent-driven (after pre-commit + doctor pass per C5). Anything beyond that requires user action.

## 4. Architecture

### 4.1 Tooling layer

- **`crates/helios-bench`** — new Rust binary. CLI for `run` / `sweep` / `compare` / `validate` / `plot`. Reads `study.toml`, writes NDJSON to a file (first line is the environment block from C4). Deterministic seeds required. Built per-worktree.
- **`crates/helios-mcp`** — MCP server wrapping the same crate. Convenience only (C11). Exposes `run_sim`, `submit_sweep`, `read_finding`, `list_findings`, `query_literature`, `validate_results`.
- **`physics_findings/`** — registry at repo root:
  - `README.md` — auto-generated status board, written *only* by orchestrator
  - `NNN-slug/finding.md` — YAML frontmatter (`id`, `status`, `topic`, `hypothesis`, `opened`, `closed`, `owner`, `spawned_by` (`cron`|`manual`), `commit_hash`, `baseline_fingerprint`, `revalidation_count`) + body
  - `NNN-slug/study.toml` — reproducible inputs (C4 + C6)
  - `NNN-slug/results.ndjson` — raw outputs
  - `NNN-slug/literature.md` — citations + equations
  - `PARITY_FLAGS.toml` — enumerated parity-preserving default-off flags (C5)
  - `ORCHESTRATOR.md` — playbook for the orchestrator (referenced from §4.5 step 1)
  - `references/literature/` — paraphrased excerpts + equations (with ISBN/edition)
  - `references/dyno/` — calibration datasets
- **`worktrees/`** — `.gitignore`'d. One subdir per active investigation. Reaped on merge or abandon.
- **`physics_findings/dashboard/`** — *deferred* to Phase 5+. Markdown status board is enough until proven otherwise (per spec-review I-5).
- **`.physics_locks/`** — JSON write-claim manifests per active investigation (per C3). Committed to `physics-fixes/math-corrections` from the main checkout only (never from a worktree — the pre-commit hook refuses). Worktrees see locks read-only through the shared `.git`. Orchestrator writes inside its mutex; spawn-time check fails if any file in a new manifest collides with a live lock.

Findings are zero-padded to 4 digits (`0001-slug/` through `9999-slug/`) for stable sort.

### 4.2 Agent fleet

Defined under `.claude/agents/`:

| Agent | Tools | Scope |
|---|---|---|
| `physics-orchestrator` | All + agent dispatch | Main checkout. Picks next investigation, declares manifest, spawns researcher, reviews, merges. |
| `physics-researcher` | Read, Edit, Write, Bash/PowerShell, Grep, Glob, WebFetch, WebSearch, `helios-bench`, MCP | Worktree only. Designs study, runs sim, drafts conclusion. Pre-commit hook (C3 + C5) enforces lock manifest + parity. |
| `physics-skeptic` | Read, Grep, Glob, Bash (sim runs only, via a wrapper command `helios-bench run` — Bash policy is enforced by the agent's tool permission list, not by trust), WebFetch, WebSearch | Read-only view of researcher's worktree. Adversarial. |
| `physics-implementer` | Edit, Write, Bash, Read, Grep | Worktree only. Fix + regression test only after researcher + skeptic agree. Same lock-manifest pre-commit. |
| `physics-doctor` | Read, Bash, Grep | Main checkout. Runs on every merge: full parity suite (C5), full baseline-fingerprint recomputation (C8), full regressions suite. Doctor failure → auto-revert (C1). |

### 4.3 Disagreement loop cap

When skeptic CHALLENGEs a researcher conclusion, the round counter in `finding.md` increments. After **3 unresolved rounds**, the investigation auto-escalates to the user (status remains `INVESTIGATING` and the orchestrator stops picking it up). The skeptic's challenge must be structured: a `challenge.md` listing `{claim, evidence, falsification_test}` triples. A challenge without a falsification test is rejected by the orchestrator as malformed.

*Withdraw-before-re-raise rule.* The skeptic may not raise a new challenge against a claim it previously raised unless it first formally withdraws the prior challenge in `challenge.md`. Withdrawal does not consume a round. New challenges against *different* claims are always allowed and do consume rounds. This prevents "skeptic wins by exhaustion" (manufacturing a fresh objection every round on the same claim).

*Escalation packet.* When the 3-round cap fires, the orchestrator writes `physics_findings/NNNN-slug/escalation.md` containing the full challenge ledger (every round's challenge + researcher response), the current `study.toml` `[acceptance]` band, and a one-paragraph summary written by the orchestrator of where the disagreement actually lives. The packet — not just the latest round — is what the user reviews.

### 4.4 Data flow

```text
study.toml (with [acceptance], [environment], seed)
        │
        ▼
helios-bench run ─► results.ndjson (first line = environment block)
        │                  │
        ▼                  ▼
   pre-commit          validate (invariants per C9)
   parity gate (C5)         │
        │                  ▼
        ▼            literature.md ◄── references/literature/*.md
   compare(baseline)       │             references/dyno/*.csv
        │                  ▼                      ▲
        ▼            finding.md (with             │
   commit             baseline_fingerprint)    WebFetch/WebSearch
        │                  │
        ▼                  ▼
   doctor sweep ────►  merge (or auto-revert on doctor fail)
```

### 4.5 Investigation lifecycle

1. **Orchestrator picks finding.** On each dispatch cycle, the orchestrator (a) processes any `pending_amend.json` from active worktrees (per C3 amendment protocol — keeps blocked researchers from starving), (b) drains the `_stale_queue.ndjson` re-opening any STALE findings, then (c) picks the next `INVESTIGATING` / `STALE` / new candidate from the priority queue. Reads `physics_findings/ORCHESTRATOR.md` playbook + `README.md` status board. Drafts `study.toml` skeleton with `[acceptance]` and the *write-claim manifest* listing every source file the agent may touch.
2. **Spawn worktree.** Orchestrator creates `worktrees/agent-NNNN-slug/` via `git worktree add`. Lock manifest written to `.physics_locks/NNNN-slug.lock` (commit on main checkout). If any file in manifest is already locked, spawn rejected → queue. CARGO_TARGET_DIR is the worktree's own `target/`.
3. **Researcher in worktree.** Fills `study.toml` (seed, [environment], [acceptance]), reads existing `literature.md`, runs `helios-bench run`, collects `results.ndjson`. Runs `helios-bench validate` to confirm invariants. Drafts `finding.md` with hypothesis + results + comparison vs literature + proposed verdict.
4. **Skeptic review (pre-fix path).** Read-only view of worktree. Checks pre-registered acceptance band, comparison-class correctness, missed conservation, literature consistency. Outputs structured APPROVE or CHALLENGE (the latter includes falsification tests per §4.3).
5. **Branch by verdict:**
   - **VALIDATED** (within acceptance band, no fix needed): researcher records `baseline_fingerprint`. Pre-commit gate (parity + manifest) runs. Commit. Doctor sweep. On doctor green → merge to investigation branch → reap worktree → release lock.
   - **NEEDS-FIX**: implementer in same worktree adds the fix + regression test. Researcher re-runs study. Skeptic re-reviews (round counter incremented). On agreement → record `baseline_fingerprint` → pre-commit gate → commit → doctor sweep → merge → reap → release.
   - **CEILING-LIMIT** / **SOLVER-CHANGE-REQUIRED** / **LITERATURE-AMBIGUOUS**: documented, pre-commit gate runs, commit (no fix), doctor sweep, merge metadata only, reap, release.
   - **ABANDONED**: documented with reason, commit, merge metadata only, reap, release.
6. **Doctor periodic** (separate from per-merge hook): once daily or on every Nth merge, runs full baseline-fingerprint recomputation on all closed findings (C8); flags STALE.
7. **STALE re-open:** doctor flips status to `INVESTIGATING`. Orchestrator picks up at step 1 on next dispatch cycle.

### 4.6 Literature & calibration corpus

`physics_findings/references/literature/` will contain paraphrased excerpts + key equations from:
- Heywood, *Internal Combustion Engine Fundamentals* (2nd ed., 2018, ISBN 9781260116106)
- Ferguson & Kirkpatrick, *Internal Combustion Engines: Applied Thermosciences* (3rd ed., 2016, ISBN 9781118533314)
- Lumley, *Engines: An Introduction* (1999, ISBN 9780521644891)
- Original correlation papers: Woschni 1967, Chen-Flynn 1965, Engelman 1973, Annand 1963 — pinned by DOI when available
- NASA-7 polynomial coefficients (Burcat database, pinned version)
- SAE 950618 (Wiebe parameters), SAE 970986 (Chen-Flynn coefficients)

Plus published validation cases (FSAE papers, motorcycle dyno data, Ricardo WAVE / GT-POWER published benchmarks) under `references/dyno/`. Each citation has an entry recording author, year, equation, page/section, edition, and the relevance to the finding using it.

## 5. Phases

### Phase 0 — Infrastructure

Phase 1 cannot start until **0.1, 0.2, 0.3, 0.4, 0.5, 0.8, and 0.A** are all green. 0.6, 0.7, 0.9 may land in parallel with Phase 1.

- **0.1** `crates/helios-bench` skeleton + `run` subcommand (consumes `study.toml`, emits NDJSON with [environment] line)
- **0.2** `physics_findings/` scaffold + first reference docs (Heywood + Woschni + Chen-Flynn paraphrases) + `PARITY_FLAGS.toml` + `ORCHESTRATOR.md` + **second-engine corpus** (FSAE single-cylinder or Heywood Appendix D — required by C10)
- **0.3** Worktree lifecycle scripts (PowerShell + bash) + `.physics_locks/` ledger format + `.physics_locks/_orchestrator.mutex` mechanism + `.githooks/` pre-commit hook (manifest enforcement + parity test + `HELIOS_PHYSICS_AGENT` marker per C5) + spawn-script `core.hooksPath` verification + pre-spawn collision check
- **0.4** `helios-bench` `sweep` subcommand (wraps `run_optimization_job`, required `seed`, stable result ordering per C4)
- **0.5** `helios-bench` `validate` subcommand (mass/energy/momentum/positivity/monotonicity per C9) + `helios-bench fingerprint --suggest` (per C8)
- **0.6** `helios-bench` `compare` + `plot` subcommands (may land in parallel with Phase 1)
- **0.7** `crates/helios-mcp` MCP server (may land in parallel with Phase 1; CLI is canonical per C11)
- **0.8** `.claude/agents/physics-*.md` subagent definitions (orchestrator, researcher, skeptic, implementer, doctor)
- **0.9** *(deferred to Phase 5+)* Findings dashboard
- **0.A** End-to-end smoke test: reproduce one of the existing parity goldens (suggest `engine_matrix_sdm26_baseline.json`) bit-exactly through `helios-bench run`, then run the full investigation lifecycle (orchestrator → researcher → skeptic → implementer if needed → doctor → merge) on a trivial known finding (suggest the already-VALIDATED limiter bug fix) to prove every piece of plumbing works end-to-end.

### Phase 1 — Seeded investigations

Numbered queue (orchestrator may reorder or add):
1. Woschni c1/c2 sensitivity full sweep + literature comparison
2. Mach-number-corrected Cd table
3. Variable γ + dissociation chemistry (extends two-zone model)
4. Turbulent burn-rate correlation (refines tumble factor)
5. T_b clamp at 3500 K — verify or lift
6. Cd(L/D) table audit vs published flow-bench data
7. MUSCL limiter behavior on shock-containing scenarios (bug fix unlocked this)
8. Two-zone Woschni retune optimum
9. Heat-transfer area per crank angle
10. Residual-gas fraction modeling
11. Friction decomposition (piston-ring vs bearing vs aux)
12. Wiebe shape `m` parameter literature audit
13. MBT spark vs RPM against multiple reference engines
14. Knock prediction (Livengood-Wu integral, MAPO)
15. Valve-overlap mass exchange refinement
16. Exhaust pulse reflection magnitude + junction acoustic impedance

### Phase 2 — Broad-front parameter audit

Every config knob in the SDM26 schema gets a literature-derived sensible range. Agents sweep each within range, flag anything where:
- sensitivity is qualitatively different from published expectations
- defaults are outside published norms
- monotonicity / symmetry / dimensional invariants are violated

Estimated 50–100 new findings spawned here.

### Phase 3 — Solver-class extensions (inside the 1D framework only — see §2)

Each is a multi-investigation track:
- Multi-zone (≥3) combustion with NASA-7 equilibrium chemistry
- Variable γ(T, composition)
- Quasi-3D port-flow corrections (Mach-dependent Cd, swirl/tumble generation, charge cooling from fuel vaporization)
- Knock prediction model integration
- Per-CA heat-transfer area
- Residual-gas modeling with proper enthalpy mixing
- Valve-overlap mass exchange (forward-scavenging + back-flow)
- Exhaust pulse reflection magnitude tuning

### Phase 4 — Continuous calibration + multi-engine cross-validation

- Scheduled overnight autonomous runs via the `schedule` skill (cron mechanism — chosen for predictable lock-ledger semantics: cron-spawned orchestrators serialize with manual ones through the same git pre-commit + lock acquisition path)
- Calibration regression suite — any merged fix re-runs full CBR600 dyno comparison
- Cross-validate against ≥2 additional reference engines (already required per C10 for any tuning fix; Phase 4 is the broad sweep)
- Sensitivity & uncertainty quantification: every tuned parameter gets a published confidence interval; propagate to power/torque uncertainty bands

### Phase 5 — Documentation & summary

- Consolidate findings into a Helios engine-sim physics manual (every model, coefficient, known limit, with citations)
- Validation report-card per reference engine
- (Optional) build the findings dashboard if the markdown index proves insufficient
- Public-facing summary for desktop CFD tab users

## 6. Definition of Done — per finding

A finding is closed only when ALL of:
- Status is terminal per C7
- `finding.md` body contains hypothesis, study description, results, comparison-against-literature with citations, conclusion
- `study.toml` is reproducible per C4 (seed, [environment], commit hash)
- `study.toml` has `[acceptance]` block per C6
- `results.ndjson` committed
- If `FIXED`: regression test in `crates/cfd-core/tests/regressions/` and passes
- If `FIXED` and the fix tunes a coefficient (not a wiring bug): second-engine validation has passed (C10)
- Parity suite passes (C5) — checked at pre-commit and at doctor merge
- `baseline_fingerprint` recorded (C8), and skeptic has approved the fingerprint against `helios-bench fingerprint --suggest` output
- A reproducibility example using the CLI is included in `finding.md` (per C11)
- Skeptic has reviewed and approved both the `[acceptance]` block (pre-run, per C6) and the conclusion (post-run)

## 7. Definition of Done — for the project

Project complete when:
- Every config knob has a literature-justified default range and validated sensitivity
- Every solver subsystem has a documented accuracy ceiling with literature citation
- CBR600 calibration error bounded (peak power, peak torque, BSFC, EGT all within stated tolerance of measured)
- At least two additional reference engines have been cross-validated
- Zero non-terminal findings remain (`INVESTIGATING` / `FIX-IN-PROGRESS`)
- Zero `STALE` findings remain (per C8 — every fingerprint up-to-date)
- Final consolidation report written and reviewed by user

The user decides when (and if) the project ships to `main` and to a release.

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Agent slop science | Adversarial skeptic; structured `challenge.md` (§4.3); pre-registered `[acceptance]` (C6); offline literature corpus; doctor sweeps |
| Worktree disk explodes | Reap on merge; `target/` cleanup hook; document footprint; cap on concurrent worktrees (default 4, user-configurable via `physics_findings/ORCHESTRATOR.md`) |
| Parity bit-exactness regresses silently | Pre-commit hook (C5); doctor on every merge; PARITY_FLAGS.toml is authoritative |
| Two agents touch same file | Real lock manifest with `O_EXCL` create (C3); pre-commit hook refuses out-of-manifest edits |
| Concurrent writes to shared `physics_findings/README.md` | Only orchestrator writes to README + status board (4.1); per-finding subdirs are agent-owned |
| Concurrent edits to shared corpora | `references/literature/` paraphrases are append-only per investigation (new file per citation); conflict at index level resolved by orchestrator |
| Concurrent regression-test names | Test filename includes finding id (`r0042_woschni_c1_c2.rs`) — collision impossible |
| `Cargo.lock` poisoning across worktrees | Each worktree has its own `Cargo.lock` (worktree-private checkout); dependency additions land per-finding and merge sequentially |
| `python_ref/` accidentally bumped | Pre-commit hook refuses any change to `crates/engine-sim/python_ref/PINNED_SHA` (C3) |
| Infinite skeptic/researcher loop | 3-round cap → auto-escalate to user (§4.3) |
| Calibration over-fit to CBR600 | C10: tuning fix requires ≥2-engine validation before `FIXED` |
| Literature corpus rot / disagreement | Each citation pinned by edition + DOI; `LITERATURE-AMBIGUOUS` status when sources disagree |
| Physical vs numerical conflict | C9 precedence rule: numerical invariants tier-1, physical accuracy tier-2; conflict downgrades to `CEILING-LIMIT` |
| Finding dependencies invalidated by later fix | Baseline-fingerprint (C8) + doctor recomputation + `STALE` re-open |
| Doctor scheduled cadence drift | Doctor runs both per-merge (pre-merge gate) and daily sweep; per-merge is authoritative |
| MCP server yak-shave | C11: CLI is canonical; MCP is convenience; absence does not block Phase 1 |
| Dashboard turns into separate codebase | Deferred to Phase 5+ (4.1) |
| `git gc` / `git fetch` in main checkout disturbs worktrees | Main checkout reserves all `.git` mutations; worktrees never run `git gc`/`fetch`/`pull` |
| Phase 4 cron collides with manual orchestrator | Both serialize through the `.physics_locks/_orchestrator.mutex` defined in C3; cron-spawned orchestrators acquire locks identically. `spawned_by` field distinguishes them in audit logs. |

## 9. Open questions

All resolved in this revision. If new ones surface during Phase 0 implementation, they'll be added here.

## 10. References — required reading for any contributor

- [physics_synthesis.md](../../../physics_synthesis.md)
- [physics_fixes_report.md](../../../physics_fixes_report.md)
- [physics_validation_report.md](../../../physics_validation_report.md) (skim)
- [two_zone_results.md](../../../two_zone_results.md)
- [conservation_audit_report.md](../../../conservation_audit_report.md)
- [parity_offnominal_report.md](../../../parity_offnominal_report.md)
- The 22 existing `crates/cfd-core/tests/physics_*.rs` test files
- `crates/cfd-core/src/runner.rs` (the `run_optimization_job` that `helios-bench sweep` wraps)
- `crates/engine-sim/python_ref/PINNED_SHA` (parity anchor, locked by default per C3)

**Source of truth for already-fixed items:** `git log` on `physics-fixes/math-corrections`. The synthesis / report docs above may lag; treat the branch history as authoritative when there is any disagreement.
