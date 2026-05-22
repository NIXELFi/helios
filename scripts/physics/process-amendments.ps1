# scripts/physics/process-amendments.ps1
#
# Spec C3 amendment protocol - orchestrator dispatch-cycle hook.
#
# Walks every active worktree under `worktrees/agent-*` and, for each
# `pending_amend.json` it finds, runs a mutex-protected collision check
# against the other live lock manifests:
#
#   - No collision:  merge `additional_files` into the manifest, commit
#                    "lock: amend NNNN-slug" on the main checkout, delete
#                    pending_amend.json.
#   - Collision:     write pending_amend.rejected.json with the colliding
#                    {id, slug}; leave pending_amend.json alone so the
#                    researcher can see the rejection. (Researcher must
#                    delete it before re-trying.)
#
# Usage:
#   .\scripts\physics\process-amendments.ps1
#
# Returns 0 even if some amendments were rejected - rejections are
# documented in-band via pending_amend.rejected.json. Non-zero return
# indicates an infrastructure failure (mutex, git, manifest parse).
#
# Spec refs: C3 amendment protocol.

param(
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$root      = (git rev-parse --show-toplevel).Trim()
$locksDir  = Join-Path $root ".physics_locks"
$worktreesDir = Join-Path $root "worktrees"
$mutex     = Join-Path $locksDir "_orchestrator.mutex"

if (-not (Test-Path $worktreesDir)) {
    Write-Host "[process-amendments] no worktrees/ dir - nothing to do"
    exit 0
}

# Collect all pending_amend.json files first (outside the mutex). The
# mutex is only acquired if we actually have work.
$pendingFiles = @(Get-ChildItem -Path $worktreesDir -Filter "pending_amend.json" -Recurse -File -ErrorAction SilentlyContinue)
if ($pendingFiles.Count -eq 0) {
    Write-Host "[process-amendments] no pending_amend.json files - nothing to do"
    exit 0
}

Write-Host "[process-amendments] found $($pendingFiles.Count) pending amendment(s)"

if ($DryRun) {
    foreach ($p in $pendingFiles) {
        Write-Host "  DRY: $($p.FullName)"
    }
    exit 0
}

# Acquire the mutex once for the whole pass. Each amendment is processed
# inside it; the mutex is released at the end. (Known Issue #13.)
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
        pid = $PID
        hostname = $env:COMPUTERNAME
        acquired_at = ([DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ"))
    } | ConvertTo-Json -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($mutexBody)
    $fs.Write($bytes, 0, $bytes.Length)
    $fs.Flush()

    $processed = 0
    $rejected = 0
    $errors = 0

    foreach ($p in $pendingFiles) {
        $wt = Split-Path -Parent $p.FullName
        $wtName = Split-Path -Leaf $wt
        if ($wtName -notmatch '^agent-(\d{4})-(.+)$') {
            Write-Warning "Skipping non-agent worktree: $wt"
            continue
        }
        $thisId4 = $matches[1]
        $thisSlug = $matches[2]
        $thisLock = Join-Path $locksDir "$thisId4-$thisSlug.lock"

        if (-not (Test-Path $thisLock)) {
            Write-Warning "[$wtName] no lock at $thisLock - skipping"
            $errors++
            continue
        }

        # Parse the amendment request.
        try {
            $amend = Get-Content $p.FullName -Raw | ConvertFrom-Json
        } catch {
            Write-Warning "[$wtName] pending_amend.json is unparseable: $($_.Exception.Message)"
            $errors++
            continue
        }

        if ($null -eq $amend.additional_files -or $amend.additional_files.Count -eq 0) {
            Write-Warning "[$wtName] pending_amend.json has empty additional_files; deleting"
            Remove-Item $p.FullName -Force
            continue
        }

        # Load this lock and merge.
        $thisManifest = Get-Content $thisLock -Raw | ConvertFrom-Json
        $existingFiles = @($thisManifest.files)
        $newFiles = @($amend.additional_files | Where-Object { $existingFiles -notcontains $_ })

        if ($newFiles.Count -eq 0) {
            Write-Host "[$wtName] amendment already merged (no new files); deleting pending_amend.json"
            Remove-Item $p.FullName -Force
            continue
        }

        # Collision check against every OTHER lock.
        $collision = $null
        $other_locks = @(Get-ChildItem -Path $locksDir -Filter "*.lock" -ErrorAction SilentlyContinue)
        foreach ($lf in $other_locks) {
            if ($lf.FullName -eq $thisLock) { continue }
            $other = Get-Content $lf.FullName -Raw | ConvertFrom-Json
            $overlap = @($other.files | Where-Object { $newFiles -contains $_ })
            if ($overlap.Count -gt 0) {
                $collision = @{ id = $other.id; slug = $other.slug; files = $overlap }
                break
            }
        }

        if ($null -ne $collision) {
            $rejPath = Join-Path $wt "pending_amend.rejected.json"
            $rejBody = @{
                requested_at = ([DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ"))
                requested_files = $newFiles
                collides_with = @{
                    id = $collision.id
                    slug = $collision.slug
                    overlapping_files = $collision.files
                }
                justification = $amend.justification
            } | ConvertTo-Json -Depth 5
            $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
            [System.IO.File]::WriteAllText($rejPath, $rejBody, $utf8NoBom)
            Write-Warning "[$wtName] REJECTED: collides with $($collision.id)-$($collision.slug) on $($collision.files -join ', '); wrote $rejPath"
            $rejected++
            continue
        }

        # No collision - merge, rewrite the manifest, commit, delete pending.
        $merged = $existingFiles + $newFiles
        $thisManifest.files = $merged
        # Re-emit JSON in stable field order.
        $rewritten = [ordered]@{
            id            = $thisManifest.id
            slug          = $thisManifest.slug
            worktree_path = $thisManifest.worktree_path
            spawned_by    = $thisManifest.spawned_by
            spawned_at    = $thisManifest.spawned_at
            files         = $merged
        } | ConvertTo-Json -Depth 5
        $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
        [System.IO.File]::WriteAllText($thisLock, $rewritten, $utf8NoBom)

        $relLock = ".physics_locks/$thisId4-$thisSlug.lock"
        Push-Location $root
        try {
            & git add $relLock | Out-Null
            $env:HELIOS_SKIP_PARITY = "1"
            try {
                & git commit -m "lock: amend $thisId4-$thisSlug" --quiet
                if ($LASTEXITCODE -ne 0) {
                    throw "git commit (amend) failed"
                }
            } finally {
                Remove-Item Env:\HELIOS_SKIP_PARITY -ErrorAction SilentlyContinue
            }
        } finally {
            Pop-Location
        }

        Remove-Item $p.FullName -Force
        $processed++
        Write-Host "[$wtName] AMENDED: +$($newFiles.Count) file(s)"
    }

    Write-Host ""
    Write-Host "[process-amendments] done: processed=$processed rejected=$rejected errors=$errors"
}
finally {
    if ($null -ne $fs) {
        $fs.Dispose()
        if (Test-Path $mutex) {
            Remove-Item $mutex -Force -ErrorAction SilentlyContinue
        }
    }
}
