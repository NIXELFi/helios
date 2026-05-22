# scripts/physics — orchestrator worktree lifecycle

PowerShell + bash scripts driving the physics-agent worktree contract.
Each script has both a `.ps1` and a `.sh` variant; behavior is identical
across platforms.

**Spec:** [../../docs/superpowers/specs/2026-05-22-physics-agent-loop-design.md](../../docs/superpowers/specs/2026-05-22-physics-agent-loop-design.md) (constraints C2, C3, C5, C7, C8 — see §4.5).

## Scripts

| Script | Purpose |
|---|---|
| `spawn-worktree.{ps1,sh}`        | Create a worktree + manifest + activate hooks (spec C2 + C3 + C5). |
| `reap-worktree.{ps1,sh}`         | Tear down a worktree + release its manifest. |
| `process-amendments.{ps1,sh}`    | Drain `worktrees/agent-*/pending_amend.json` files (spec C3 amendment protocol). |
| `process-stale-queue.{ps1,sh}`   | Drain `physics_findings/_stale_queue.ndjson` (spec C8 STALE re-open). |

All scripts serialize through `.physics_locks/_orchestrator.mutex`
(O_EXCL create / `FileMode::CreateNew`). Mutex content is JSON
`{pid, hostname, acquired_at}` — see [.physics_locks/README.md](../../.physics_locks/README.md).

## spawn-worktree

**PowerShell:**
```powershell
.\scripts\physics\spawn-worktree.ps1 `
    -Id 42 `
    -Slug "woschni-c1-c2" `
    -Files @("crates/engine-sim/src/cylinder/heat.rs",
             "crates/cfd-core/tests/regressions_0042_woschni_c1_c2.rs") `
    -BaseBranch "physics-fixes/math-corrections" `
    -SpawnedBy "manual"
```

**bash:**
```bash
./scripts/physics/spawn-worktree.sh \
    --id 42 \
    --slug woschni-c1-c2 \
    --files "crates/engine-sim/src/cylinder/heat.rs,crates/cfd-core/tests/regressions_0042_woschni_c1_c2.rs"
```

What it does:

1. Acquire `.physics_locks/_orchestrator.mutex` via O_EXCL.
2. Collision-check `$Files` against every other `.physics_locks/*.lock`.
3. Write `.physics_locks/NNNN-slug.lock` (forward-slash worktree_path per Known Issue I-8).
4. Commit `lock: spawn NNNN-slug` on the main checkout. The ledger commit
   runs with `HELIOS_SKIP_PARITY=1` — it's a metadata-only write on the
   main checkout and the doctor merge gate is the authoritative backstop.
5. `git worktree add -b physics/agent-NNNN-slug worktrees/agent-NNNN-slug`.
6. `git config --local core.hooksPath .githooks` inside the worktree, then
   verify the read-back matches (spec C5).
7. Warm the worktree's `target/` by running `cargo build --quiet -p helios-bench`
   so the pre-commit hook has a binary to call without a cargo run on the
   commit path.
8. Release the mutex.

**Researcher startup — MUST do this in the worktree shell before any commit:**

PowerShell:
```powershell
$env:HELIOS_PHYSICS_AGENT = '1'
$env:CARGO_TARGET_DIR = (Resolve-Path .).Path + "\target"
```

bash:
```bash
export HELIOS_PHYSICS_AGENT=1
export CARGO_TARGET_DIR="$(pwd)/target"
```

The marker is the spec C5 `--no-verify` defense — the pre-commit hook
refuses commits from `worktrees/agent-*` without it. We do not auto-set
the marker by writing it into an `.envrc` (direnv-style autoload would
defeat the defense; the worker's intent to commit must be explicit).

## reap-worktree

```powershell
.\scripts\physics\reap-worktree.ps1 -Id 42 -Slug "woschni-c1-c2"
# or with -Force to discard an unprocessed pending_amend.json
# or with -KeepBranch to leave physics/agent-NNNN-slug behind
```

```bash
./scripts/physics/reap-worktree.sh --id 42 --slug woschni-c1-c2 [--force] [--keep-branch]
```

Refuses if `worktrees/agent-NNNN-slug/pending_amend.json` exists — run
`process-amendments` first or pass `--force` (the orchestrator should not
discard a researcher's amendment without explicit intent).

Steps inside the mutex:

1. Re-parse `.physics_locks/NNNN-slug.lock` via `helios-bench locks parse-manifest`
   (proves the manifest is well-formed before it's deleted; the parsed
   files[] is what the doctor consults at merge time to compute the
   fingerprint diff).
2. `git worktree remove --force` (or `git worktree prune` if the dir is
   already gone).
3. Delete the branch (`git branch -D`) unless `--keep-branch`.
4. `git rm .physics_locks/NNNN-slug.lock` and commit
   `lock: reap NNNN-slug` on the main checkout (`HELIOS_SKIP_PARITY=1`).

## process-amendments

Spec §4.5 step 1 (a): on every orchestrator dispatch cycle, before picking
the next finding, the orchestrator drains pending amendments.

```powershell
.\scripts\physics\process-amendments.ps1 [-DryRun]
```

```bash
./scripts/physics/process-amendments.sh [--dry-run]
```

Inside the mutex it iterates `worktrees/agent-*/pending_amend.json`, runs
the collision check against every other lock, and either:

- **No collision:** rewrites the affected manifest with the merged
  `files[]` list, commits `lock: amend NNNN-slug` on main, deletes the
  `pending_amend.json`.
- **Collision:** writes `pending_amend.rejected.json` next to the request
  with `{requested_at, requested_files, collides_with_lock, overlapping_file}`.
  The original `pending_amend.json` is left in place so the researcher can
  see the rejection on their next pull — they must delete it before
  re-trying with a narrower request.

Exit code is 0 even if some amendments were rejected — that's a normal
in-band outcome. Non-zero indicates an infrastructure failure (mutex,
git, parse error).

## process-stale-queue

Spec C8: drain `physics_findings/_stale_queue.ndjson` — events appended
by the doctor when a closed finding's fingerprint files were touched by
a later merge.

```powershell
.\scripts\physics\process-stale-queue.ps1 [-DryRun]
```

```bash
./scripts/physics/process-stale-queue.sh [--dry-run]
```

For each event `{id, slug, reason}`:

- Flip the YAML frontmatter `status:` line in `physics_findings/NNNN-slug/finding.md`
  to `STALE`.
- Bump `revalidation_count` (or initialize to 1 if absent).
- Append a `## Revalidations` entry recording the event line.

Then truncate the queue and commit `stale: drain queue (...)` on main.

On its next dispatch cycle the orchestrator picks up the flipped findings
and spawns revalidation worktrees with the `revalidation_N` suffix
(per spec §4.5 STALE re-open lifecycle).

## Common semantics

- **Mutex held across the whole operation.** All scripts acquire the
  mutex at start and release it at exit (the PowerShell `finally` is
  guarded by `if ($null -ne $fs)` per Known Issue #13 so a failed
  acquire doesn't unlink another process's mutex).
- **No python or jq dependency.** Lock manifests are read via
  `helios-bench locks parse-manifest`. The bash scripts do shallow
  grep/sed parsing of `pending_amend.json` since the schema is flat;
  if the schema grows, add a `helios-bench locks parse-amend` subcommand
  rather than introducing a python dependency in the orchestrator path.
- **Forward-slash paths in manifests** (Known Issue I-8). PowerShell
  constructs `worktree_path` as `worktrees/agent-NNNN-slug` directly.
- **Ledger commits use `HELIOS_SKIP_PARITY=1`** on the main checkout —
  they're metadata-only and the doctor merge gate is the backstop.
  Inside worktrees this env var is explicitly rejected by the pre-commit
  hook.
