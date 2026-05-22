# Physics Findings Registry

Auto-generated. Do not edit by hand — re-run the orchestrator's status-board step
to refresh. Source of truth is the per-finding frontmatter under `NNNN-slug/finding.md`.

Spec: [docs/superpowers/specs/2026-05-22-physics-agent-loop-design.md](../docs/superpowers/specs/2026-05-22-physics-agent-loop-design.md).
Plan: [docs/superpowers/plans/2026-05-22-physics-agent-loop-phase-0.md](../docs/superpowers/plans/2026-05-22-physics-agent-loop-phase-0.md).

## Status Board

| ID   | Topic                          | Status        | Spawned By | Opened     | Closed     |
|------|--------------------------------|---------------|------------|------------|------------|
| _(none yet — Phase 0 scaffolding only)_ |  |  |  |  |  |

## Status legend

- **INVESTIGATING** — researcher actively working
- **FIX-IN-PROGRESS** — implementer landing a fix (needs second-engine validation per C10 if tuning)
- **VALIDATED** — finding matches literature within `[acceptance]` band, no fix needed
- **FIXED** — fix landed + regression test passes + second-engine corpus checked (per C10 if tuning)
- **CEILING-LIMIT** — beyond solver-class capability per spec §2
- **LITERATURE-AMBIGUOUS** — cited sources disagree; documented and closed
- **SOLVER-CHANGE-REQUIRED** — needs solver-core change (out-of-scope per spec §2)
- **ABANDONED** — pursued but discontinued, with documented reason
- **STALE** — terminal status auto-revoked by doctor (per C8); queued for re-validation

## Counts

- INVESTIGATING: 0
- FIX-IN-PROGRESS: 0
- VALIDATED: 0
- FIXED: 0
- CEILING-LIMIT: 0
- LITERATURE-AMBIGUOUS: 0
- SOLVER-CHANGE-REQUIRED: 0
- ABANDONED: 0
- STALE: 0

## How to add a finding manually (orchestrator-bypass)

1. Pick the next free `NNNN` (zero-padded to 4 digits).
2. `cp -r physics_findings/templates physics_findings/NNNN-slug/` and rename files.
3. Fill frontmatter; set status to INVESTIGATING.
4. Append a row to the table above.
5. Re-run the orchestrator status-board step before the next dispatch cycle.

For the *normal* flow (orchestrator-spawned), see [ORCHESTRATOR.md](ORCHESTRATOR.md).
