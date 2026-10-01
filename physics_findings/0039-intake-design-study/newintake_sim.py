"""Finding 0039: direct 1D simulation of the recommended intake vs the as-built baseline (no surface interpolation).

Baseline: as-built (1.44 L, 228 mm venturi R 0.572, Cd 0.95, 248 mm runner above the flange).
New: 2.75 L box, ~123 mm venturi (38 mm outlet, 5.5 deg; recovery 0.5746 incl. wall friction), VRLI 198 -> 298 mm above
the flange with the 40 mm-bore trumpets displacing plenum air (vrli_trumpet_od / vrli_displacement_ref), run at every
trumpet position (10 mm steps) at every rpm, so the ECU table is picked from real runs. Cd 0.98 variant at the chosen
positions. 160-cell plenum, 20 cycles (last 5 averaged), 4000-12500 rpm in 250 rpm steps. Resumable NDJSON.
"""
import json, os, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
import study
from nothrottle import unthrottle

H = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(H, "newintake.ndjson")
RPM = list(range(4000, 12501, 250))
LO, HI = 198.1, 298.1                      # mm above the head flange
POS = [round(LO + 10 * k, 1) for k in range(11)]
R_NEW = 0.5746
BASE_N, BASE_P = study.make_cfg()                                   # as-built (1.44 L, 38 mm / 3.2 deg, Cd 0.95)
NEW_N, NEW_P = study.make_cfg(V=2.75e-3, R=R_NEW)
CD_N, CD_P = study.make_cfg(V=2.75e-3, R=R_NEW, cd=0.98)
OUTSIDE0 = 248.1

def run(job):
    case, cfgp, rpm, pos = job
    args = [study.EXE, cfgp, str(rpm), "20", f"plenum_n_cells={study.CELLS}", f"runner_mouth_extension={(pos - OUTSIDE0) / 1000:.4f}"]
    if case != "base":
        args += ["vrli_trumpet_od=0.040", f"vrli_displacement_ref={(LO - OUTSIDE0) / 1000:.4f}"]
    p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    unthrottle(p.pid)                                                # Windows EcoQoS otherwise holds it at ~25 % of a core
    out, err = p.communicate()
    try: x = json.loads(out.strip().splitlines()[-1])
    except Exception: x = {"rpm": rpm, "error": err[-300:]}
    x.update(case=case, pos=pos); return json.dumps(x)

def done():
    s = set()
    if os.path.exists(OUT):
        for l in open(OUT):
            x = json.loads(l)
            if "bt" in x: s.add((x["case"], x["rpm"], x["pos"]))
    return s

if __name__ == "__main__":
    unthrottle(os.getpid())
    jobs = [("base", BASE_P, r, OUTSIDE0) for r in RPM] + [("new", NEW_P, r, p) for r in RPM for p in POS]
    d = done(); todo = [j for j in jobs if (j[0], j[2], j[3]) not in d]
    print(len(jobs), "jobs,", len(todo), "to run", flush=True)
    with open(OUT, "a") as f, ThreadPoolExecutor(15) as ex:
        for i, line in enumerate(ex.map(run, todo)):
            f.write(line + "\n"); f.flush()
            if i % 50 == 0: print(i, "/", len(todo), flush=True)
    # Cd 0.98 variant at the best position per rpm of the new intake
    best = {}
    for l in open(OUT):
        x = json.loads(l)
        if x.get("case") == "new" and "bt" in x and x["bt"] > best.get(x["rpm"], (0, -1))[1]: best[x["rpm"]] = (x["pos"], x["bt"])
    d = done(); todo = [("cd98", CD_P, r, best[r][0]) for r in RPM if ("cd98", r, best[r][0]) not in d]
    with open(OUT, "a") as f, ThreadPoolExecutor(15) as ex:
        for line in ex.map(run, todo): f.write(line + "\n"); f.flush()
    print("done", flush=True)
