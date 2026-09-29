"""Finding 0034: SDM26 as-built 4-2-1 exhaust variants on top of the 0033 as-built intake.

Geometry (owner, 2026-09-29), tube wall 0.049 in:
  primary   1.25 in OD (ID 29.26 mm) 312.3 mm flange -> first-collector start, stepping to 1.5 in at the collector entry
  collector 106.3 mm long, pipes side by side for the first 46.6 mm, merged 59.7 mm after
  secondary 1.5 in (ID 35.61 mm); 467.3 mm "from the first collector to the end of the second"
  collector 2 identical; then 1.5 -> 1.75 -> 2.0 in steps, 2 in straight-through muffler, open end
Model (x downstream):
  primary   = head port + 312.3 tube + 46.6 pre-merge side-by-side (1.5 in)   -> junction at merge 1
  secondary = 59.7 merged cone (2 A -> A) + secondary tube + 46.6 pre-merge  -> junction at merge 2
  collector = 59.7 merged cone + step sections + muffler (2 in)              -> open end (0032 physical R + 0.6133 r)
"""
import json, math, copy, os, sys
H = os.path.dirname(os.path.abspath(__file__))
C = "C:/Users/nmurray/Documents/Helios-worktrees/audit-1dcfd-0929/apps/desktop/src-tauri/resources/cfd/configs"
BASE = json.load(open(C + "/sdm26_asbuilt.json"))
IN = 0.0254; WALL = 0.049 * IN
def tid(od_in): return round(od_in * IN - 2 * WALL, 5)
D125, D150, D175, D200 = tid(1.25), tid(1.5), tid(1.75), tid(2.0)   # 29.26 / 35.61 / 41.96 / 48.31 mm
D_MERGE = round(D150 * math.sqrt(2), 5)                              # merged area = 2 x 1.5 in pipe
D_SEAT = round(0.85 * 0.023 * math.sqrt(2), 5)                       # two 0.85 x 23 mm exhaust throats as one pipe = 27.65 mm
PRIM_TUBE, PRE, MERGED, COLL = 0.3123, 0.0466, 0.0597, 0.1063
STEP_T = 0.010                                                       # 10 mm transition for each diameter step
SEC_467 = 0.4673

def cells(L, dx=0.009): return max(12, round(L / dx))
def primary_profile(port, d_id):
    L0 = port + PRIM_TUBE
    p = [[0.0, D_SEAT], [port, d_id], [L0 - STEP_T, d_id], [L0, D150], [L0 + PRE, D150]]
    return [[round(x, 5), d] for x, d in p]
def secondary_profile(tube):
    L = MERGED + tube + PRE
    return [[0.0, D_MERGE], [MERGED, D150], [round(L, 5), D150]]
def collector_profile(steps, muffler):
    # CAD (owner screenshot 09-29): straight run with the 1.5 -> 1.75 -> 2.0 in steps, V-band, ~90 deg
    # elbow (centreline length), then the muffler. `steps` = that whole stepped + elbow section.
    # 1.75 in for the first 100 mm (or half if shorter), 2.0 in after; bend loss not modelled.
    x = MERGED; p = [[0.0, D_MERGE], [x, D150]]
    h = min(0.100, steps / 2)
    p += [[x + STEP_T, D175], [x + h, D175], [x + h + STEP_T, D200]]
    x += steps; p += [[x, D200]]
    x += muffler; p += [[x, D200]]
    return [[round(a, 5), b] for a, b in p]

def make(port=0.065, d_id=D125, sec="A", steps=0.300, muffler=0.305, tune=None):
    d = copy.deepcopy(BASE)
    tube = {"A": SEC_467 - COLL, "B": SEC_467, "C": SEC_467 - 2 * COLL}[sec]
    pp = primary_profile(port, d_id); Lp = pp[-1][0]
    for i, p in enumerate(d["exhaust_primaries"]):
        p.update(length=Lp, diameter=pp[0][1], diameter_out=D150, n_points=cells(Lp), diameter_profile=pp)
    sp = secondary_profile(tube); Ls = sp[-1][0]
    for p in d["exhaust_secondaries"]:
        p.update(length=Ls, diameter=D_MERGE, diameter_out=D150, n_points=cells(Ls), diameter_profile=sp)
    cp = collector_profile(steps, muffler); Lc = cp[-1][0]
    d["exhaust_collector"].update(length=Lc, diameter=D_MERGE, diameter_out=D200, n_points=cells(Lc), diameter_profile=cp)
    if tune:
        d["physics"]["spark_advance_map"] = tune["spark"]
        d["physics"]["afr_map"] = tune["afr"]
    return d

def real_tune():
    import csv
    rows = [r for r in csv.DictReader(open(H + "/tune_wot.csv"))]
    spark = [[float(r["bin"]), round(float(r["ign"]), 2)] for r in rows]
    afr = [[float(r["bin"]), round(float(r["lam"]) * 14.7, 3)] for r in rows]
    return {"spark": spark, "afr": afr}

def jobs():
    J = {}
    # baseline: port 65 mm, 1.25 in OD primaries, secondary interp A, 300 mm step/elbow section + 12 in muffler
    J["AB_ex"] = make()
    J["AB_ex_muf432"] = make(muffler=0.432)                 # 17 in muffler
    for st in (200, 400):
        pass
    for st in (250, 350):
        J[f"AB_ex_st{st}"] = make(steps=st / 1000)
    for st in (200, 400):
        J[f"AB_ex_st{st}"] = make(steps=st / 1000)
        J[f"AB_ex_st{st}_muf432"] = make(steps=st / 1000, muffler=0.432)
    # ID 31.75 mm primary sensitivity dropped: owner confirmed OD sizes (2026-09-29)
    for pm in (40, 50, 80, 90):
        J[f"AB_ex_port{pm}"] = make(port=pm / 1000)
    J["AB_ex_secB"] = make(sec="B")
    J["AB_ex_secC"] = make(sec="C")
    return J

if __name__ == "__main__":
    os.makedirs(H + "/cfg", exist_ok=True)
    J = jobs()
    if "--tune" in sys.argv:
        t = real_tune()
        base = BASE if True else None
        dt = copy.deepcopy(BASE); dt["physics"]["spark_advance_map"] = t["spark"]; dt["physics"]["afr_map"] = t["afr"]
        J = {"AB_intake_tune": dt}
        best = sys.argv[sys.argv.index("--tune") + 1] if len(sys.argv) > sys.argv.index("--tune") + 1 else None
        if best:
            kw = json.loads(best); J["AB_full_tune"] = make(tune=t, **kw)
    for k, d in J.items():
        json.dump(d, open(f"{H}/cfg/{k}.json", "w"), indent=1)
        print(k, "Lp=%.4f Ls=%.4f Lc=%.4f" % (d["exhaust_primaries"][0]["length"], d["exhaust_secondaries"][0]["length"], d["exhaust_collector"]["length"]))
