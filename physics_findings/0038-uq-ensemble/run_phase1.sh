#!/usr/bin/env bash
# Waits for the CPU (no helios-bench.exe for two checks a minute apart), then runs phase 1.
cd "$(dirname "$0")/../.."
F=physics_findings/0038-uq-ensemble
clear=0
while [ $clear -lt 2 ]; do
  if tasklist 2>/dev/null | grep -qi "helios-bench.exe"; then clear=0; else clear=$((clear+1)); fi
  [ $clear -lt 2 ] && sleep 60
done
echo "start $(date)" > $F/out/phase1.log
./target/release/uq-bench ensemble $F/studies/phase1.toml --out $F/out/phase1.ndjson >> $F/out/phase1.log 2>&1
echo "exit $? $(date)" >> $F/out/phase1.log
