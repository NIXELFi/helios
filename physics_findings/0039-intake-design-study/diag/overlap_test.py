"""Is the 1D model's high exhaust pressure during overlap what holds its airflow down?
Fluent: 3D exhaust port sits near 100 kPa through overlap (1D: 136-148 kPa), and its 3D intake + 0D cylinder run is heading for
15-20 % more air than the 1D at 8500 rpm. Test: give the 1D engine an exhaust that holds the port near ambient at every speed
(primaries cut to the head port + 20 mm, discharging into 300 mm 'secondaries' and final pipe: a reservoir), with the car-fitted
restrictor (Cd 0.95, R 0.572) and with the clean-wall CFD restrictor (Cd 0.965, R 0.692). All-measured car, dump plenum."""
import os; os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
import io, json, subprocess, sys, numpy as np, pandas as pd
from concurrent.futures import ThreadPoolExecutor
H = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, H)
import study
from nothrottle import unthrottle
REL = os.path.join(H, "driver", "target", "release"); B = ["plenum_n_cells=160", "restrictor_inertance=400"]
CAR = {7000: 3.24, 8000: 4.60, 8500: np.nan, 9000: 6.51, 9500: 7.38, 10000: 7.85}
base = json.load(open(os.path.join(H, "cfg", "PRIMARY_p125.json")))
def variant(name, open_exh=False, clean=False):
    d = json.loads(json.dumps(base))
    if open_exh:
        for p in d["exhaust_primaries"]: p.update(length=0.085, n_points=10, diameter=0.02765, diameter_out=0.02975, diameter_profile=[[0.0, 0.02765], [0.065, 0.02975], [0.085, 0.02975]])
        for p in d["exhaust_secondaries"]: p.update(diameter=0.30, diameter_out=0.30, diameter_profile=[[0.0, 0.30], [p["length"], 0.30]])
        c = d["exhaust_collector"]; c.update(diameter=0.30, diameter_out=0.30, diameter_profile=[[0.0, 0.30], [c["length"], 0.30]])
    if clean: d["restrictor"]["discharge_coefficient"] = 0.965; d["physics"]["restrictor_diffuser_efficiency"] = round(0.692 / (1 - (0.020 / 0.038) ** 4), 5)
    f = os.path.join(H, "cfg", f"DIAG_overlap_{name}.json"); json.dump(d, open(f, "w"), indent=1); return f
CASES = {"car exhaust, R 0.572": variant("a"), "ambient exhaust, R 0.572": variant("b", open_exh=True), "car exhaust, R 0.692": variant("c", clean=True), "ambient exhaust, R 0.692": variant("d", open_exh=True, clean=True)}
def run(job):
    n, rpm = job; out = []
    for exe, extra in (("exhwave.exe", []), ("intakewave.exe", ["runner_mouth_extension=0.0000"]), ("intakepoint.exe", ["runner_mouth_extension=0.0000"])):
        p = subprocess.Popen([os.path.join(REL, exe), CASES[n], str(rpm), "20", *B, *extra], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True); unthrottle(p.pid); out.append(p.communicate()[0])
    x = pd.read_csv(io.StringIO(out[0])); w = pd.read_csv(io.StringIO(out[1])); e = json.loads(out[2].strip().splitlines()[-1]); ov = []; ivo = []
    for i in range(1, 5):
        ph = x[f"phase{i}_deg"]; ov.append(x[f"p_port{i}_Pa"][(ph >= 322) & (ph <= 365)].mean() / 1e3); ivo.append(x[f"p_cyl{i}_Pa"][(ph >= 320) & (ph <= 324)].mean() / 1e3)
    return dict(case=n, rpm=rpm, overlap_kPa=np.mean(ov), p_cyl_ivo_kPa=np.mean(ivo), f_res=np.mean([x[f"f_res_ivc{i}"].iloc[-1] for i in range(1, 5)]), ve=e["ve"], mdot_g_s=1000 * w.mdot_restrictor_kg_s.mean(),
                map_drop_kPa=(97300 - w.p_plenum_map_Pa.mean()) / 1e3, car_drop=CAR[rpm], bt=e["bt"])
if __name__ == "__main__":
    with ThreadPoolExecutor(study.THREADS // 3 or 1) as ex: T = pd.DataFrame(list(ex.map(run, [(n, r) for n in CASES for r in CAR])))
    T.round(4).to_csv(os.path.join(H, "diag", "overlap_test.csv"), index=False); pd.set_option("display.width", 220); print(T.round(2).to_string(index=False))
    b = T[T.case == "car exhaust, R 0.572"].set_index("rpm")
    for n in list(CASES)[1:]:
        t = T[T.case == n].set_index("rpm"); print(n, "vs car exhaust R 0.572:  airflow %", ((t.mdot_g_s / b.mdot_g_s - 1) * 100).round(1).to_dict(), " torque %", ((t.bt / b.bt - 1) * 100).round(1).to_dict())
