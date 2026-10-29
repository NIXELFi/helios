"""Finding 0039: plenum volume x plenum height, rerun on the corrected restrictor (venturi inertance on).

Nick's plan: take ~93-100 mm out of the restrictor and give it to the plenum. Plenum length along the restrictor axis is
plenum HEIGHT in this model (restrictor at the top, runners at the floor). Sweep:
  volume 1.0 / 1.44 / 2.0 / 2.75 / 3.5 L  x  height 120 (today) / 165 / 213 mm (today + 93)
  intake: today's fixed 248 mm runner, and the VRLI 198-298 mm at five trumpet positions (trumpets displace plenum air)
  restrictor: car-fitted venturi (Cd 0.95, R 0.572) with inertance 400 1/m; 160-cell plenum; 4000-12500 rpm, 500 steps
  tip-in (6000 / 8500 rpm snap from 40 kPa) for every plenum.
Resumable NDJSON (plenum2.ndjson, plenum2_tipin.ndjson). INTAKE_THREADS sets the worker count (6 beside Fluent).
"""
import json, os, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
import study
from nothrottle import unthrottle

H = os.path.dirname(os.path.abspath(__file__))
OUT, OUT_T = os.path.join(H, "plenum2.ndjson"), os.path.join(H, "plenum2_tipin.ndjson")
TIPIN = os.path.join(H, "driver", "target", "release", "tipin.exe")
RPM = list(range(4000, 12501, 500))
HEIGHTS = [120, 165, 213]
VOLS = [1.44, 2.0, 2.75, 3.5, 1.0]
POS = [198.1, 223.1, 248.1, 273.1, 298.1]; LO = 198.1; BASE_POS = 248.1
INERT = 400.0

def configs():
    for h in HEIGHTS:
        for V in VOLS:
            if V == 1.0 and h != 120: continue
            n, p = study.make_cfg(V=V * 1e-3, lenfac=h / 120.0)
            yield dict(V=V, h=h, name=n, path=p)

def run(job):
    c, kind, rpm, pos = job
    a = [study.EXE, c["path"], str(rpm), "20", f"plenum_n_cells={study.CELLS}", f"restrictor_inertance={INERT}", f"runner_mouth_extension={(pos - BASE_POS) / 1000:.4f}"]
    if kind == "vrli": a += ["vrli_trumpet_od=0.040", f"vrli_displacement_ref={(LO - BASE_POS) / 1000:.4f}"]
    p = subprocess.Popen(a, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True); unthrottle(p.pid)
    out, err = p.communicate()
    try: x = json.loads(out.strip().splitlines()[-1])
    except Exception: x = {"rpm": rpm, "error": err[-300:]}
    x.update(V=c["V"], h=c["h"], kind=kind, pos=pos); return json.dumps(x)

def run_tipin(job):
    c, rpm = job
    p = subprocess.Popen([TIPIN, c["path"], str(rpm), "40000", "14", f"plenum_n_cells={study.CELLS}", f"restrictor_inertance={INERT}", "runner_mouth_extension=0.0000"],
                         stdout=subprocess.PIPE, text=True); unthrottle(p.pid)
    rows = [json.loads(l) for l in p.communicate()[0].strip().splitlines()]
    return json.dumps(dict(V=c["V"], h=c["h"], rpm=rpm, rows=rows))

def done(path, key):
    s = set()
    if os.path.exists(path):
        for l in open(path):
            x = json.loads(l)
            if "error" not in x: s.add(key(x))
    return s

if __name__ == "__main__":
    unthrottle(os.getpid())
    C = list(configs())
    jobs = [(c, "static", r, BASE_POS) for c in C for r in RPM] + [(c, "vrli", r, p) for c in C for r in RPM for p in POS]
    d = done(OUT, lambda x: (x["V"], x["h"], x["kind"], x["rpm"], x["pos"]))
    todo = [j for j in jobs if (j[0]["V"], j[0]["h"], j[1], j[2], j[3]) not in d]
    print(len(jobs), "jobs,", len(todo), "to run,", study.THREADS, "threads", flush=True)
    with open(OUT, "a") as f, ThreadPoolExecutor(study.THREADS) as ex:
        for i, line in enumerate(ex.map(run, todo)):
            f.write(line + "\n"); f.flush()
            if i % 100 == 0: print(i, "/", len(todo), flush=True)
    dt = done(OUT_T, lambda x: (x["V"], x["h"], x["rpm"]))
    tj = [(c, r) for c in C for r in (6000, 8500) if (c["V"], c["h"], r) not in dt]
    with open(OUT_T, "a") as f, ThreadPoolExecutor(study.THREADS) as ex:
        for line in ex.map(run_tipin, tj): f.write(line + "\n"); f.flush()
    print("done", flush=True)
