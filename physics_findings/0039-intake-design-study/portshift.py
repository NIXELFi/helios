"""Finding 0039: where does the VRLI window belong if the head port is longer than the model's 80 mm estimate?

asmeasured_report.py: with a 100-120 mm port the model's torque peaks land on the dyno's (5.9k and 8.6k); with 80 mm they sit
4-8 % high in rpm. Here: the real plenum (1.826 L, 141 mm), neutral tune, inertance on, port 80 mm and 115 mm, trumpet positions
148-298 mm above the flange in 25 mm steps, 4000-12500 rpm. Every 100 mm window is scored against the fixed 248 mm runner
with the same port. Resumable (portshift.ndjson); `--report` prints the table.
"""
import os; os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
import json, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
import study
from nothrottle import unthrottle

H = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(H, "portshift.ndjson")
RPM = list(range(4000, 12501, 500)); POS = [148.1, 173.1, 198.1, 223.1, 248.1, 273.1, 298.1]; PORTS = [0.080, 0.115]

def run(job):
    port, cfgp, kind, rpm, pos = job
    a = [study.EXE, cfgp, str(rpm), "20", f"plenum_n_cells={study.CELLS}", "restrictor_inertance=400", f"runner_mouth_extension={(pos - 248.1) / 1000:.4f}"]
    if kind == "vrli": a += ["vrli_trumpet_od=0.040", "vrli_displacement_ref=-0.0500"]
    p = subprocess.Popen(a, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True); unthrottle(p.pid); out, err = p.communicate()
    try: x = json.loads(out.strip().splitlines()[-1])
    except Exception: x = {"rpm": rpm, "error": err[-300:]}
    x.update(port=port, kind=kind, pos=pos); return json.dumps(x)

def report():
    import numpy as np, pandas as pd, core, vrli_common as vc
    D = pd.DataFrame([json.loads(l) for l in open(OUT)]); D = D[D.bt.notna()]; R = vc.R; TODAY = core.today()(R); rows = []
    for port in PORTS:
        cur = lambda kind, pos: D[(D.port == port) & (D.kind == kind) & np.isclose(D.pos, pos)].drop_duplicates("rpm").set_index("rpm").bt.reindex(R).values
        B = cur("static", 248.1); G = np.array([cur("vrli", p) for p in POS]).T
        def band(T, lo, hi):
            m = (R >= lo) & (R <= hi); return (np.trapezoid((TODAY * T / B)[m], R[m]) / np.trapezoid(TODAY[m], R[m]) - 1) * 100
        sh = lambda T: np.interp(np.minimum(R * 1.04, R[-1]), R, T)
        for i0 in range(len(POS) - 4):
            g = G[:, i0:i0 + 5]; path = core.dp_schedule(g / B[:, None], vc.W_P1, 1); T = g[np.arange(len(R)), path]
            s = {"6-12k": band(T, 6000, 12000), "7-10.5k": band(T, 7000, 10500)}
            for k, w in vc.DC.items(): s[k] = (np.sum(w * TODAY * T / B) / np.sum(w * TODAY) - 1) * 100; s[k + "+4%"] = (np.sum(w * TODAY * sh(T) / sh(B)) / np.sum(w * TODAY) - 1) * 100
            rows.append(dict(port_mm=port * 1000, window=f"{POS[i0]:.0f}-{POS[i0 + 4]:.0f}", worst=min(s.values()), **{"6-12k": s["6-12k"], "7-10.5k": s["7-10.5k"]}, top=band(T, 10500, 12500), low=band(T, 4000, 6000),
                             sched="/".join(f"{POS[i0 + j]:.0f}" for j in path)))
    T = pd.DataFrame(rows); pd.set_option("display.width", 250); print(T.round(2).to_string(index=False)); T.round(3).to_csv(os.path.join(H, "charts", "asmeasured", "portshift.csv"), index=False)

if __name__ == "__main__":
    if "--report" in sys.argv: report(); sys.exit()
    import asmeasured
    unthrottle(os.getpid()); have = set()
    if os.path.exists(OUT):
        for l in open(OUT):
            x = json.loads(l)
            if "error" not in x: have.add((x["port"], x["kind"], x["rpm"], x["pos"]))
    jobs = []
    for port in PORTS:
        c = asmeasured.build(f"design_port{port * 1000:.0f}", plenum=True, runners=[0.2481] * 4, tune=False, port=port)
        jobs += [(port, c, "static", r, 248.1) for r in RPM] + [(port, c, "vrli", r, p) for r in RPM for p in POS]
    jobs = [j for j in jobs if (j[0], j[2], j[3], j[4]) not in have]; print(len(jobs), "to run,", study.THREADS, "threads", flush=True)
    with open(OUT, "a") as f, ThreadPoolExecutor(study.THREADS) as ex:
        for line in ex.map(run, jobs): f.write(line + "\n"); f.flush()
    print("done", flush=True)
