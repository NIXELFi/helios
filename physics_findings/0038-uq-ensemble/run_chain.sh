#!/usr/bin/env bash
# After phase 1: analyze, plot, best-sample config, then phase 2 end to end.
set -e
cd "$(dirname "$0")"
L=out/phase1.log
until [ -f $L ] && grep -q "^exit" $L; do sleep 60; done
cd scripts
python analyze.py > ../out/analyze.txt 2>&1
python plot.py >> ../out/analyze.txt 2>&1
python sample_config.py >> ../out/analyze.txt 2>&1
python phase2.py prepare > ../out/phase2.txt 2>&1
python phase2.py run >> ../out/phase2.log 2>&1
python phase2.py collect >> ../out/phase2.txt 2>&1
echo "chain done $(date)" >> ../out/phase2.txt
