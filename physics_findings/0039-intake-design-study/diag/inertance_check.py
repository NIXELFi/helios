"""Does the venturi inertance (physics.restrictor_inertance) change the VRLI gain? As-built intake vs the recommended
VRLI (1.44 L box, 198-298 mm, ECU table from the quasi-steady direct runs), quasi-steady vs inertial venturi."""
import json, os, subprocess, sys, numpy as np, pandas as pd
from concurrent.futures import ThreadPoolExecutor
H = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, H)
import study
from nothrottle import unthrottle
OUT = os.path.join(H, "diag", "inertance_check.ndjson")
N = pd.DataFrame([json.loads(l) for l in open(os.path.join(H, "newintake_box1.44.ndjson"))]); N = N[N.bt.notna()]
RPM = list(range(4000, 12501, 500))
base_qs = N[N.case == "base"].groupby("rpm").bt.mean()
g = N[N.case == "new"]; best = g.loc[g.groupby("rpm").bt.idxmax()].set_index("rpm")
_, BASE_P = study.make_cfg(); _, NEW_P = study.make_cfg(V=1.44e-3, R=0.5746)
have = {}
if os.path.exists(OUT):
    for l in open(OUT): x = json.loads(l); have[(x["case"], x["rpm"])] = x
def run(job):
    case, cfgp, rpm, pos, inert = job
    a = [study.EXE, cfgp, str(rpm), "20", f"plenum_n_cells={study.CELLS}", f"runner_mouth_extension={(pos - 248.1) / 1000:.4f}", f"restrictor_inertance={inert}"]
    if case.startswith("vrli"): a += ["vrli_trumpet_od=0.040", "vrli_displacement_ref=-0.0500"]
    p = subprocess.Popen(a, stdout=subprocess.PIPE, text=True); unthrottle(p.pid)
    x = json.loads(p.communicate()[0].strip().splitlines()[-1]); x.update(case=case, pos=pos, inert=inert); return x
jobs = [("base_I400", BASE_P, r, 248.1, 400) for r in RPM] + [("vrli_I400", NEW_P, r, float(best.pos[r]), 400) for r in RPM] + [("vrli_I240", NEW_P, r, float(best.pos[r]), 240) for r in RPM]
jobs = [j for j in jobs if (j[0], j[2]) not in have]
with open(OUT, "a") as f, ThreadPoolExecutor(study.THREADS) as ex:
    for x in ex.map(run, jobs): f.write(json.dumps(x) + "\n"); f.flush(); have[(x["case"], x["rpm"])] = x
R = np.array(RPM, float); T = lambda c: np.array([have[(c, r)]["bt"] for r in RPM])
bq = np.array([base_qs[r] for r in RPM]); vq = np.array([best.bt[r] for r in RPM]); bi = T("base_I400"); vi = T("vrli_I400"); v2 = T("vrli_I240")
def band(a, b, lo, hi):
    m = (R >= lo) & (R <= hi); return (np.trapezoid(a[m], R[m]) / np.trapezoid(b[m], R[m]) - 1) * 100
print("baseline torque, inertial vs quasi-steady (%) by rpm:"); print(" ".join(f"{r/1000:g}k:{100*(a/b-1):+.1f}" for r, a, b in zip(RPM, bi, bq)))
for nm, lo, hi in [("4-6k", 4000, 6000), ("6-12k", 6000, 12000), ("7-10.5k", 7000, 10500), ("10.5-12.5k", 10500, 12500)]:
    print(f"{nm:11s} baseline shift {band(bi, bq, lo, hi):+.2f} % | VRLI gain: quasi-steady {band(vq, bq, lo, hi):+.2f} %  inertial (I=400 both) {band(vi, bi, lo, hi):+.2f} %  VRLI with a 140 mm venturi (I=240) vs baseline (I=400) {band(v2, bi, lo, hi):+.2f} %")
