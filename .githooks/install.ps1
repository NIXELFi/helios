# Activate the in-repo physics-fixes git hooks for this checkout.
#
# Sets core.hooksPath = .githooks locally (does NOT touch global config).
# Idempotent — safe to re-run.
#
# Usage:
#   .\.githooks\install.ps1
#
# The worktree spawn script (scripts/physics/spawn-worktree.ps1) calls this
# automatically inside each spawned worktree.

$ErrorActionPreference = "Stop"

$repoRoot = (git rev-parse --show-toplevel).Trim()
Push-Location $repoRoot
try {
    git config --local core.hooksPath ".githooks"
    $hp = (git config --get core.hooksPath).Trim()
    if ($hp -ne ".githooks") {
        Write-Error "core.hooksPath did not stick - got '$hp'"
        exit 1
    }
    Write-Host "core.hooksPath = .githooks"
    Write-Host "pre-commit hook activated"
}
finally {
    Pop-Location
}
