"""Finding 0039: the as-MEASURED car (Fluent agent's cuts of the assembly CAD) vs the as-modelled one, against the dyno.

Measured intake (26_06_IN_ASSY_ASM_U): plenum 1.826 L, 140.9 mm from the restrictor exit plane to the floor (model:
1.44 L, 120 mm, both estimates); runners 252 mm (outer pair) / 230 mm (inner pair) mouth to head flange (model 248.1 mm
x4); mouths are plain sharp-edged counterbores (model entry K = 0.2). The 80 mm head port stays an estimate.
Measured exhaust (SDM26Exhaust_Assm): primaries 481 mm valve to merge (model 423.9), secondaries 576 mm merge to merge
(model 467.3), bores 29.75 / 36.10 mm (model 29.26 / 35.61); final pipe kept at the model's 664.7 mm.

Dyno set (logged AFR / spark maps, 250 rpm steps, fixed runner):
  model | plenum (real plenum) | intake (real plenum + runners 252/230 on cyl 1,4 / 2,3) | exh (model intake, real exhaust)
  all (real intake + real exhaust) | all_sharp (all + runner entry K 0.5) | all_mid / all_big (all + 40 / 93 mm of straight plenum)
Design set (neutral tune, 500 rpm steps, real plenum): fixed 248 mm runner and the VRLI at five positions.
All with the venturi inertance on (400 1/m) and a 160-cell plenum. Resumable (asmeasured.ndjson).
"""
import json, math, os, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
import study
from nothrottle import unthrottle

H = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(H, "asmeasured.ndjson")
PORT = 0.080; INERT = 400.0; V_REAL, H_REAL = 1.826e-3, 140.9
RPM_DYNO = list(range(4000, 12501, 250)); RPM_DESIGN = list(range(4000, 12501, 500))
BASE = json.load(open(study.BASE))

def build(name, plenum=False, runners=None, exhaust=False, tune=True, extra=0.0, dump=False):
    if plenum:
        _, p = study.make_cfg(V=V_REAL, lenfac=H_REAL / 120.0); d = json.load(open(p))
    else:
        d = json.loads(json.dumps(BASE)); d["physics"].pop("afr_map", None); d["physics"].pop("spark_advance_map", None)
    if extra:                                                   # straight section added at the plenum floor (intake_bc.py's "big" case)
        prof = d["plenum"]["diameter_profile"]; prof.append([round(prof[-1][0] + extra, 6), prof[-1][1]]); d["plenum"]["length"] = prof[-1][0]
        d["plenum"]["volume"] = sum(math.pi / 12 * (x1 - x0) * (a * a + a * b + b * b) for (x0, a), (x1, b) in zip(prof, prof[1:]))
    if dump:                                                    # plain cylinder of the same volume and height: the restrictor's exit velocity is lost, as in the 3D run
        D = math.sqrt(4 * d["plenum"]["volume"] / (math.pi * d["plenum"]["length"])); d["plenum"]["diameter_profile"] = [[0.0, round(D, 6)], [d["plenum"]["length"], round(D, 6)]]
    if tune:
        for k in ("afr_map", "spark_advance_map"): d["physics"][k] = BASE["physics"][k]
    if runners:
        for pipe, L in zip(d["intake_pipes"], runners):
            pipe["length"] = round(L + PORT, 4); pipe["diameter_profile"] = [[0.0, 0.040], [round(L, 4), 0.036], [round(L + PORT, 4), 0.033]]
    if exhaust:
        for pipe in d["exhaust_primaries"]:
            pipe.update(length=0.4812, diameter=0.02765, diameter_out=0.0361, n_points=53,
                        diameter_profile=[[0.0, 0.02765], [0.065, 0.02975], [0.3654, 0.02975], [0.3754, 0.0361], [0.4812, 0.0361]])
        for pipe in d["exhaust_secondaries"]:
            pipe.update(length=0.5764, diameter=0.05105, diameter_out=0.0361, n_points=64, diameter_profile=[[0.0, 0.05105], [0.0756, 0.0361], [0.5764, 0.0361]])
        d["exhaust_collector"].update(diameter=0.05105, diameter_out=0.0488,
                                      diameter_profile=[[0.0, 0.05105], [0.0507, 0.0361], [0.1039, 0.0481], [0.1224, 0.0488], [0.6647, 0.0488]])
    d["name"] = "as-measured " + name
    q = os.path.join(H, "cfg", f"ASMEASURED_{name}.json"); json.dump(d, open(q, "w"), indent=1); return q

OUTER14 = [0.252, 0.230, 0.230, 0.252]
DYNO = {"model": (build("model"), []), "plenum": (build("plenum", plenum=True), []), "intake": (build("intake", plenum=True, runners=OUTER14), []),
        "exh": (build("exh", exhaust=True), []), "all": (build("all", plenum=True, runners=OUTER14, exhaust=True), []),
        "all_sharp": (build("all", plenum=True, runners=OUTER14, exhaust=True), ["intake_runner_entry_k=0.5"]),
        "all_big": (build("all_big", plenum=True, runners=OUTER14, exhaust=True, extra=0.093), []),      # 4.03 L, 234 mm: the 3D plenum check's big case
        "all_mid": (build("all_mid", plenum=True, runners=OUTER14, exhaust=True, extra=0.040), []),
        "all_dump": (build("all_dump", plenum=True, runners=OUTER14, exhaust=True, dump=True), []),               # diag/plenum_recovery.py
        "model_dump": (build("model_dump", dump=True), [])}      # 2.77 L, 181 mm
DESIGN_CFG = build("design_plenum", plenum=True, tune=False)
VPOS = [198.1, 223.1, 248.1, 273.1, 298.1]

def run(job):
    case, cfgp, rpm, extra = job
    p = subprocess.Popen([study.EXE, cfgp, str(rpm), "20", f"plenum_n_cells={study.CELLS}", f"restrictor_inertance={INERT}", *extra], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True); unthrottle(p.pid)
    out, err = p.communicate()
    try: x = json.loads(out.strip().splitlines()[-1])
    except Exception: x = {"rpm": rpm, "error": err[-300:]}
    x.update(case=case); return json.dumps(x)

if __name__ == "__main__":
    unthrottle(os.getpid())
    have = set()
    if os.path.exists(OUT):
        for l in open(OUT):
            x = json.loads(l)
            if "error" not in x: have.add((x["case"], x["rpm"]))
    jobs = [(c, p, r, ["runner_mouth_extension=0.0000", *e]) for c, (p, e) in DYNO.items() for r in RPM_DYNO]
    jobs += [("design_static", DESIGN_CFG, r, ["runner_mouth_extension=0.0000"]) for r in RPM_DESIGN]
    jobs += [(f"design_vrli_{pos:.0f}", DESIGN_CFG, r, [f"runner_mouth_extension={(pos - 248.1) / 1000:.4f}", "vrli_trumpet_od=0.040", "vrli_displacement_ref=-0.0500"]) for pos in VPOS for r in RPM_DESIGN]
    jobs = [j for j in jobs if (j[0], j[2]) not in have]
    print(len(jobs), "to run,", study.THREADS, "threads", flush=True)
    with open(OUT, "a") as f, ThreadPoolExecutor(study.THREADS) as ex:
        for line in ex.map(run, jobs): f.write(line + "\n"); f.flush()
    print("done", flush=True)
