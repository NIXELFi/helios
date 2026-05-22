#!/usr/bin/env bash
#
# scripts/physics/reap-worktree.sh
#
# bash counterpart of reap-worktree.ps1.
#
# Usage:
#   ./scripts/physics/reap-worktree.sh --id 42 --slug woschni-c1-c2 [--force] [--keep-branch]
#
# Spec refs: C2, C3.

set -e
set -u

id=""
slug=""
force=0
keep_branch=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --id)         id="$2"; shift 2 ;;
        --slug)       slug="$2"; shift 2 ;;
        --force)      force=1; shift ;;
        --keep-branch) keep_branch=1; shift ;;
        --help|-h)
            sed -n '3,15p' "$0"; exit 0 ;;
        *)
            echo "ERROR: unknown arg '$1'" >&2; exit 2 ;;
    esac
done

if [[ -z "$id" || -z "$slug" ]]; then
    echo "Usage: $0 --id N --slug X [--force] [--keep-branch]" >&2
    exit 2
fi

root="$(git rev-parse --show-toplevel)"
id4="$(printf '%04d' "$id")"
dirname="agent-${id4}-${slug}"
worktree="${root}/worktrees/${dirname}"
branch="physics/${dirname}"
locks_dir="${root}/.physics_locks"
lock_file="${locks_dir}/${id4}-${slug}.lock"
mutex="${locks_dir}/_orchestrator.mutex"

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
    if [[ "$acquired" -eq 1 ]]; then
        rm -f "$mutex" || true
    fi
    exit $rc
}
trap cleanup EXIT INT TERM

# Re-parse the manifest to catch corruption + verify before deleting.
hb=""
for cand in \
    "$root/target/debug/helios-bench" \
    "$root/target/debug/helios-bench.exe" \
    "$root/target/release/helios-bench" \
    "$root/target/release/helios-bench.exe"; do
    if [[ -x "$cand" ]]; then hb="$cand"; break; fi
done

if [[ -f "$lock_file" ]]; then
    if [[ -n "$hb" ]]; then
        "$hb" locks parse-manifest "$lock_file" > /dev/null
    else
        ( cd "$root" && cargo run --quiet -p helios-bench -- locks parse-manifest "$lock_file" > /dev/null )
    fi
elif [[ "$force" -ne 1 ]]; then
    echo "WARNING: lock file $lock_file missing (manifest already released?)" >&2
fi

pending="$worktree/pending_amend.json"
if [[ -f "$pending" ]]; then
    if [[ "$force" -eq 1 ]]; then
        echo "WARNING: pending_amend.json present but --force given; discarding amendment" >&2
    else
        echo "ERROR: worktree has unprocessed pending_amend.json at $pending" >&2
        echo "       Run process-amendments.sh first, or pass --force to discard." >&2
        exit 1
    fi
fi

# Remove the worktree.
if [[ -d "$worktree" ]]; then
    ( cd "$root" && git worktree remove --force "$worktree" > /dev/null )
else
    ( cd "$root" && git worktree prune > /dev/null )
fi

if [[ "$keep_branch" -ne 1 ]]; then
    if ( cd "$root" && git show-ref --verify --quiet "refs/heads/$branch" ); then
        ( cd "$root" && git branch -D "$branch" > /dev/null )
    fi
fi

# Delete the lock and commit the reap on main.
if [[ -f "$lock_file" ]]; then
    (
        cd "$root"
        git rm --quiet ".physics_locks/${id4}-${slug}.lock"
        HELIOS_SKIP_PARITY=1 git commit -m "lock: reap ${id4}-${slug}" --quiet
    )
fi

echo "Reaped: $dirname"
