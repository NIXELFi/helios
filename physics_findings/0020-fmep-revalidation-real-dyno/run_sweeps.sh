#!/usr/bin/env bash
# Generate study TOMLs + run sweeps for FMEP revalidation.
# All candidates within Heywood Tab 13.3 motorcycle SI range.
set -euo pipefail
cd "$(dirname "$0")/../.."

HERE="physics_findings/0020-fmep-revalidation-real-dyno"
export PATH="$HOME/.cargo/bin:$PATH"

# Variants: (label, fmep_a, fmep_b, fmep_c)
# Heywood Tab 13.3 motorcycle SI range:  a ∈ [0.3, 0.5]  b ∈ [0.04, 0.05]  c ∈ [5e-4, 1e-3]
VARIANTS=(
  "current     0.50  0.100  0.00300"   # current sim defaults — ABOVE Heywood ceiling
  "heywood_mid 0.40  0.045  0.00075"   # Heywood Tab 13.3 motorcycle midpoint
  "heywood_hi  0.50  0.050  0.00100"   # Heywood ceiling (highest defensible literature value)
  "heywood_lo  0.30  0.040  0.00050"   # Heywood floor
  "midway      0.45  0.070  0.00200"   # halfway between current and Heywood midpoint
  "only_c_lit  0.50  0.100  0.00100"   # only fmep_c reduced to Heywood ceiling
  "only_b_lit  0.50  0.050  0.00300"   # only fmep_b reduced to Heywood ceiling
)

mk_toml() {
  local config_path="$1" rpm_list="$2" fa="$3" fb="$4" fc="$5" out="$6"
  cat > "$out" <<EOF
[run]
config = "$config_path"
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
  { name = "fmep_a", min = $fa, max = $fa },
  { name = "fmep_b", min = $fb, max = $fb },
  { name = "fmep_c", min = $fc, max = $fc },
]
EOF
}

RPMS='[4000.0, 4500.0, 5000.0, 5500.0, 6000.0, 6500.0, 7000.0, 7500.0, 8000.0, 8500.0, 9000.0, 9500.0, 10000.0, 10500.0, 11000.0, 11500.0, 12000.0, 12500.0, 13000.0]'

for v in "${VARIANTS[@]}"; do
  IFS=' ' read -r label fa fb fc <<<"$v"
  for eng in sdm25 sdm26; do
    toml="$HERE/study_${label}_${eng}.toml"
    out="$HERE/results_${label}_${eng}.ndjson"
    mk_toml "crates/engine-sim/python_ref/configs/${eng}.json" "$RPMS" "$fa" "$fb" "$fc" "$toml"
    echo "Running $label / $eng ..."
    ./target/release/helios-bench sweep "$toml" --out "$out" >/dev/null 2>&1
  done
done

echo "Done. Result files in $HERE/"
ls "$HERE"/results_*.ndjson | wc -l | awk '{print "  "$1" ndjson files generated"}'
