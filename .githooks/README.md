# Helios Physics-Fixes Git Hooks

In-repo pre-commit hooks enforcing the physics-agent-loop's safety contract.

**Spec:** [../docs/superpowers/specs/2026-05-22-physics-agent-loop-design.md](../docs/superpowers/specs/2026-05-22-physics-agent-loop-design.md), constraints **C3** (lock manifest) and **C5** (parity gate).

## What the pre-commit hook enforces

1. **Manifest membership (C3).** Inside an agent worktree (`worktrees/agent-NNNN-<slug>/`), every staged file must appear in the worktree's write-claim manifest at `.physics_locks/NNNN-<slug>.lock` — *except* for paths in the standing allowlist:
   - `physics_findings/NNNN-<slug>/...` — the finding's own directory
   - `tmp/...` — scratch space
   - `target/...` — build artifacts
   - `Cargo.lock` — per-worktree lockfile
   - Top-level `*.md` files — progress notes
2. **`python_ref/` lockout (C3).** Any staged path under `crates/engine-sim/python_ref/` is rejected unconditionally. This protects the parity anchor.
3. **`.physics_locks/` write-from-worktree lockout (C3).** Lock-ledger writes from inside an agent worktree are rejected. Only the main checkout (orchestrator) touches the ledger.
4. **`HELIOS_PHYSICS_AGENT=1` marker (C5).** Commits inside an agent worktree must set the marker env var. Without it, the hook refuses — this is the `--no-verify` defense.
5. **Parity suite (C5).** `cargo test -p engine-sim --test parity_…` and `cargo test -p cfd-core --test parity_…` (one invocation per crate, all `parity_*.rs` files enumerated dynamically) must pass before any commit lands.

## Install

The hook is committed to the repo; activation sets `core.hooksPath = .githooks` in `.git/config` (local to the clone, never global). It must be run once per clone — and the worktree spawn script re-asserts it inside every new worktree.

**PowerShell (Windows):**
```powershell
.\.githooks\install.ps1
```

**bash (Git for Windows, macOS, Linux):**
```bash
./.githooks/install.sh
```

The Git for Windows install comes with a bundled msys2 bash — the hook scripts run there directly when `git commit` invokes them. **No separate WSL or Cygwin install is required.** This is the standard Helios development environment on Windows.

Verify activation:
```bash
git config --get core.hooksPath
# expected: .githooks
```

## Bypass policy

`--no-verify` is **policy-forbidden inside agent worktrees.** The hook self-checks `HELIOS_PHYSICS_AGENT=1`; without it, commits from a worktree are refused even before `--no-verify` skips the rest of the hook (the marker check is part of the worktree-spawn handshake).

From the **main checkout**, `--no-verify` is permitted for orchestrator emergencies (e.g., committing a stale-lock cleanup). The doctor's per-merge gate (spec C5 belt-and-suspenders) is the authoritative backstop — a `--no-verify`'d commit that lands on the investigation branch is rejected at doctor time and auto-reverted per C1.

### Environment-variable escape hatches

| Variable | Effect | Honored inside agent worktree? |
|---|---|---|
| `HELIOS_HOOKS_DISABLE=1` | Skip the entire hook | No — the hook still runs the marker check first (the marker fails the commit before this is read). For debugging the hook itself on the main checkout only. |
| `HELIOS_SKIP_PARITY=1` | Skip the parity suite | **No** — explicitly rejected with an error inside agent worktrees. Permitted on the main checkout for orchestrator ledger-only commits. |
| `HELIOS_PHYSICS_AGENT=1` | **Required** for commits inside agent worktrees | Set by `scripts/physics/spawn-worktree.*` documentation; researchers must export it in the shell that runs `git commit`. |

## Maintenance

- New parity tests are picked up automatically by `lib/parity_runner.sh` — it enumerates `crates/*/tests/parity_*.rs` at hook-run time. Drop a new file there and the gate picks it up on the next commit.
- The hook reads the manifest via `helios-bench locks parse-manifest`. It tries pre-built binaries first (worktree's then main checkout's `target/debug` then `target/release`), falling back to `cargo run --quiet`. The worktree spawn script warms the binary so the hook never has to compile on the hot path.
- The hook is bash. There is no `pre-commit.ps1` — git invokes the bash script directly under Git for Windows' bundled msys2 (Known Issue I-6).

## File list

- `pre-commit` — the gate (bash, executable)
- `lib/parity_runner.sh` — sourced helper (parity test enumeration)
- `install.sh` / `install.ps1` — set `core.hooksPath` locally
- `README.md` — this file
