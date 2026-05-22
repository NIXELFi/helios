# .physics_locks

Write-claim manifests for active physics investigations (spec C3).

Spec: [../docs/superpowers/specs/2026-05-22-physics-agent-loop-design.md](../docs/superpowers/specs/2026-05-22-physics-agent-loop-design.md).

## Files

### `_orchestrator.mutex`

Held by the orchestrator while reading or writing this directory. Acquired by
`O_EXCL` create (POSIX) or `FileMode::CreateNew` (Windows). Released by
`Drop` (Rust) or `finally` (PowerShell). The file body is JSON:

```json
{ "pid": 12345, "hostname": "DESKTOP-XYZ", "acquired_at": "2026-05-22T12:00:00Z" }
```

Stale-mutex detection: if `mtime > 120 s` AND the recorded `pid` is no longer
running, the next orchestrator reclaims it (unlinks then re-acquires inside
its own mutex attempt).

The mutex itself is `.gitignore`'d — it's transient process state.

### `NNNN-<slug>.lock`

One file per active investigation. Format:

```json
{
  "id": 42,
  "slug": "woschni-c1-c2",
  "worktree_path": "worktrees/agent-0042-woschni-c1-c2",
  "spawned_by": "manual",
  "spawned_at": "2026-05-22T12:00:00Z",
  "files": [
    "crates/engine-sim/src/cylinder/heat.rs",
    "crates/cfd-core/tests/regressions_0042_woschni_c1_c2.rs",
    "physics_findings/PARITY_FLAGS.toml"
  ]
}
```

Field semantics:

| Field           | Meaning                                                      |
|-----------------|--------------------------------------------------------------|
| `id`            | integer 0-9999; corresponds to `physics_findings/NNNN-slug/` |
| `slug`          | kebab-case topic identifier                                  |
| `worktree_path` | repo-relative path to the worktree                           |
| `spawned_by`    | `manual` (interactive orchestrator) or `cron` (scheduled)    |
| `spawned_at`    | ISO-8601 UTC timestamp                                       |
| `files`         | exhaustive list of source files the agent may modify         |

`files[]` MUST be exhaustive. The pre-commit hook (`.githooks/pre-commit`)
refuses any staged change that touches a file not in this list (except the
finding's own subdirectory `physics_findings/NNNN-slug/`, which is always
writable, and root-level `*.md` progress notes which are always writable).

## Concurrency contract

- All mutations of this directory serialize through `_orchestrator.mutex`.
- The mutex is held during: read all manifests → collision check → write new
  manifest → commit on main checkout. The window is small (<1 s typical).
- Worktrees see this directory read-only through the shared `.git`. The
  pre-commit hook refuses any commit from a worktree that touches
  `.physics_locks/`.
- Both cron-spawned and manual orchestrators use the same mutex. The
  `spawned_by` field distinguishes them in audit logs but they share the
  primitive.

## Amendment protocol (spec C3)

If a researcher mid-investigation needs to edit a file outside its manifest:

1. Researcher writes `worktrees/agent-NNNN-slug/pending_amend.json`:

   ```json
   { "additional_files": ["crates/engine-sim/src/intake.rs"],
     "justification": "Woschni c1 retune turns out to need the intake mass-flow plumb-through changed" }
   ```

2. Researcher continues read-only work or pauses. The pre-commit hook
   refuses to stage the new files until the amendment lands.
3. Orchestrator polls each dispatch cycle. Inside its mutex, it runs the same
   `O_EXCL` collision check against all other live locks.
4. **No collision:** orchestrator rewrites `.physics_locks/NNNN-slug.lock` with
   the merged file list, commits on main, deletes `pending_amend.json`.
5. **Collision:** orchestrator writes
   `worktrees/agent-NNNN-slug/pending_amend.rejected.json` with the colliding
   `{id, slug}`. Researcher must split the investigation or wait.

## Lifecycle

```
spawn-worktree.ps1 → acquire mutex → collision check → write lock → commit (main)
                                                                       │
                                                                       ▼
                                                              git worktree add
                                                                       │
                                                                       ▼
                                                              researcher works
                                                                       │
                                                                       ▼
                                                              merge or abandon
                                                                       │
                                                                       ▼
reap-worktree.ps1 → acquire mutex → unlink lock → commit (main) → remove worktree
```

## Audit trail

Every lock create / amend / release commits to `physics-fixes/math-corrections`
with message `lock: spawn|amend|reap NNNN-<slug>`. The git history is the
authoritative audit log; the lock files themselves are mutable state.
