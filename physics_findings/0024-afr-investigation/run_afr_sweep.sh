#!/usr/bin/env bash
# Test AFR sensitivity. Real FSAE engines at WOT run rich (~12.0-12.5)
# for charge cooling and peak power; sim uses AFR=13.1.
set -euo pipefail
cd "$(dirname "$0")/../.."
HERE="physics_findings/0024-afr-investigation"
mkdir -p "$HERE"
export PATH="$HOME/.cargo/bin:$PATH"

# AFR candidates spanning literature WOT range
AFRS=("12.0" "12.5" "13.0" "13.1" "13.5")

RPMS='[4000.0, 4500.0, 5000.0, 5500.0, 6000.0, 6500.0, 7000.0, 7500.0, 8000.0, 8500.0, 9000.0, 9500.0, 10000.0, 10500.0, 11000.0, 11500.0, 12000.0, 12500.0, 13000.0]'

mk_toml() {
  local cfg="$1" afr="$2" out="$3"
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
  # Option B production knob set
  { name = "intake_junction_borda_carnot", min = 1.0, max = 1.0 },
  { name = "intake_junction_loss_coef", min = 1.0, max = 1.0 },
  { name = "restrictor_loss_from_diffuser_geometry", min = 1.0, max = 1.0 },
  { name = "restrictor_cd_mach_k", min = 0.10, max = 0.10 },
  { name = "spark_advance_rpm_slope_deg_per_krpm", min = 1.5, max = 1.5 },
  { name = "duration_rpm_exp", min = 0.4, max = 0.4 },
  { name = "fmep_c", min = 0.00075, max = 0.00075 },
  # Vary AFR
  { name = "afr_target", min = $afr, max = $afr },
]
EOF
}

for afr in "${AFRS[@]}"; do
  for eng in sdm25 sdm26; do
    label="afr_${afr//./_}"
    toml="$HERE/study_${label}_${eng}.toml"
    out="$HERE/results_${label}_${eng}.ndjson"
    mk_toml "crates/engine-sim/python_ref/configs/${eng}.json" "$afr" "$toml"
    ./target/release/helios-bench sweep "$toml" --out "$out" >/dev/null 2>&1
  done
  echo "Done AFR=$afr"
done
