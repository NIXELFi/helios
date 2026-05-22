#!/usr/bin/env bash
#
# scripts/physics/process-stale-queue.sh
#
# bash counterpart of process-stale-queue.ps1. Drains
# `physics_findings/_stale_queue.ndjson`, flips affected findings to
# `status: STALE`, bumps `revalidation_count`, and commits on main.
#
# Schema of each NDJSON event:
#   {"id": 42, "slug": "woschni-c1-c2", "reason": "merge of #117 touched ..."}
#
# Usage: ./scripts/physics/process-stale-queue.sh [--dry-run]
#
# Spec refs: C7, C8.

set -e
set -u

dry_run=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run) dry_run=1; shift ;;
        --help|-h) sed -n '3,13p' "$0"; exit 0 ;;
        *) echo "ERROR: unknown arg '$1'" >&2; exit 2 ;;
    esac
done

root="$(git rev-parse --show-toplevel)"
findings_dir="$root/physics_findings"
queue="$findings_dir/_stale_queue.ndjson"
locks_dir="$root/.physics_locks"
mutex="$locks_dir/_orchestrator.mutex"

if [[ ! -f "$queue" ]]; then
    echo "[process-stale-queue] no $queue — nothing to do"
    exit 0
fi

# Pre-filter blank lines.
lines=()
while IFS= read -r l; do
    [[ -z "${l// /}" ]] && continue
    lines+=("$l")
done < "$queue"

if [[ ${#lines[@]} -eq 0 ]]; then
    echo "[process-stale-queue] queue empty — nothing to do"
    exit 0
fi

echo "[process-stale-queue] ${#lines[@]} event(s) queued"
if [[ "$dry_run" -eq 1 ]]; then
    for l in "${lines[@]}"; do echo "  DRY: $l"; done
    exit 0
fi

mkdir -p "$locks_dir"
acquired=0
(
    set -C
    printf '{"pid":%d,"hostname":"%s","acquired_at":"%s"}\n' \
        "$$" "$(hostname 2>/dev/null || echo unknown)" \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$mutex"
) && acquired=1 || true

if [[ "$acquired" -ne 1 ]]; then
    echo "ERROR: failed to acquire orchestrator mutex at $mutex" >&2
    exit 1
fi

cleanup() {
    rc=$?
    if [[ "$acquired" -eq 1 ]]; then rm -f "$mutex" || true; fi
    exit $rc
}
trap cleanup EXIT INT TERM

flipped=0
skipped=0
today="$(date -u +%Y-%m-%d)"

# Shallow JSON field extract (no python; no jq).
field() {
    local key="$1" json="$2"
    printf '%s' "$json" \
        | grep -oE "\"$key\"[[:space:]]*:[[:space:]]*(\"[^\"]*\"|[0-9]+)" \
        | head -1 \
        | sed -E 's/^[^:]*:[[:space:]]*//' \
        | sed -E 's/^"(.*)"$/\1/'
}

for line in "${lines[@]}"; do
    eid="$(field id "$line")"
    eslug="$(field slug "$line")"
    if [[ -z "$eid" || -z "$eslug" ]]; then
        echo "  WARN unparseable event: $line" >&2
        skipped=$((skipped+1))
        continue
    fi
    eid4="$(printf '%04d' "$eid")"
    fmd="$findings_dir/$eid4-$eslug/finding.md"
    if [[ ! -f "$fmd" ]]; then
        echo "  WARN missing $fmd" >&2
        skipped=$((skipped+1))
        continue
    fi

    # Flip the YAML frontmatter status line. We use awk to only touch the
    # first `status:` after the opening `---`.
    awk -v today="$today" -v evt="$line" '
        BEGIN { in_fm=0; seen_status=0; seen_rev=0; }
        NR==1 && /^---/ { in_fm=1; print; next }
        in_fm && /^---/ { in_fm=0; print; next }
        in_fm && /^status:/ && !seen_status { print "status: STALE"; seen_status=1; next }
        in_fm && /^revalidation_count:/ && !seen_rev {
            sub(/^revalidation_count:[ \t]*/, "");
            n=$0+1;
            print "revalidation_count: " n;
            seen_rev=1; next
        }
        { print }
        END {
            if (!seen_rev) {
                # appended below by shell — awk has no easy way to know if
                # frontmatter ended yet. Shell handles it.
            }
        }
    ' "$fmd" > "$fmd.tmp"
    mv "$fmd.tmp" "$fmd"

    # If no revalidation_count existed, add it just before the closing `---`.
    if ! grep -q '^revalidation_count:' "$fmd"; then
        awk '
            BEGIN { in_fm=0; emitted=0; }
            NR==1 && /^---/ { in_fm=1; print; next }
            in_fm && /^---/ && !emitted { print "revalidation_count: 1"; emitted=1; in_fm=0; print; next }
            { print }
        ' "$fmd" > "$fmd.tmp"
        mv "$fmd.tmp" "$fmd"
    fi

    # Append a Revalidations entry.
    {
        printf '\n## Revalidations\n\n'
        printf -- '- %s: re-opened via _stale_queue.ndjson event:\n' "$today"
        printf '  ```\n  %s\n  ```\n' "$line"
    } >> "$fmd"

    flipped=$((flipped+1))
    echo "  flipped $eid4-$eslug -> STALE"
done

# Truncate the queue.
: > "$queue"

(
    cd "$root"
    git add physics_findings/_stale_queue.ndjson
    git add physics_findings/*/finding.md 2>/dev/null || true
    if [[ -n "$(git diff --cached --name-only)" ]]; then
        HELIOS_SKIP_PARITY=1 git commit -m "stale: drain queue ($flipped flipped, $skipped skipped)" --quiet
    else
        echo "[process-stale-queue] no changes to commit"
    fi
)

echo ""
echo "[process-stale-queue] done: flipped=$flipped skipped=$skipped"
