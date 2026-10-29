"""Do runner-length effects (the main design lever) survive plenum mesh refinement? 1.44 L, 20 vs 160 cells."""
import json, os, subprocess, itertools
from concurrent.futures import ThreadPoolExecutor
H = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.path.join(H, "driver", "target", "release", "intakepoint.exe")
def run(a):
    n, e, r = a
    o = subprocess.run([EXE, os.path.join(H, "cfg", "V1.44_L1.00_D38_A3.2.json"), str(r), "20", f"plenum_n_cells={n}", f"runner_mouth_extension={e/1000:.4f}"], capture_output=True, text=True)
    x = json.loads(o.stdout.strip().splitlines()[-1]); x.update(n=n, ext=e, rpm=r); return x
E = [-115, -40, 0, 40, 110]; RR = [6000, 7000, 8000, 9000, 10000, 11000, 12000]
res = list(ThreadPoolExecutor(15).map(run, itertools.product([20, 160], E, RR)))
json.dump(res, open(os.path.join(H, "diag", "runner_vs_cells.json"), "w"), indent=1)
T = {(x["n"], x["ext"], x["rpm"]): x["bt"] for x in res}
print("torque change vs as-built runner (%), 20 cells -> 160 cells")
print("ext   " + "".join(f"{r:>14d}" for r in RR))
for e in E:
    print(f"{e:+4d}  " + "".join(f"{100*(T[20,e,r]/T[20,0,r]-1):+6.1f}->{100*(T[160,e,r]/T[160,0,r]-1):+5.1f} " for r in RR))
