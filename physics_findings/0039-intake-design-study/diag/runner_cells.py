"""Runner mesh convergence for the runner-length effect (160-cell plenum, 1.44 L). 4 threads: the main grid is running."""
import json, os, subprocess, itertools
from concurrent.futures import ThreadPoolExecutor
H = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.path.join(H, "driver", "target", "release", "intakepoint.exe")
def run(a):
    n, e, r = a
    o = subprocess.run([EXE, os.path.join(H, "cfg", "V1.44_L1.00_D38_A3.2.json"), str(r), "20", "plenum_n_cells=160", f"runner_n_cells={n}", f"runner_mouth_extension={e/1000:.4f}"], capture_output=True, text=True)
    x = json.loads(o.stdout.strip().splitlines()[-1]); x.update(n=n, ext=e, rpm=r); return x
N = [40, 80, 160]; E = [-115, 0, 40]; RR = [6000, 9000, 12000]
res = list(ThreadPoolExecutor(4).map(run, itertools.product(N, E, RR)))
json.dump(res, open(os.path.join(H, "diag", "runner_cells.json"), "w"), indent=1)
T = {(x["n"], x["ext"], x["rpm"]): x["bt"] for x in res}
for r in RR:
    print(r, " as-built bt:", " ".join(f"{n}:{T[n,0,r]:.2f}" for n in N), " | effect of -115 / +40 (%):",
          "  ".join(f"{n}: {100*(T[n,-115,r]/T[n,0,r]-1):+.1f}/{100*(T[n,40,r]/T[n,0,r]-1):+.1f}" for n in N))
