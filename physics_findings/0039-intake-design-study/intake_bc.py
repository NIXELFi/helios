"""Finding 0039: intake-side boundary traces from the 1D model for the Fluent 3D whole-intake runs (intake_bc/).

Two cases on the all-measured car (cfg/ASMEASURED_all.json: real runners 252 / 230 mm, real exhaust, logged tune):
  asbuilt  plenum 1.826 L, 140.9 mm tall
  big      the same plenum with a 93 mm straight section added at its base (the length a 136 mm restrictor frees)
One 720 deg cycle (the 20th) at 1 deg, WOT, 160-cell plenum, venturi inertance 400 1/m. Driver: driver/src/bin/intakewave.rs.
Prints the per-cylinder trapped air and the plenum pressure for each case, i.e. the 1D verdict the 3D run is checking.
"""
import os; os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
import io, json, math, subprocess, sys
import numpy as np, pandas as pd
from concurrent.futures import ThreadPoolExecutor
from nothrottle import unthrottle

H = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(H, "intake_bc"); os.makedirs(OUT, exist_ok=True)
EXE = os.path.join(H, "driver", "target", "release", "intakewave.exe")
RPMS = [9000, 6000, 11500]; EXTRA = 0.093

base = json.load(open(os.path.join(H, "cfg", "ASMEASURED_all.json")))
big = json.loads(json.dumps(base)); prof = big["plenum"]["diameter_profile"]; prof.append([round(prof[-1][0] + EXTRA, 6), prof[-1][1]])
big["plenum"]["length"] = prof[-1][0]; big["plenum"]["volume"] = sum(math.pi / 12 * (x1 - x0) * (a * a + a * b + b * b) for (x0, a), (x1, b) in zip(prof, prof[1:]))
big["name"] = "as-measured, plenum + 93 mm straight section"
CFG = {"asbuilt": os.path.join(H, "cfg", "ASMEASURED_all.json"), "big": os.path.join(H, "cfg", "ASMEASURED_all_bigplenum.json")}
json.dump(big, open(CFG["big"], "w"), indent=1)
GEO = {"asbuilt": base["plenum"], "big": big["plenum"]}
# the same pair on DUMP plenums (plain cylinders: the restrictor's exit velocity is lost, diag/plenum_recovery.py) at the volumes
# Fluent meshed (1.823 L / 140.9 mm, 3.863 L / 233.9 mm), and at more speeds: the bigger plenum moves the 8.5-9k peak down
RPM_DUMP = [6000, 8000, 8500, 9000, 9500, 11500]
# 2026-10-02: runners re-measured bellmouth lip to flange (260.2 mm cylinders 1 and 4, 256.0 mm cylinders 2 and 3) and plenum gas
# volume with the bellmouths in (1.807 L, 3.847 L); cfg/ASMEASURED_all_r260.json is written by asmeasured.py
base_lip = json.load(open(os.path.join(H, "cfg", "ASMEASURED_all_r260.json")))
for _n, _V, _L in [("asbuilt_dump", 1.807e-3, 0.1409), ("big_dump", 3.847e-3, 0.2339)]:
    _d = json.loads(json.dumps(base_lip)); _D = math.sqrt(4 * _V / (math.pi * _L)); _d["plenum"].update(volume=_V, length=_L, diameter_profile=[[0.0, round(_D, 6)], [_L, round(_D, 6)]])
    _d["name"] = "as-measured, dump plenum " + _n; CFG[_n] = os.path.join(H, "cfg", f"ASMEASURED_{_n}.json"); json.dump(_d, open(CFG[_n], "w"), indent=1); GEO[_n] = _d["plenum"]

def run(job):
    case, rpm = job; f = os.path.join(OUT, f"intake_{case}_{rpm}rpm.csv")
    if not os.path.exists(f) or "--force" in sys.argv or ("--dump" in sys.argv and "dump" in case):
        p = subprocess.Popen([EXE, CFG[case], str(rpm), "20", "plenum_n_cells=160", "restrictor_inertance=400", "runner_mouth_extension=0.0000"], stdout=subprocess.PIPE, text=True)
        unthrottle(p.pid); io.open(f, "w", newline="\n").write(p.communicate()[0])
    return case, rpm, pd.read_csv(f)

if __name__ == "__main__":
    unthrottle(os.getpid())
    with ThreadPoolExecutor(6) as ex: res = list(ex.map(run, [(c, r) for r in RPMS for c in ("asbuilt", "big")] + [(c, r) for r in RPM_DUMP for c in ("asbuilt_dump", "big_dump")]))
    cyl = base["cylinder"]; Vd = math.pi / 4 * cyl["bore"] ** 2 * cyl["stroke"]; rho = base["p_ambient"] / (287.0 * base["T_ambient"])
    rows = []
    for case, rpm, x in res:
        dt = np.gradient(x.t_s.values); m = [float(np.sum(x[f"mdot_valve{i}_kg_s"] * dt)) for i in range(1, 5)]
        ivc = [float(x[f"p_port{i}_Pa"][(x[f"phase{i}_deg"] >= 560) & (x[f"phase{i}_deg"] <= 600)].mean()) for i in range(1, 5)]
        rows.append(dict(case=case, rpm=rpm, plenum_L=GEO[case]["volume"] * 1e3, plenum_mm=GEO[case]["length"] * 1e3, mdot_restrictor_g_s=1000 * x.mdot_restrictor_kg_s.mean(),
                         **{f"trapped{i}_mg": 1e6 * v for i, v in enumerate(m, 1)}, ve=sum(m) / (4 * rho * Vd), p_plenum_mean_kPa=x.p_plenum_mean_Pa.mean() / 1e3,
                         p_plenum_swing_kPa=(x.p_plenum_floor_Pa.max() - x.p_plenum_floor_Pa.min()) / 1e3, p_port_560_600_kPa=np.mean(ivc) / 1e3))
    T = pd.DataFrame(rows).sort_values(["rpm", "case"]); pd.set_option("display.width", 250); print(T.round(3).to_string(index=False))
    T.round(4).to_csv(os.path.join(OUT, "summary_1d.csv"), index=False)
