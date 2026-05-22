#!/usr/bin/env bash
#
# scripts/physics/spawn-worktree.sh
#
# bash counterpart of spawn-worktree.ps1. Same behavior:
#   - acquire orchestrator mutex via O_EXCL (`set -C` + `>` redirect)
#   - collision check across `.physics_locks/*.lock`
#   - write manifest, commit it on main with HELIOS_SKIP_PARITY=1
#   - git worktree add
#   - core.hooksPath inside the worktree
#   - warm the worktree's target/ by building helios-bench
#
# Usage (positional):
#   ./scripts/physics/spawn-worktree.sh 42 woschni-c1-c2 \
#       "crates/engine-sim/src/cylinder/heat.rs,crates/cfd-core/tests/regressions_0042_woschni_c1_c2.rs"
#
# Usage (flag form):
#   ./scripts/physics/spawn-worktree.sh \
#       --id 42 \
#       --slug woschni-c1-c2 \
#       --files "crates/engine-sim/src/cylinder/heat.rs,crates/cfd-core/tests/regressions_0042_woschni_c1_c2.rs" \
#       --base-branch physics-fixes/math-corrections \
#       --spawned-by manual
#
# Spec refs: C2, C3, C5.

set -e
set -u

id=""
slug=""
files_csv=""
base_branch="physics-fixes/math-corrections"
spawned_by="manual"

# ----------------------------------------------------------------------
# Arg parsing — both `--flag value` and positional forms.
# ----------------------------------------------------------------------
positional=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --id)         id="$2"; shift 2 ;;
        --slug)       slug="$2"; shift 2 ;;
        --files)      files_csv="$2"; shift 2 ;;
        --base-branch) base_branch="$2"; shift 2 ;;
        --spawned-by) spawned_by="$2"; shift 2 ;;
        --help|-h)
            sed -n '3,30p' "$0"; exit 0 ;;
        *)
            positional+=("$1"); shift ;;
    esac
done

if [[ -z "$id"   && ${#positional[@]} -ge 1 ]]; then id="${positional[0]}"; fi
if [[ -z "$slug" && ${#positional[@]} -ge 2 ]]; then slug="${positional[1]}"; fi
if [[ -z "$files_csv" && ${#positional[@]} -ge 3 ]]; then files_csv="${positional[2]}"; fi

if [[ -z "$id" || -z "$slug" || -z "$files_csv" ]]; then
    echo "Usage: $0 --id N --slug X --files \"a,b,c\" [--base-branch B] [--spawned-by manual|cron]" >&2
    exit 2
fi

case "$spawned_by" in
    manual|cron) ;;
    *) echo "ERROR: --spawned-by must be 'manual' or 'cron' (got '$spawned_by')" >&2; exit 2 ;;
esac

# ----------------------------------------------------------------------
# Resolve paths.
# ----------------------------------------------------------------------
root="$(git rev-parse --show-toplevel)"
id4="$(printf '%04d' "$id")"
dirname="agent-${id4}-${slug}"
worktree="${root}/worktrees/${dirname}"
branch="physics/${dirname}"
locks_dir="${root}/.physics_locks"
lock_file="${locks_dir}/${id4}-${slug}.lock"
mutex="${locks_dir}/_orchestrator.mutex"

mkdir -p "$locks_dir"

# Forward-slash worktree_path for the manifest (Known Issue I-8 — bash
# already uses forward slashes, included here for parity with ps1).
worktree_path="worktrees/${dirname}"

# ----------------------------------------------------------------------
# 1. O_EXCL acquire via `set -C` + `>` redirect. If the file already
#    exists, the redirect fails with "cannot overwrite existing file".
# ----------------------------------------------------------------------
hostname_val="$(hostname 2>/dev/null || echo unknown)"
acquired_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

acquired=0
(
    set -C
    printf '{"pid":%d,"hostname":"%s","acquired_at":"%s"}\n' \
        "$$" "$hostname_val" "$acquired_at" > "$mutex"
) && acquired=1 || true

if [[ "$acquired" -ne 1 ]]; then
    echo "ERROR: failed to acquire orchestrator mutex at $mutex (held by another process?)" >&2
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

# ----------------------------------------------------------------------
# 2. Collision check. Read each existing `*.lock`, parse via
#    `helios-bench locks parse-manifest` (no jq dependency).
# ----------------------------------------------------------------------
if [[ -f "$lock_file" ]]; then
    echo "ERROR: lock already exists for id=$id slug=$slug at $lock_file" >&2
    exit 1
fi

# Resolve a helios-bench binary the same way the pre-commit hook does.
hb=""
for candidate in \
    "$root/target/debug/helios-bench" \
    "$root/target/debug/helios-bench.exe" \
    "$root/target/release/helios-bench" \
    "$root/target/release/helios-bench.exe"; do
    if [[ -x "$candidate" ]]; then hb="$candidate"; break; fi
done

read_files() {
    local lf="$1"
    if [[ -n "$hb" ]]; then
        "$hb" locks parse-manifest "$lf"
    else
        ( cd "$root" && cargo run --quiet -p helios-bench -- locks parse-manifest "$lf" )
    fi
}

# Build a CSV->newline list of candidate files.
IFS=',' read -r -a candidate_files <<< "$files_csv"

for lf in "$locks_dir"/*.lock; do
    [[ -e "$lf" ]] || continue
    other_files="$(read_files "$lf")"
    for f in "${candidate_files[@]}"; do
        f_trim="$(echo "$f" | sed 's/^ *//;s/ *$//')"
        [[ -z "$f_trim" ]] && continue
        if printf '%s\n' "$other_files" | grep -Fxq "$f_trim"; then
            other_id="$(basename "$lf" .lock)"
            echo "ERROR: COLLISION with lock $other_id: file '$f_trim' already claimed" >&2
            exit 1
        fi
    done
done

# ----------------------------------------------------------------------
# 3. Write the manifest JSON. Hand-built JSON keeps us off the jq
#    dependency. Files are emitted in declared order.
# ----------------------------------------------------------------------
spawned_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Build the files array as JSON.
files_json="["
first=1
for f in "${candidate_files[@]}"; do
    f_trim="$(echo "$f" | sed 's/^ *//;s/ *$//')"
    [[ -z "$f_trim" ]] && continue
    if [[ $first -eq 1 ]]; then first=0; else files_json+=","; fi
    # Escape backslash and double-quote for JSON.
    f_esc="${f_trim//\\/\\\\}"
    f_esc="${f_esc//\"/\\\"}"
    files_json+="\"$f_esc\""
done
files_json+="]"

cat > "$lock_file" <<EOF
{
  "id": $id,
  "slug": "$slug",
  "worktree_path": "$worktree_path",
  "spawned_by": "$spawned_by",
  "spawned_at": "$spawned_at",
  "files": $files_json
}
EOF

# ----------------------------------------------------------------------
# 4. Commit the manifest on the main checkout. HELIOS_SKIP_PARITY=1 —
#    ledger-only commit on main (the doctor merge gate is the backstop).
# ----------------------------------------------------------------------
(
    cd "$root"
    git add ".physics_locks/${id4}-${slug}.lock"
    HELIOS_SKIP_PARITY=1 git commit -m "lock: spawn ${id4}-${slug}" --quiet
)

# ----------------------------------------------------------------------
# 5. git worktree add.
# ----------------------------------------------------------------------
( cd "$root" && git worktree add -b "$branch" "$worktree" "$base_branch" > /dev/null )

# ----------------------------------------------------------------------
# 6. Activate hooks inside the worktree.
# ----------------------------------------------------------------------
( cd "$worktree" && git config --local core.hooksPath ".githooks" )
hp="$(cd "$worktree" && git config --get core.hooksPath)"
if [[ "$hp" != ".githooks" ]]; then
    echo "ERROR: core.hooksPath verification failed inside worktree: got '$hp'" >&2
    exit 1
fi

# ----------------------------------------------------------------------
# 7. Warm helios-bench inside the worktree (per-worktree target/).
# ----------------------------------------------------------------------
(
    cd "$worktree"
    CARGO_TARGET_DIR="$worktree/target" cargo build --quiet -p helios-bench || \
        echo "[spawn-worktree] WARNING: cargo build returned non-zero; pre-commit will fall back to cargo run" >&2
)

cat <<MSG

Spawned worktree:
  path:   $worktree
  branch: $branch
  lock:   $lock_file

Before any commit in the worktree, export the marker:
  bash:       export HELIOS_PHYSICS_AGENT=1
  PowerShell: \$env:HELIOS_PHYSICS_AGENT = '1'

Per-worktree CARGO_TARGET_DIR (recommended):
  bash:       export CARGO_TARGET_DIR="$worktree/target"
MSG
