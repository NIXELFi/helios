"""Finding 0039: the primary-diameter comparison (primary_dia.py) repeated on the CORRECTED exhaust merge geometry (junction at the
crotch, 75.6 mm upstream of the merge point; diag/exhaust_match2.py), with the calibrated walls and with hotter walls (closest to
the 3D gas temperature). p125 = CAD; p150 = primaries 36.10 mm and every diameter downstream x 1.176; p150only = primaries 36.10 mm,
rest as CAD. Output primary_dia_crotch.ndjson; traces exhaust_bc/exhaust_crotch_{case}_{rpm}rpm.csv with --traces."""
import os; os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
import io, json, math, subprocess, sys, numpy as np, pandas as pd
from concurrent.futures import ThreadPoolExecutor
import study
from nothrottle import unthrottle
H = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(H, "primary_dia_crotch.ndjson"); REL = os.path.join(H, "driver", "target", "release")
B = ["plenum_n_cells=160", "restrictor_inertance=400"]; RPMS = list(range(4000, 12501, 250)); K = 42.45 / 36.10; D1 = 0.0361
AR = [(75.6, 2.06), (70, 2.06), (60, 2.05), (50, 1.79), (40, 1.51), (30, 1.29), (20, 1.13), (10, 1.03), (0, 1.00)]
con = lambda s: [[round((75.6 - d) / 1000, 5), round(D1 * s * math.sqrt(a), 5)] for d, a in AR]
WALLS = {"calibrated walls": [], "hot walls": ["primary_wall_t=1100", "secondary_wall_t=1050", "collector_wall_t=1000"]}
def cfgs():
    base = json.load(open(os.path.join(H, "cfg", "DIAG_exh2_c.json"))); out = {}
    for case, (tube, leg, s) in {"p125": (0.02975, D1, 1.0), "p150": (D1, D1 * K, K), "p150only": (D1, D1, 1.0)}.items():
        d = json.loads(json.dumps(base)); prim = [[0.0, 0.02765], [0.065, 0.02975]] + ([[0.075, D1]] if tube == D1 else []) + [[0.3674, tube], [0.3774, leg], [0.4076, leg]]
        for p in d["exhaust_primaries"]: p.update(diameter_profile=prim, diameter_out=leg)
        c = con(s); dd = D1 * s
        for p in d["exhaust_secondaries"]: p.update(diameter=c[0][1], diameter_out=dd, diameter_profile=c + [[0.5764, dd]])
        d["exhaust_collector"].update(diameter=c[0][1], diameter_out=round(0.0488 * s, 5), diameter_profile=c + [[0.1263, dd], [0.1795, round(0.0481 * s, 5)], [0.198, round(0.0488 * s, 5)], [0.7403, round(0.0488 * s, 5)]])
        d["name"] = "all measured, crotch merges, primaries " + case; out[case] = os.path.join(H, "cfg", f"CROTCH_{case}.json"); json.dump(d, open(out[case], "w"), indent=1)
    return out
def engine(exe, cfg, rpm, extra):
    p = subprocess.Popen([os.path.join(REL, exe), cfg, str(rpm), "20", *B, *extra], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True); unthrottle(p.pid); return p.communicate()
if __name__ == "__main__":
    C = cfgs(); unthrottle(os.getpid())
    def point(job):
        case, w, rpm = job; o, e = engine("intakepoint.exe", C[case], rpm, WALLS[w] + ["runner_mouth_extension=0.0000"])
        try: x = json.loads(o.strip().splitlines()[-1])
        except Exception: x = {"rpm": rpm, "error": e[-300:]}
        x.update(case=case, junction=w); return json.dumps(x)
    if "--traces" in sys.argv:
        def tr(job):
            case, rpm = job; out = engine("exhwave.exe", C[case], rpm, [])[0]; assert out.count(chr(10)) > 700
            io.open(os.path.join(H, "exhaust_bc", f"exhaust_crotch_{case}_{rpm}rpm.csv"), "w", newline=chr(10)).write(out); return case, rpm
        with ThreadPoolExecutor(study.THREADS) as ex: print(list(ex.map(tr, [(c, r) for c in ("p125", "p150") for r in (9000, 6000)]))); sys.exit()
    have = set()
    if os.path.exists(OUT):
        for l in open(OUT):
            x = json.loads(l)
            if "error" not in x: have.add((x["case"], x["junction"], x["rpm"]))
    jobs = [(c, w, r) for w in WALLS for c in C for r in RPMS if (c, w, r) not in have]; print(len(jobs), "to run", flush=True)
    with open(OUT, "a") as f, ThreadPoolExecutor(study.THREADS) as ex:
        for line in ex.map(point, jobs): f.write(line + chr(10)); f.flush()
    print("done", flush=True)
