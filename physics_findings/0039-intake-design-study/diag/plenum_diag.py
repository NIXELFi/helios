"""Why does a bigger plenum lose top-end torque in the 1D model? One-knob-at-a-time checks, 1.44 vs 3.5 L."""
import json, os, subprocess, itertools
from concurrent.futures import ThreadPoolExecutor
H = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.path.join(H, "driver", "target", "release", "intakepoint.exe")
CASES = {"baseline": [], "plenum 60 cells": ["plenum_n_cells=60"], "no pipe heat transfer": ["pipe_heat_transfer_multiplier=0"],
         "no pipe friction": ["pipe_friction_multiplier=0"], "plenum wall 300 K": ["plenum_wall_t=300"]}
def run(a):
    case, V, r = a
    p = os.path.join(H, "cfg", f"V{V}_L1.00_D38_A3.2.json")
    o = subprocess.run([EXE, p, str(r), "20", *CASES[case]], capture_output=True, text=True)
    try: x = json.loads(o.stdout.strip().splitlines()[-1])
    except Exception: x = {"err": o.stderr[-200:]}
    x.update(case=case, V=V, rpm=r); return x
jobs = list(itertools.product(CASES, ["1.44", "3.50"], [9000, 12000]))
with ThreadPoolExecutor(5) as ex: res = list(ex.map(run, jobs))
json.dump(res, open(os.path.join(H, "diag", "plenum_diag.json"), "w"), indent=1)
for case in CASES:
    for r in (9000, 12000):
        a = [x for x in res if x["case"] == case and x["rpm"] == r]
        b = {x["V"]: x for x in a}
        if all("bt" in b[v] for v in b):
            print(f"{case:24s} {r:5d}  bt 1.44 {b['1.44']['bt']:.2f}  3.5 {b['3.50']['bt']:.2f}  d {100*(b['3.50']['bt']/b['1.44']['bt']-1):+.2f}%   ve {b['1.44']['ve']:.3f} / {b['3.50']['ve']:.3f}")
        else: print(case, r, a)
