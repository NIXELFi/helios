# scripts/physics/reap-worktree.ps1
#
# Tear down a physics-agent worktree.
#
# Inside the orchestrator mutex:
#   1. Verify there is no `pending_amend.json` in the worktree.
#   2. `git worktree remove` (forced).
#   3. Delete the branch `physics/agent-NNNN-slug` if it exists.
#   4. Delete the lock manifest from `.physics_locks/`.
#   5. Commit "lock: reap NNNN-slug" on the main checkout.
#
# Usage:
#   .\scripts\physics\reap-worktree.ps1 -Id 42 -Slug "woschni-c1-c2"
#
# Spec refs: C2, C3.

param(
    [Parameter(Mandatory=$true)][int]$Id,
    [Parameter(Mandatory=$true)][string]$Slug,
    [switch]$Force,
    [switch]$KeepBranch
)

$ErrorActionPreference = "Stop"

$root      = (git rev-parse --show-toplevel).Trim()
$id4       = "{0:D4}" -f $Id
$dirname   = "agent-$id4-$Slug"
$worktree  = Join-Path (Join-Path $root "worktrees") $dirname
$branch    = "physics/$dirname"
$locksDir  = Join-Path $root ".physics_locks"
$lockFile  = Join-Path $locksDir "$id4-$Slug.lock"
$mutex     = Join-Path $locksDir "_orchestrator.mutex"

if (-not (Test-Path $locksDir)) {
    New-Item -ItemType Directory -Force -Path $locksDir | Out-Null
}

# ----------------------------------------------------------------------
# 1. Acquire mutex (same Known Issue #13 guard).
# ----------------------------------------------------------------------
$fs = $null
try {
    $fs = [System.IO.FileStream]::new(
        $mutex,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None
    )
} catch {
    Write-Error "Failed to acquire orchestrator mutex at $mutex (held by another process?): $($_.Exception.Message)"
    exit 1
}

try {
    $mutexBody = @{
        pid         = $PID
        hostname    = $env:COMPUTERNAME
        acquired_at = ([DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ"))
    } | ConvertTo-Json -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($mutexBody)
    $fs.Write($bytes, 0, $bytes.Length)
    $fs.Flush()

    # ----------------------------------------------------------------------
    # 2. Re-parse the manifest via helios-bench (proves it parses) AND
    #    refuse to reap if there's a `pending_amend.json` still in flight
    #    - that would silently lose the amendment request.
    # ----------------------------------------------------------------------
    if (Test-Path $lockFile) {
        Push-Location $root
        try {
            $hb = $null
            foreach ($cand in @(
                "target/debug/helios-bench.exe",
                "target/debug/helios-bench",
                "target/release/helios-bench.exe",
                "target/release/helios-bench"
            )) {
                if (Test-Path $cand) { $hb = $cand; break }
            }
            if ($null -ne $hb) {
                & $hb locks parse-manifest $lockFile | Out-Null
            } else {
                & cargo run --quiet -p helios-bench -- locks parse-manifest $lockFile | Out-Null
            }
            if ($LASTEXITCODE -ne 0) {
                throw "manifest $lockFile failed to parse"
            }
        } finally {
            Pop-Location
        }
    } else {
        if (-not $Force) {
            Write-Warning "Lock file $lockFile is missing - proceeding (manifest already released?)"
        }
    }

    $pending = Join-Path $worktree "pending_amend.json"
    if (Test-Path $pending) {
        if ($Force) {
            Write-Warning "pending_amend.json present but -Force given; discarding amendment request"
        } else {
            Write-Error "Worktree has unprocessed pending_amend.json: $pending`nRun process-amendments.ps1 first, or pass -Force to discard."
            exit 1
        }
    }

    # ----------------------------------------------------------------------
    # 3. git worktree remove. We do not push the branch; deletion is fine
    #    once the work has merged.
    # ----------------------------------------------------------------------
    if (Test-Path $worktree) {
        Push-Location $root
        try {
            & git worktree remove --force $worktree 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) {
                throw "git worktree remove failed (exit $LASTEXITCODE)"
            }
        } finally {
            Pop-Location
        }
    } else {
        # If worktree dir is gone but git still tracks it, prune.
        Push-Location $root
        try { & git worktree prune | Out-Null } finally { Pop-Location }
    }

    if (-not $KeepBranch) {
        # The branch holds the unmerged investigation work; the user must
        # have merged or abandoned it before reap. Delete with -D so
        # unmerged work loss is explicit (the orchestrator decides the
        # disposition before calling reap).
        Push-Location $root
        try {
            & git show-ref --verify --quiet "refs/heads/$branch"
            if ($LASTEXITCODE -eq 0) {
                & git branch -D $branch | Out-Null
            }
        } finally {
            Pop-Location
        }
    }

    # ----------------------------------------------------------------------
    # 4. Delete the lock manifest and commit the reap on main.
    # ----------------------------------------------------------------------
    Push-Location $root
    try {
        if (Test-Path $lockFile) {
            $relLock = ".physics_locks/$id4-$Slug.lock"
            & git rm --quiet $relLock | Out-Null
            $env:HELIOS_SKIP_PARITY = "1"
            try {
                & git commit -m "lock: reap $id4-$Slug" --quiet
                if ($LASTEXITCODE -ne 0) {
                    throw "git commit (reap) failed (exit $LASTEXITCODE)"
                }
            } finally {
                Remove-Item Env:\HELIOS_SKIP_PARITY -ErrorAction SilentlyContinue
            }
        }
    } finally {
        Pop-Location
    }

    Write-Host "Reaped: $dirname"
}
finally {
    if ($null -ne $fs) {
        $fs.Dispose()
        if (Test-Path $mutex) {
            Remove-Item $mutex -Force -ErrorAction SilentlyContinue
        }
    }
}
