"""Throat Cd sensitivity (the converging side's only lever in the quasi-steady venturi): 1.44 L, as-built runner/diffuser.
Separate output file so it can run beside the main grid (4 threads)."""
import json, os, sys, itertools
from concurrent.futures import ThreadPoolExecutor
H = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, H)
import study
OUT = os.path.join(H, "diag", "cd_sweep.ndjson")
have = set()
if os.path.exists(OUT):
    for l in open(OUT): x = json.loads(l); have.add((x["cd"], x["rpm"]))
jobs = [(cd, r) for cd in (0.85, 0.90, 0.93, 0.97, 0.99) for r in range(4000, 12501, 500) if (cd, r) not in have]
def run(a):
    cd, r = a; n, p = study.make_cfg(cd=cd)
    x = json.loads(study.run(("G3", n, p, 0, r))); x["cd"] = cd; return json.dumps(x)
with open(OUT, "a") as f, ThreadPoolExecutor(4) as ex:
    for line in ex.map(run, jobs): f.write(line + "\n"); f.flush()
print("done")
