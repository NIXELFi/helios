# Shared parity-test invocation. Sourced by `.githooks/pre-commit` and may be
# sourced by the doctor's per-merge gate.
#
# Spec C5: all default-flag parity tests must pass at commit time.
#
# Known Issue I-10 — cargo's `--test 'parity_*'` argument is NOT a shell glob;
# cargo treats it as a literal test target name. We enumerate parity_*.rs files
# from `crates/*/tests/` and emit one `--test <name>` per file. This makes the
# parity-test set self-discovering: dropping a new `crates/X/tests/parity_Y.rs`
# is enough to add it to the gate.
#
# Honors HELIOS_PARITY_QUIET=1 to silence the per-package banners.

run_parity_tests() {
    local repo_root
    repo_root="$(git rev-parse --show-toplevel)"

    # Map: package -> list of parity test names.
    # Bash 3.2 (Git for Windows) does not have associative arrays reliably
    # across versions, so we collect via two parallel arrays.
    local -a pkgs=()
    local -a tests=()
    local file pkg name

    # `find` is preferred per Known Issue I-10. We avoid `mapfile` for
    # bash 3.2 compatibility.
    while IFS= read -r file; do
        # file looks like: <repo_root>/crates/<pkg>/tests/parity_<X>.rs
        # Strip everything before "crates/" and everything after the next "/".
        pkg="${file#*"/crates/"}"
        pkg="${pkg%%/*}"
        name="$(basename "$file" .rs)"
        pkgs+=("$pkg")
        tests+=("$name")
    done < <(find "$repo_root/crates" -mindepth 3 -maxdepth 3 -type f \
                  -name 'parity_*.rs' -path '*/tests/parity_*.rs' \
                  2>/dev/null | sort)

    if [[ ${#tests[@]} -eq 0 ]]; then
        echo "[parity] no parity_*.rs test files found — refusing to greenlight" >&2
        return 1
    fi

    # Group by package so we make one `cargo test` invocation per crate.
    # (Cargo cannot mix `--test` targets across `-p` arguments in one run.)
    local -a unique_pkgs=()
    local p seen
    for p in "${pkgs[@]}"; do
        seen=0
        for q in "${unique_pkgs[@]+"${unique_pkgs[@]}"}"; do
            if [[ "$p" == "$q" ]]; then seen=1; break; fi
        done
        if [[ $seen -eq 0 ]]; then unique_pkgs+=("$p"); fi
    done

    local pkg_idx test_idx
    for pkg_idx in "${unique_pkgs[@]}"; do
        # `cargo test --quiet` already silences the runner. We pass
        # `--` followed by an empty position (no extra `--quiet`), so the
        # test binaries get cargo's default verbosity. Passing `--quiet`
        # to both cargo *and* the binary makes libtest reject the second
        # occurrence.
        local -a args=("test" "--quiet" "-p" "$pkg_idx")
        for ((test_idx = 0; test_idx < ${#tests[@]}; test_idx++)); do
            if [[ "${pkgs[$test_idx]}" == "$pkg_idx" ]]; then
                args+=("--test" "${tests[$test_idx]}")
            fi
        done
        if [[ "${HELIOS_PARITY_QUIET:-}" != "1" ]]; then
            echo "[parity] cargo ${args[*]}"
        fi
        if ! ( cd "$repo_root" && cargo "${args[@]}" ); then
            echo "[pre-commit] FAIL: $pkg_idx parity suite" >&2
            return 1
        fi
    done

    return 0
}
