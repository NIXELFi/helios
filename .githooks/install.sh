#!/usr/bin/env bash
#
# Activate the in-repo physics-fixes git hooks for this checkout.
#
# Sets `core.hooksPath = .githooks` locally (does NOT touch global config) and
# marks the hook scripts executable. Idempotent — safe to re-run.
#
# Usage:
#   ./.githooks/install.sh
#
# The worktree spawn script (`scripts/physics/spawn-worktree.sh`) calls this
# automatically inside each spawned worktree.

set -e

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

git config --local core.hooksPath .githooks
chmod +x .githooks/pre-commit
chmod +x .githooks/install.sh

# `lib/parity_runner.sh` is sourced, not executed — no chmod needed but
# we set it for consistency on filesystems where executable bit matters.
if [[ -f .githooks/lib/parity_runner.sh ]]; then
    chmod +x .githooks/lib/parity_runner.sh || true
fi

hp="$(git config --get core.hooksPath)"
if [[ "$hp" != ".githooks" ]]; then
    echo "ERROR: core.hooksPath did not stick — got '$hp'" >&2
    exit 1
fi

echo "core.hooksPath = .githooks"
echo "pre-commit hook activated"
