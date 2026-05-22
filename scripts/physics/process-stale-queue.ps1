# scripts/physics/process-stale-queue.ps1
#
# Spec C8 - drain physics_findings/_stale_queue.ndjson.
#
# Each line in the stale queue is a JSON event emitted by the doctor when
# a closed finding's `baseline_fingerprint` files were touched by a later
# merge. Format (per spec §4.5):
#
#     {"id": 42, "slug": "woschni-c1-c2", "reason": "merge of #117 touched ..."}
#
# This script:
#   - reads the queue,
#   - for each event flips the affected `physics_findings/NNNN-slug/finding.md`
#     YAML frontmatter `status: <X>` to `status: STALE`,
#   - appends a `## Revalidations` entry recording the trigger,
#   - bumps `revalidation_count`,
#   - commits "stale: re-open NNNN-slug" on main,
#   - truncates the stale queue once all events have been processed.
#
# The orchestrator picks up STALE findings on its next dispatch cycle
# (it re-queues them as INVESTIGATING when spawning a revalidation run -
# see scripts/physics/spawn-worktree.ps1's `revalidation_N` suffix support).
#
# Usage: .\scripts\physics\process-stale-queue.ps1 [-DryRun]
#
# Spec refs: C7 (status states), C8 (staleness), §4.5 STALE re-open lifecycle.

param(
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$root         = (git rev-parse --show-toplevel).Trim()
$findingsDir  = Join-Path $root "physics_findings"
$queueFile    = Join-Path $findingsDir "_stale_queue.ndjson"
$locksDir     = Join-Path $root ".physics_locks"
$mutex        = Join-Path $locksDir "_orchestrator.mutex"

if (-not (Test-Path $queueFile)) {
    Write-Host "[process-stale-queue] no $queueFile - nothing to do"
    exit 0
}

$lines = @(Get-Content $queueFile -Encoding UTF8 | Where-Object { $_.Trim().Length -gt 0 })
if ($lines.Count -eq 0) {
    Write-Host "[process-stale-queue] queue empty - nothing to do"
    exit 0
}

Write-Host "[process-stale-queue] $($lines.Count) event(s) queued"

if ($DryRun) {
    foreach ($l in $lines) { Write-Host "  DRY: $l" }
    exit 0
}

# Mutex (same primitive - flipping status is a metadata write under the
# orchestrator's serialization rule, even though it doesn't touch the
# locks dir itself).
if (-not (Test-Path $locksDir)) { New-Item -ItemType Directory -Force -Path $locksDir | Out-Null }
$fs = $null
try {
    $fs = [System.IO.FileStream]::new(
        $mutex, [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::Write, [System.IO.FileShare]::None
    )
} catch {
    Write-Error "Failed to acquire orchestrator mutex at $mutex: $($_.Exception.Message)"
    exit 1
}

try {
    $mutexBody = @{
        pid = $PID
        hostname = $env:COMPUTERNAME
        acquired_at = ([DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ"))
    } | ConvertTo-Json -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($mutexBody)
    $fs.Write($bytes, 0, $bytes.Length); $fs.Flush()

    $flipped = 0
    $skipped = 0

    foreach ($line in $lines) {
        try {
            $evt = $line | ConvertFrom-Json
        } catch {
            Write-Warning "  unparseable event: $line"
            $skipped++
            continue
        }

        $eid4 = "{0:D4}" -f [int]$evt.id
        $eslug = [string]$evt.slug
        $findingDir = Join-Path $findingsDir "$eid4-$eslug"
        $findingMd = Join-Path $findingDir "finding.md"

        if (-not (Test-Path $findingMd)) {
            Write-Warning "  missing finding.md for $eid4-$eslug; skipping"
            $skipped++
            continue
        }

        $body = Get-Content $findingMd -Raw -Encoding UTF8

        # Flip `status:` line inside the YAML frontmatter (first --- block).
        $newBody = [regex]::Replace(
            $body,
            '^(?<pre>---\r?\n[\s\S]*?\r?\nstatus:[ \t]*)(?<val>[A-Z_-]+)',
            { param($m) "$($m.Groups['pre'].Value)STALE" },
            [System.Text.RegularExpressions.RegexOptions]::Multiline
        )

        # Bump revalidation_count if present, else add it.
        if ($newBody -match '^revalidation_count:[ \t]*(\d+)' ) {
            $newBody = [regex]::Replace(
                $newBody,
                '^(?<pre>revalidation_count:[ \t]*)(?<n>\d+)',
                { param($m) "$($m.Groups['pre'].Value)$(([int]$m.Groups['n'].Value) + 1)" },
                [System.Text.RegularExpressions.RegexOptions]::Multiline
            )
        } else {
            $newBody = $newBody -replace '(?ms)^(?<pre>---\r?\n[\s\S]*?status:[ \t]*STALE)', "`${pre}`r`nrevalidation_count: 1"
        }

        # Append a Revalidations section entry.
        $entry = @"

## Revalidations

- $([DateTime]::UtcNow.ToString("yyyy-MM-dd")): re-opened via _stale_queue.ndjson event:
  ``````
  $line
  ``````
"@
        $newBody += $entry

        $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
        [System.IO.File]::WriteAllText($findingMd, $newBody, $utf8NoBom)
        $flipped++
        Write-Host "  flipped $eid4-$eslug -> STALE"
    }

    # Truncate the queue (atomic-by-os since we own the mutex).
    Clear-Content $queueFile

    Push-Location $root
    try {
        # Stage everything we changed under physics_findings/ + the cleared queue.
        & git add physics_findings/_stale_queue.ndjson | Out-Null
        & git add physics_findings/*/finding.md | Out-Null
        $env:HELIOS_SKIP_PARITY = "1"
        try {
            $diff = (& git diff --cached --name-only)
            if ([string]::IsNullOrWhiteSpace($diff)) {
                Write-Host "[process-stale-queue] no changes to commit"
            } else {
                & git commit -m "stale: drain queue ($flipped flipped, $skipped skipped)" --quiet
                if ($LASTEXITCODE -ne 0) { throw "git commit failed" }
            }
        } finally {
            Remove-Item Env:\HELIOS_SKIP_PARITY -ErrorAction SilentlyContinue
        }
    } finally {
        Pop-Location
    }

    Write-Host ""
    Write-Host "[process-stale-queue] done: flipped=$flipped skipped=$skipped"
}
finally {
    if ($null -ne $fs) {
        $fs.Dispose()
        if (Test-Path $mutex) { Remove-Item $mutex -Force -ErrorAction SilentlyContinue }
    }
}
