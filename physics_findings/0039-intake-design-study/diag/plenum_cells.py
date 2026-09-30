"""Plenum grid convergence: n_cells 20..320, 1.44 vs 3.5 L, at 6/9/12k (20 cycles)."""
import json, os, subprocess, itertools, time
from concurrent.futures import ThreadPoolExecutor
H = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.path.join(H, "driver", "target", "release", "intakepoint.exe")
def run(a):
    n, V, r = a; t = time.time()
    o = subprocess.run([EXE, os.path.join(H, "cfg", f"V{V}_L1.00_D38_A3.2.json"), str(r), "20", f"plenum_n_cells={n}"], capture_output=True, text=True)
    x = json.loads(o.stdout.strip().splitlines()[-1]); x.update(n=n, V=V, rpm=r, sec=round(time.time() - t, 1)); return x
jobs = list(itertools.product([20, 40, 80, 160, 320], ["1.44", "3.50"], [6000, 9000, 12000]))
with ThreadPoolExecutor(6) as ex: res = list(ex.map(run, jobs))
json.dump(res, open(os.path.join(H, "diag", "plenum_cells.json"), "w"), indent=1)
for r in (6000, 9000, 12000):
    for n in (20, 40, 80, 160, 320):
        b = {x["V"]: x for x in res if x["n"] == n and x["rpm"] == r}
        print(f"{r:5d} cells {n:3d}  bt 1.44 {b['1.44']['bt']:.2f}  3.5 {b['3.50']['bt']:.2f}  3.5 vs 1.44 {100*(b['3.50']['bt']/b['1.44']['bt']-1):+.2f}%  ({b['1.44']['sec']:.0f}/{b['3.50']['sec']:.0f} s)")
