# scripts/physics/spawn-worktree.ps1
#
# Spawn a physics-agent worktree (spec C2 + C3).
#
# Acquires the orchestrator mutex, runs a write-claim collision check against
# all live `.physics_locks/*.lock` manifests, writes a new manifest, commits
# the manifest on the main checkout, then `git worktree add`s a worktree and
# sets `core.hooksPath = .githooks` inside it.
#
# Usage:
#   .\scripts\physics\spawn-worktree.ps1 `
#       -Id 42 `
#       -Slug "woschni-c1-c2" `
#       -Files @("crates/engine-sim/src/cylinder/heat.rs",
#                "crates/cfd-core/tests/regressions_0042_woschni_c1_c2.rs") `
#       -BaseBranch "physics-fixes/math-corrections" `
#       -SpawnedBy "manual"
#
# Spec refs:
#   - C2 - agent isolation via git worktree + per-worktree CARGO_TARGET_DIR
#   - C3 - lock manifest + orchestrator mutex (O_EXCL create)
#   - C5 - pre-commit hook re-activated per worktree

param(
    [Parameter(Mandatory=$true)][int]$Id,
    [Parameter(Mandatory=$true)][string]$Slug,
    [Parameter(Mandatory=$true)][string[]]$Files,
    [string]$BaseBranch = "physics-fixes/math-corrections",
    [ValidateSet("manual","cron")][string]$SpawnedBy = "manual"
)

$ErrorActionPreference = "Stop"

# ----------------------------------------------------------------------
# Resolve paths. All paths committed into the manifest use forward
# slashes (Known Issue I-8) so the pre-commit hook's path comparison is
# OS-agnostic.
# ----------------------------------------------------------------------
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

# Normalize the manifest path to forward slashes (Known Issue I-8).
$worktreePath = "worktrees/$dirname"

# ----------------------------------------------------------------------
# 1. Acquire orchestrator mutex via O_EXCL create.
#    `FileMode::CreateNew` returns FileNotFoundException if the file
#    exists OR if the parent dir is missing. We've ensured the parent
#    above, so a failure here means another orchestrator holds it.
#
#    Known Issue #13: $fs MUST be initialized to $null BEFORE the try,
#    so the `finally` cleanup can distinguish a failed acquire from a
#    successful one - Remove-Item must not run on someone else's mutex.
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
    # 2. Collision check - read every other `*.lock` manifest, refuse if
    #    any file in $Files is already claimed.
    # ----------------------------------------------------------------------
    if (Test-Path $lockFile) {
        Write-Error "Lock already exists for id=$Id slug=$Slug at $lockFile"
        exit 1
    }
    $existing = @(Get-ChildItem -Path $locksDir -Filter "*.lock" -ErrorAction SilentlyContinue)
    foreach ($lf in $existing) {
        $other = Get-Content $lf.FullName -Raw | ConvertFrom-Json
        if ($null -eq $other.files) { continue }
        $overlap = @($other.files | Where-Object { $Files -contains $_ })
        if ($overlap.Count -gt 0) {
            $msg = "COLLISION with lock $($other.id)-$($other.slug): files=" + ($overlap -join ",")
            Write-Error $msg
            exit 1
        }
    }

    # ----------------------------------------------------------------------
    # 3. Write the manifest JSON.
    # ----------------------------------------------------------------------
    $manifest = [ordered]@{
        id            = $Id
        slug          = $Slug
        worktree_path = $worktreePath
        spawned_by    = $SpawnedBy
        spawned_at    = ([DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ"))
        files         = @($Files)
    }
    # ConvertTo-Json with -Depth 5 is enough for this flat schema.
    # Write UTF-8 WITHOUT BOM — PowerShell 5.1's `Set-Content -Encoding UTF8`
    # emits a BOM that serde_json refuses. Use .NET directly.
    $json = $manifest | ConvertTo-Json -Depth 5
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($lockFile, $json, $utf8NoBom)

    # ----------------------------------------------------------------------
    # 4. Commit the manifest on main. The orchestrator commits on the
    #    base branch directly (HEAD == $BaseBranch is the precondition).
    #    We use HELIOS_SKIP_PARITY=1 because this is a ledger-only commit
    #    on the main checkout - the doctor merge gate is the real backstop.
    # ----------------------------------------------------------------------
    Push-Location $root
    try {
        $relLock = ".physics_locks/$id4-$Slug.lock"
        & git add $relLock | Out-Null
        $env:HELIOS_SKIP_PARITY = "1"
        try {
            & git commit -m "lock: spawn $id4-$Slug" --quiet
            if ($LASTEXITCODE -ne 0) {
                throw "git commit failed (exit $LASTEXITCODE)"
            }
        } finally {
            Remove-Item Env:\HELIOS_SKIP_PARITY -ErrorAction SilentlyContinue
        }
    } finally {
        Pop-Location
    }

    # ----------------------------------------------------------------------
    # 5. git worktree add.
    # ----------------------------------------------------------------------
    Push-Location $root
    try {
        & git worktree add -b $branch $worktree $BaseBranch | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "git worktree add failed (exit $LASTEXITCODE)"
        }
    } finally {
        Pop-Location
    }

    # ----------------------------------------------------------------------
    # 6. Activate the hooks inside the worktree (spec C5).
    # ----------------------------------------------------------------------
    Push-Location $worktree
    try {
        & git config --local core.hooksPath ".githooks"
        $hp = (& git config --get core.hooksPath).Trim()
        if ($hp -ne ".githooks") {
            throw "core.hooksPath verification failed inside worktree: got '$hp'"
        }
    } finally {
        Pop-Location
    }

    # ----------------------------------------------------------------------
    # 7. Warm the worktree's target/ by building helios-bench.
    #    Per-worktree CARGO_TARGET_DIR keeps the per-agent target tree
    #    isolated (spec C2). The pre-commit hook looks here first.
    # ----------------------------------------------------------------------
    Push-Location $worktree
    try {
        $prevTarget = $env:CARGO_TARGET_DIR
        $env:CARGO_TARGET_DIR = (Join-Path $worktree "target")
        try {
            & cargo build --quiet -p helios-bench
            if ($LASTEXITCODE -ne 0) {
                Write-Warning "cargo build -p helios-bench inside worktree returned exit $LASTEXITCODE (continuing - hook will fall back to cargo run)"
            }
        } finally {
            if ($null -ne $prevTarget) {
                $env:CARGO_TARGET_DIR = $prevTarget
            } else {
                Remove-Item Env:\CARGO_TARGET_DIR -ErrorAction SilentlyContinue
            }
        }
    } finally {
        Pop-Location
    }

    Write-Host ""
    Write-Host "Spawned worktree:"
    Write-Host "  path:   $worktree"
    Write-Host "  branch: $branch"
    Write-Host "  lock:   $lockFile"
    Write-Host ""
    Write-Host "Before any commit in the worktree, export the marker:"
    Write-Host "  PowerShell: `$env:HELIOS_PHYSICS_AGENT = '1'"
    Write-Host "  bash:       export HELIOS_PHYSICS_AGENT=1"
    Write-Host ""
    Write-Host "Per-worktree CARGO_TARGET_DIR (recommended):"
    Write-Host "  PowerShell: `$env:CARGO_TARGET_DIR = (Join-Path '$worktree' 'target')"
}
finally {
    # ----------------------------------------------------------------------
    # 8. Release mutex. Known Issue #13: guard Remove-Item by `if ($fs)`
    #    so a failed acquire does NOT delete a mutex held by another
    #    process.
    # ----------------------------------------------------------------------
    if ($null -ne $fs) {
        $fs.Dispose()
        if (Test-Path $mutex) {
            Remove-Item $mutex -Force -ErrorAction SilentlyContinue
        }
    }
}
