"""Finding 0039: engine-level effect of the corrected exhaust merge geometry (junction at the crotch, 75.6 mm upstream of the merge
point at each 2-into-1 collector; diag/exhaust_match2.py) and of hotter exhaust walls, on the all-measured car.
Torque curve at 250 rpm steps against the dyno, and the intake pressure drop at 7-10k against the logs. Output exhaust_fix.ndjson."""
import os; os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
import io, json, subprocess, sys, numpy as np, pandas as pd
from concurrent.futures import ThreadPoolExecutor
H = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(H, "diag"))
import study
from nothrottle import unthrottle
OUT = os.path.join(H, "exhaust_fix.ndjson"); REL = os.path.join(H, "driver", "target", "release"); B = ["plenum_n_cells=160", "restrictor_inertance=400", "runner_mouth_extension=0.0000"]
RPMS = list(range(4000, 12501, 250)); CAR = {7000: 3.24, 8000: 4.60, 9000: 6.51, 9500: 7.38, 10000: 7.85}
HOT = ["primary_wall_t=1100", "secondary_wall_t=1050", "collector_wall_t=1000"]; MID = ["primary_wall_t=1000", "secondary_wall_t=900", "collector_wall_t=800"]
A, C = os.path.join(H, "cfg", "DIAG_exh2_a.json"), os.path.join(H, "cfg", "DIAG_exh2_c.json")
CASES = {"junction at merge point (as modelled)": (A, []), "junction at crotch": (C, []), "junction at crotch, walls 1000/900/800": (C, MID), "junction at crotch, walls 1100/1050/1000": (C, HOT)}
def point(job):
    n, rpm = job; c, ex = CASES[n]; p = subprocess.Popen([os.path.join(REL, "intakepoint.exe"), c, str(rpm), "20", *B, *ex], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True); unthrottle(p.pid); o, e = p.communicate()
    try: x = json.loads(o.strip().splitlines()[-1])
    except Exception: x = {"rpm": rpm, "error": e[-300:]}
    x.update(case=n); return json.dumps(x)
def drop(job):
    n, rpm = job; c, ex = CASES[n]; p = subprocess.Popen([os.path.join(REL, "intakewave.exe"), c, str(rpm), "20", *B, *ex], stdout=subprocess.PIPE, text=True); unthrottle(p.pid)
    w = pd.read_csv(io.StringIO(p.communicate()[0])); return dict(case=n, rpm=rpm, mdot_g_s=1000 * w.mdot_restrictor_kg_s.mean(), map_drop=(97300 - w.p_plenum_map_Pa.mean()) / 1e3, car=CAR[rpm])
if __name__ == "__main__":
    unthrottle(os.getpid()); have = set()
    if os.path.exists(OUT):
        for l in open(OUT):
            x = json.loads(l)
            if "error" not in x: have.add((x["case"], x["rpm"]))
    jobs = [(n, r) for n in CASES for r in RPMS if (n, r) not in have]; print(len(jobs), "to run", flush=True)
    with open(OUT, "a") as f, ThreadPoolExecutor(study.THREADS) as ex:
        for line in ex.map(point, jobs): f.write(line + chr(10)); f.flush()
    with ThreadPoolExecutor(study.THREADS) as ex: M = pd.DataFrame(list(ex.map(drop, [(n, r) for n in CASES for r in CAR])))
    M.round(3).to_csv(os.path.join(H, "charts", "asmeasured", "exhaust_fix_map.csv"), index=False)
    D = pd.DataFrame([json.loads(l) for l in open(OUT)]); D = D[D.bt.notna()]; dy = pd.read_csv(os.path.join(H, "data", "dyno_raw_25rpm.csv")); pd.set_option("display.width", 250); rows = []
    P = D.pivot_table(index="rpm", columns="case", values="bt")[list(CASES)] * 0.94; r = P.index.values.astype(float); d = np.interp(r, dy.rpm, dy.Nm); b = P[list(CASES)[0]].values
    for n in CASES:
        t = P[n].values; band = lambda lo, hi: (np.trapezoid(t[(r >= lo) & (r <= hi)], r[(r >= lo) & (r <= hi)]) / np.trapezoid(b[(r >= lo) & (r <= hi)], r[(r >= lo) & (r <= hi)]) - 1) * 100
        pk = lambda lo, hi: r[(r >= lo) & (r <= hi)][np.argmax(t[(r >= lo) & (r <= hi)])]; u = r >= 5500; k = np.sum(t[u] * d[u]) / np.sum(t[u] ** 2); m = M[M.case == n]
        rows.append(dict(case=n, **{"4-6k": band(4000, 6000), "6-12k": band(6000, 12000), "7-10.5k": band(7000, 10500), "10.5-12.5k": band(10500, 12500)}, lower_peak=pk(5000, 7250), upper_peak=pk(7750, 10000), peak_Nm=t.max(),
                         rms_7_10k=np.sqrt(np.mean((t - d)[(r >= 7000) & (r <= 10000)] ** 2)), rms_5p5up=np.sqrt(np.mean((t - d)[u] ** 2)), scale=k, shape_5p5up=np.sqrt(np.mean((k * t - d)[u] ** 2)), map_rms=np.sqrt(np.mean((m.map_drop - m.car) ** 2))))
    print(pd.DataFrame(rows).round(2).to_string(index=False)); print(P.assign(dyno=d).loc[5500:12500:2].round(1).T.to_string()); print(M.pivot_table(index="rpm", columns="case", values=["map_drop", "mdot_g_s"]).round(2).T.to_string())
    pd.DataFrame(rows).round(3).to_csv(os.path.join(H, "charts", "asmeasured", "exhaust_fix_bands.csv"), index=False)
