#!/usr/bin/env bash
# Runs the three 0037 studies in sequence (A and B share cached points at ext <= 0).
set -e
cd "$(dirname "$0")/../.."
for s in A_neutral_disp B_neutral_nodisp C_loggedtune_disp; do
  ./target/release/helios-bench vrli physics_findings/0037-vrli-stroke-optimization/studies/$s.toml \
     --out physics_findings/0037-vrli-stroke-optimization/out/$s > physics_findings/0037-vrli-stroke-optimization/out_$s.log 2>&1
done
