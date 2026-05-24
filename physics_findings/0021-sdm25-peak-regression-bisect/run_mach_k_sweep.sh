#!/usr/bin/env bash
# Sweep restrictor_cd_mach_k to find the best-fit value for BOTH engines.
# Combine with the finding-0020 FMEP fix (fmep_c = 0.00075) to test the
# best combined production knob set.
set -euo pipefail
cd "$(dirname "$0")/../.."
HERE="physics_findings/0021-sdm25-peak-regression-bisect"
export PATH="$HOME/.cargo/bin:$PATH"

# k values to test
KS=("0.00" "0.10" "0.15" "0.20" "0.25" "0.30" "0.40")

RPMS='[4000.0, 4500.0, 5000.0, 5500.0, 6000.0, 6500.0, 7000.0, 7500.0, 8000.0, 8500.0, 9000.0, 9500.0, 10000.0, 10500.0, 11000.0, 11500.0, 12000.0, 12500.0, 13000.0]'

mk_toml() {
  local cfg="$1" k="$2" fc="$3" out="$4"
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
  { name = "intake_junction_borda_carnot", min = 1.0, max = 1.0 },
  { name = "intake_junction_loss_coef", min = 1.0, max = 1.0 },
  { name = "restrictor_loss_from_diffuser_geometry", min = 1.0, max = 1.0 },
  { name = "restrictor_cd_mach_k", min = $k, max = $k },
  { name = "spark_advance_rpm_slope_deg_per_krpm", min = 1.5, max = 1.5 },
  { name = "duration_rpm_exp", min = 0.4, max = 0.4 },
  { name = "fmep_c", min = $fc, max = $fc },
]
EOF
}

for k in "${KS[@]}"; do
  for fc_label in "fmep_curr_0.003" "fmep_fix_0.00075"; do
    fc=$(echo "$fc_label" | sed 's/.*_//')
    for eng in sdm25 sdm26; do
      label="k${k//./_}_${fc_label}"
      toml="$HERE/study_${label}_${eng}.toml"
      out="$HERE/results_${label}_${eng}.ndjson"
      mk_toml "crates/engine-sim/python_ref/configs/${eng}.json" "$k" "$fc" "$toml"
      ./target/release/helios-bench sweep "$toml" --out "$out" >/dev/null 2>&1
    done
  done
  echo "Done k=$k"
done
echo "All done."
