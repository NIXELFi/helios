#!/usr/bin/env bash
# Bisect the production knob set to find which fix introduced the
# SDM25 peak under-prediction. Tests each knob INDIVIDUALLY off (with
# all others at production setting) and ALL knobs off (= legacy default
# behavior, "pre-physics-fix").
set -euo pipefail
cd "$(dirname "$0")/../.."
HERE="physics_findings/0021-sdm25-peak-regression-bisect"
mkdir -p "$HERE"
export PATH="$HOME/.cargo/bin:$PATH"

RPMS='[4000.0, 4500.0, 5000.0, 5500.0, 6000.0, 6500.0, 7000.0, 7500.0, 8000.0, 8500.0, 9000.0, 9500.0, 10000.0, 10500.0, 11000.0, 11500.0, 12000.0, 12500.0, 13000.0]'

# Variants:
#   - "all_off"    : no production knobs, parity defaults — legacy
#   - "prod"       : full production knob set (current baseline)
#   - "no_<knob>"  : production set MINUS one knob (to isolate that knob's effect)
declare -a KNOBS=(borda restrictor_geom mach_cd mbt_map wiebe_rpm)

mk_toml() {
  local cfg="$1" params="$2" out="$3"
  cat > "$out" <<EOF
[run]
config = "$cfg"
rpm = $RPMS
cycles = 30
recorded = true
seed = 8000
junction = "characteristic"

[environment]
target_triple = "aarch64-apple-darwin"
rustc_version = "rustc 1.95.0"
rayon_threads = 1
libm_source = "system"

[sweep]
sampler = "lhs"
n_trials = 1
parameters = [
$params
]
EOF
}

# Production knob set — each line can be commented out per variant
P_BORDA='  { name = "intake_junction_borda_carnot", min = 1.0, max = 1.0 },
  { name = "intake_junction_loss_coef", min = 1.0, max = 1.0 },'
P_RESTRGEOM='  { name = "restrictor_loss_from_diffuser_geometry", min = 1.0, max = 1.0 },'
P_MACHCD='  { name = "restrictor_cd_mach_k", min = 0.3, max = 0.3 },'
P_MBT='  { name = "spark_advance_rpm_slope_deg_per_krpm", min = 1.5, max = 1.5 },'
P_WIEBE='  { name = "duration_rpm_exp", min = 0.4, max = 0.4 },'

build_params() {
  local skip="$1"
  local out=""
  [ "$skip" = "borda" ]            || out+="$P_BORDA"$'\n'
  [ "$skip" = "restrictor_geom" ]  || out+="$P_RESTRGEOM"$'\n'
  [ "$skip" = "mach_cd" ]          || out+="$P_MACHCD"$'\n'
  [ "$skip" = "mbt_map" ]          || out+="$P_MBT"$'\n'
  [ "$skip" = "wiebe_rpm" ]        || out+="$P_WIEBE"$'\n'
  echo -n "${out%$'\n'}"
}

for eng in sdm25 sdm26; do
  CFG="crates/engine-sim/python_ref/configs/${eng}.json"

  # all_off (legacy defaults)
  mk_toml "$CFG" "" "$HERE/study_all_off_${eng}.toml"
  ./target/release/helios-bench sweep "$HERE/study_all_off_${eng}.toml" \
      --out "$HERE/results_all_off_${eng}.ndjson" >/dev/null 2>&1
  echo "  all_off / $eng done"

  # full production
  PARAMS=$(build_params "")
  mk_toml "$CFG" "$PARAMS" "$HERE/study_prod_${eng}.toml"
  ./target/release/helios-bench sweep "$HERE/study_prod_${eng}.toml" \
      --out "$HERE/results_prod_${eng}.ndjson" >/dev/null 2>&1
  echo "  prod / $eng done"

  # each knob off
  for k in "${KNOBS[@]}"; do
    PARAMS=$(build_params "$k")
    mk_toml "$CFG" "$PARAMS" "$HERE/study_no_${k}_${eng}.toml"
    ./target/release/helios-bench sweep "$HERE/study_no_${k}_${eng}.toml" \
        --out "$HERE/results_no_${k}_${eng}.ndjson" >/dev/null 2>&1
    echo "  no_${k} / $eng done"
  done
done

echo
echo "Done. $(ls $HERE/results_*.ndjson | wc -l) result files."
