"""Finding 0039: plenum volume check on a DUMP plenum (plain cylinder, so the restrictor's exit velocity is lost, as Fluent's
3D whole-intake run shows; diag/plenum_recovery.py). Same runs as plenum2.py for four plenums: 1.44 / 2.75 / 3.5 L at 120 mm
and 1.44 L at 213 mm; fixed 248 mm runner and the VRLI at five positions; tip-in. Output plenum3.ndjson, plenum3_tipin.ndjson."""
import json, math, os
from concurrent.futures import ThreadPoolExecutor
import study, plenum2
from nothrottle import unthrottle

H = plenum2.H; OUT, OUT_T = os.path.join(H, "plenum3.ndjson"), os.path.join(H, "plenum3_tipin.ndjson")
def configs():
    for V, h in [(1.44, 120), (2.75, 120), (3.5, 120), (1.44, 213)]:
        d = json.load(open(study.BASE)); d["physics"].pop("afr_map", None); d["physics"].pop("spark_advance_map", None)
        L = h / 1000; D = math.sqrt(4 * V * 1e-3 / (math.pi * L)); d["plenum"].update(volume=V * 1e-3, length=L, diameter_profile=[[0.0, round(D, 6)], [L, round(D, 6)]])
        d["name"] = f"dump plenum {V} L {h} mm"; p = os.path.join(H, "cfg", f"DUMP_V{V:.2f}_H{h}.json"); json.dump(d, open(p, "w"), indent=1)
        yield dict(V=V, h=h, name=os.path.basename(p), path=p)

if __name__ == "__main__":
    unthrottle(os.getpid()); C = list(configs()); R, POS, B = plenum2.RPM, plenum2.POS, plenum2.BASE_POS
    jobs = [(c, "static", r, B) for c in C for r in R] + [(c, "vrli", r, p) for c in C for r in R for p in POS]
    d = plenum2.done(OUT, lambda x: (x["V"], x["h"], x["kind"], x["rpm"], x["pos"]))
    todo = [j for j in jobs if (j[0]["V"], j[0]["h"], j[1], j[2], j[3]) not in d]
    print(len(jobs), "jobs,", len(todo), "to run,", study.THREADS, "threads", flush=True)
    with open(OUT, "a") as f, ThreadPoolExecutor(study.THREADS) as ex:
        for i, line in enumerate(ex.map(plenum2.run, todo)):
            f.write(line + "\n"); f.flush()
            if i % 100 == 0: print(i, "/", len(todo), flush=True)
    dt = plenum2.done(OUT_T, lambda x: (x["V"], x["h"], x["rpm"]))
    with open(OUT_T, "a") as f, ThreadPoolExecutor(study.THREADS) as ex:
        for line in ex.map(plenum2.run_tipin, [(c, r) for c in C for r in (6000, 8500) if (c["V"], c["h"], r) not in dt]): f.write(line + "\n"); f.flush()
    print("done", flush=True)
