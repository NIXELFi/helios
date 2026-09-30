import json, os, subprocess, study
from concurrent.futures import ThreadPoolExecutor
H = os.path.dirname(os.path.abspath(__file__)); EXE = os.path.join(H, "driver", "target", "release", "tipin.exe")
OUT = os.path.join(H, "tipin.ndjson")
J = []
for V in (0.5, 1.0, 1.44, 2.0, 2.75, 3.5):
    n, p = study.make_cfg(V=V * 1e-3)
    for e in (-190, -115, -40, 0, 35, 110, 160):
        for r in (6000, 8500): J.append((n, p, e, r))
for lf in (0.5, 2.0):
    n, p = study.make_cfg(V=1.44e-3, lenfac=lf)
    for e in (-40, 110):
        for r in (6000, 8500): J.append((n, p, e, r))
have = set()
if os.path.exists(OUT):
    for l in open(OUT): x = json.loads(l); have.add((x["cfg"], x["ext"], x["rpm"]))
J = [j for j in J if (j[0], j[2], j[3]) not in have]
def run(j):
    n, p, e, r = j
    o = subprocess.run([EXE, p, str(r), "40000", "14", f"runner_mouth_extension={e/1000:.4f}"], capture_output=True, text=True).stdout
    rows = [json.loads(l) for l in o.strip().splitlines()]
    return json.dumps(dict(cfg=n, ext=e, rpm=r, rows=rows))
print(len(J), "tip-in runs", flush=True)
with open(OUT, "a") as f, ThreadPoolExecutor(15) as ex:
    for line in ex.map(run, J): f.write(line + "\n"); f.flush()
print("done", flush=True)
