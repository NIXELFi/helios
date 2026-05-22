#!/usr/bin/env bash
#
# scripts/physics/process-amendments.sh
#
# bash counterpart of process-amendments.ps1. Same dispatch-cycle semantics:
# walk worktrees/agent-*/pending_amend.json, mutex-protect a collision
# check, merge or reject.
#
# Helios policy: no python in the repo (see memory feedback_no_python_in_helios.md).
# pending_amend.json is a tiny, fixed-schema JSON document and we parse it with
# the same shallow grep/sed trick used elsewhere in the project; the lock-file
# parse path uses `helios-bench locks parse-manifest`. If the schema grows
# beyond one-level deep, add a `helios-bench locks parse-amend` subcommand
# rather than introducing a python dependency in the orchestrator path.
#
# Usage: ./scripts/physics/process-amendments.sh [--dry-run]
#
# Spec refs: C3 amendment protocol.

set -e
set -u

dry_run=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run) dry_run=1; shift ;;
        --help|-h) sed -n '3,18p' "$0"; exit 0 ;;
        *) echo "ERROR: unknown arg '$1'" >&2; exit 2 ;;
    esac
done

root="$(git rev-parse --show-toplevel)"
locks_dir="$root/.physics_locks"
worktrees_dir="$root/worktrees"
mutex="$locks_dir/_orchestrator.mutex"

if [[ ! -d "$worktrees_dir" ]]; then
    echo "[process-amendments] no worktrees/ dir — nothing to do"
    exit 0
fi

pending=()
while IFS= read -r f; do pending+=("$f"); done < <(find "$worktrees_dir" -mindepth 2 -maxdepth 2 -name pending_amend.json -type f 2>/dev/null | sort)

if [[ ${#pending[@]} -eq 0 ]]; then
    echo "[process-amendments] no pending_amend.json files — nothing to do"
    exit 0
fi

echo "[process-amendments] found ${#pending[@]} pending amendment(s)"

if [[ "$dry_run" -eq 1 ]]; then
    for p in "${pending[@]}"; do echo "  DRY: $p"; done
    exit 0
fi

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

# Resolve helios-bench for `locks parse-manifest`.
hb=""
for cand in \
    "$root/target/debug/helios-bench" \
    "$root/target/debug/helios-bench.exe" \
    "$root/target/release/helios-bench" \
    "$root/target/release/helios-bench.exe"; do
    if [[ -x "$cand" ]]; then hb="$cand"; break; fi
done

read_files_for_lock() {
    local lf="$1"
    if [[ -n "$hb" ]]; then
        "$hb" locks parse-manifest "$lf"
    else
        ( cd "$root" && cargo run --quiet -p helios-bench -- locks parse-manifest "$lf" )
    fi
}

# Pull the `additional_files` string array out of pending_amend.json.
# Schema is exhaustively documented in `.physics_locks/README.md`: a top-level
# `additional_files: [...]` of plain strings. We do not handle escaped quotes
# inside file paths — file paths in this repo never contain `"`.
get_amend_files() {
    local file="$1"
    # Extract the contents between `additional_files: [` and the next `]`,
    # then split each `"…"` string onto its own line.
    sed -n '/"additional_files"[[:space:]]*:[[:space:]]*\[/,/\]/p' "$file" \
        | tr ',' '\n' \
        | grep -oE '"[^"]+"' \
        | sed 's/^"//;s/"$//'
}

processed=0
rejected=0
errors=0

for p in "${pending[@]}"; do
    wt="$(dirname "$p")"
    wt_name="$(basename "$wt")"
    if ! [[ "$wt_name" =~ ^agent-([0-9]{4})-(.+)$ ]]; then
        echo "[process-amendments] WARNING: non-agent worktree $wt_name; skipping" >&2
        continue
    fi
    this_id4="${BASH_REMATCH[1]}"
    this_slug="${BASH_REMATCH[2]}"
    this_lock="$locks_dir/$this_id4-$this_slug.lock"

    if [[ ! -f "$this_lock" ]]; then
        echo "[process-amendments] WARNING: no lock for $wt_name; skipping" >&2
        errors=$((errors+1))
        continue
    fi

    requested="$(get_amend_files "$p" 2>/dev/null || true)"
    if [[ -z "$requested" ]]; then
        echo "[process-amendments] $wt_name: empty additional_files; deleting pending_amend.json"
        rm -f "$p"
        continue
    fi

    existing="$(read_files_for_lock "$this_lock")"

    # new_files = requested \ existing.
    new_files=""
    while IFS= read -r rf; do
        [[ -z "$rf" ]] && continue
        if ! printf '%s\n' "$existing" | grep -Fxq "$rf"; then
            new_files="${new_files}${rf}"$'\n'
        fi
    done <<< "$requested"
    new_files="${new_files%$'\n'}"

    if [[ -z "$new_files" ]]; then
        echo "[process-amendments] $wt_name: amendment already merged; deleting pending_amend.json"
        rm -f "$p"
        continue
    fi

    # Collision check against other locks.
    collision=""
    collision_lock=""
    for lf in "$locks_dir"/*.lock; do
        [[ -e "$lf" ]] || continue
        [[ "$lf" == "$this_lock" ]] && continue
        other_files="$(read_files_for_lock "$lf")"
        while IFS= read -r nf; do
            [[ -z "$nf" ]] && continue
            if printf '%s\n' "$other_files" | grep -Fxq "$nf"; then
                collision="$nf"
                collision_lock="$lf"
                break 2
            fi
        done <<< "$new_files"
    done

    if [[ -n "$collision" ]]; then
        other_name="$(basename "$collision_lock" .lock)"
        rej="$wt/pending_amend.rejected.json"
        # Hand-build JSON; file paths have no `"` characters.
        new_files_json=""
        first=1
        while IFS= read -r nf; do
            [[ -z "$nf" ]] && continue
            if [[ $first -eq 1 ]]; then first=0; else new_files_json+=","; fi
            new_files_json+="\"$nf\""
        done <<< "$new_files"
        cat > "$rej" <<EOF
{
  "requested_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "requested_files": [$new_files_json],
  "collides_with_lock": "$other_name",
  "overlapping_file": "$collision"
}
EOF
        echo "[process-amendments] $wt_name: REJECTED (collides with $other_name on '$collision')" >&2
        rejected=$((rejected+1))
        continue
    fi

    # Merge: rewrite the manifest with the appended files. We hand-construct
    # the JSON (no python). Fields: id, slug, worktree_path, spawned_by,
    # spawned_at, files. The existing manifest text is the source of truth
    # for the first five — we re-emit them by reading from the lock as text.
    merged_files=""
    while IFS= read -r f; do
        [[ -z "$f" ]] && continue
        if [[ -n "$merged_files" ]]; then merged_files+=","; fi
        merged_files+="\"$f\""
    done <<< "$existing"
    while IFS= read -r f; do
        [[ -z "$f" ]] && continue
        if [[ -n "$merged_files" ]]; then merged_files+=","; fi
        merged_files+="\"$f\""
    done <<< "$new_files"

    # Extract the existing scalar fields from the lock with grep/sed. The
    # schema is `.physics_locks/README.md`; values never contain newlines.
    lock_text="$(cat "$this_lock")"
    f_id="$(printf '%s' "$lock_text" | grep -oE '"id"[[:space:]]*:[[:space:]]*[0-9]+' | grep -oE '[0-9]+')"
    f_slug="$(printf '%s' "$lock_text" | grep -oE '"slug"[[:space:]]*:[[:space:]]*"[^"]+"' | sed -E 's/.*: *"([^"]+)"/\1/')"
    f_wt="$(printf '%s' "$lock_text" | grep -oE '"worktree_path"[[:space:]]*:[[:space:]]*"[^"]+"' | sed -E 's/.*: *"([^"]+)"/\1/')"
    f_by="$(printf '%s' "$lock_text" | grep -oE '"spawned_by"[[:space:]]*:[[:space:]]*"[^"]+"' | sed -E 's/.*: *"([^"]+)"/\1/')"
    f_at="$(printf '%s' "$lock_text" | grep -oE '"spawned_at"[[:space:]]*:[[:space:]]*"[^"]+"' | sed -E 's/.*: *"([^"]+)"/\1/')"

    cat > "$this_lock" <<EOF
{
  "id": $f_id,
  "slug": "$f_slug",
  "worktree_path": "$f_wt",
  "spawned_by": "$f_by",
  "spawned_at": "$f_at",
  "files": [$merged_files]
}
EOF

    (
        cd "$root"
        git add ".physics_locks/$this_id4-$this_slug.lock"
        HELIOS_SKIP_PARITY=1 git commit -m "lock: amend $this_id4-$this_slug" --quiet
    )

    rm -f "$p"
    processed=$((processed+1))
    n=$(printf '%s\n' "$new_files" | grep -c .)
    echo "[process-amendments] $wt_name: AMENDED (+${n} file(s))"
done

echo ""
echo "[process-amendments] done: processed=$processed rejected=$rejected errors=$errors"
