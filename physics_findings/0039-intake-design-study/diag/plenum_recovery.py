"""Does the 1D plenum add pressure recovery the real one does not have?
Fluent's 3D whole-intake run (intake3d_all4.csv): the MAP port sits only 50-150 Pa above the restrictor exit-plane static pressure.
The 1D plenum is a smooth dome-shaped duct, so it diffuses the exit velocity like an ideal diffuser.
Cycle-mean drop from ambient to the restrictor exit plane and to the MAP station in the 1D model, against the car's
self-referenced drop (engine-off MAP minus WOT MAP, Josh AX 4-26), for the model as calibrated in 0036 (20 plenum cells,
quasi-steady venturi) and as run in 0039 (160 cells, inertance 400), both on the as-modelled geometry and logged tune."""
import os; os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
import io, subprocess, sys, json, numpy as np, pandas as pd
from concurrent.futures import ThreadPoolExecutor
H = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, H)
import study
from nothrottle import unthrottle
EXE = os.path.join(H, "driver", "target", "release", "intakewave.exe"); OUT = os.path.join(H, "diag", "plenum_recovery.json")
CAR = {7000: 3.24, 8000: 4.60, 9000: 6.51, 9500: 7.38, 10000: 7.85}
CASES = {"0036 as calibrated (20 cells, QS venturi)": (study.BASE, []), "0039 (160 cells, inertance)": (study.BASE, ["plenum_n_cells=160", "restrictor_inertance=400"]),
         "0039, all-measured geometry": (os.path.join(H, "cfg", "ASMEASURED_all.json"), ["plenum_n_cells=160", "restrictor_inertance=400"])}
# "dump" plenum: a plain cylinder of the same volume and height, so the venturi discharges into the full area and its exit
# dynamic pressure is lost (what the 3D run shows), with the venturi recovery R as calibrated and two higher values
import math
_d = json.load(open(study.BASE)); _V, _L = _d["plenum"]["volume"], _d["plenum"]["length"]; _D = math.sqrt(4 * _V / (math.pi * _L))
_d["plenum"]["diameter_profile"] = [[0.0, round(_D, 6)], [_L, round(_D, 6)]]; _d["name"] = "as-built, cylinder plenum"
DUMP = os.path.join(H, "cfg", "DIAG_dump_plenum.json"); json.dump(_d, open(DUMP, "w"), indent=1)
for _R in (0.572, 0.62, 0.66):
    CASES[f"0039 + dump plenum, R {_R}"] = (DUMP, ["plenum_n_cells=160", "restrictor_inertance=400", f"restrictor_diffuser_efficiency={_R / (1 - (0.020 / 0.038) ** 4):.5f}"])
ONLY = [n for n in CASES if "dump" in n] if "--dump" in sys.argv else list(CASES)
def run(job):
    name, rpm = job; cfg, extra = CASES[name]
    p = subprocess.Popen([EXE, cfg, str(rpm), "20", *extra], stdout=subprocess.PIPE, text=True); unthrottle(p.pid)
    x = pd.read_csv(io.StringIO(p.communicate()[0]))
    return dict(case=name, rpm=rpm, mdot_g_s=1000 * x.mdot_restrictor_kg_s.mean(), drop_exit=(97300 - x.p_plenum_exit_Pa.mean()) / 1e3, drop_map=(97300 - x.p_plenum_map_Pa.mean()) / 1e3,
                drop_mean=(97300 - x.p_plenum_mean_Pa.mean()) / 1e3, car=CAR[rpm])
if __name__ == "__main__":
    with ThreadPoolExecutor(3) as ex: R = list(ex.map(run, [(n, r) for n in ONLY for r in CAR]))
    old = [x for x in (json.load(open(OUT)) if os.path.exists(OUT) else []) if x["case"] not in ONLY]; R = old + R
    json.dump(R, open(OUT, "w"), indent=1); T = pd.DataFrame(R); T["recovered_in_plenum"] = T.drop_exit - T.drop_map; T["map_minus_car"] = T.drop_map - T.car
    pd.set_option("display.width", 220); print(T.round(2).to_string(index=False))
