#!/usr/bin/env bash
# Fine-grained sweep of fmep_c (the quadratic FMEP coefficient), keeping
# fmep_a=0.5 and fmep_b=0.1 at their current values. Tests where fmep_c
# transitions from current (0.003, above Heywood ceiling) toward the
# Heywood motorcycle range [5e-4, 1e-3].
set -euo pipefail
cd "$(dirname "$0")/../.."
HERE="physics_findings/0020-fmep-revalidation-real-dyno"
export PATH="$HOME/.cargo/bin:$PATH"

# fmep_c candidates spanning the transition (each value tested on both engines)
FC_VALUES=("0.00200" "0.00150" "0.00125" "0.00100" "0.00075" "0.00050")

mk_toml() {
  local cfg="$1" rpm_list="$2" fc="$3" out="$4"
  cat > "$out" <<EOF
[run]
config = "$cfg"
rpm = $rpm_list
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
  { name = "restrictor_cd_mach_k", min = 0.3, max = 0.3 },
  { name = "spark_advance_rpm_slope_deg_per_krpm", min = 1.5, max = 1.5 },
  { name = "duration_rpm_exp", min = 0.4, max = 0.4 },
  { name = "fmep_a", min = 0.5, max = 0.5 },
  { name = "fmep_b", min = 0.1, max = 0.1 },
  { name = "fmep_c", min = $fc, max = $fc },
]
EOF
}

RPMS='[4000.0, 4500.0, 5000.0, 5500.0, 6000.0, 6500.0, 7000.0, 7500.0, 8000.0, 8500.0, 9000.0, 9500.0, 10000.0, 10500.0, 11000.0, 11500.0, 12000.0, 12500.0, 13000.0]'

for fc in "${FC_VALUES[@]}"; do
  label="fc_${fc//./_}"
  for eng in sdm25 sdm26; do
    toml="$HERE/study_${label}_${eng}.toml"
    out="$HERE/results_${label}_${eng}.ndjson"
    mk_toml "crates/engine-sim/python_ref/configs/${eng}.json" "$RPMS" "$fc" "$toml"
    echo "Running fc=$fc / $eng..."
    ./target/release/helios-bench sweep "$toml" --out "$out" >/dev/null 2>&1
  done
done
echo "Done."
