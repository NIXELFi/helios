"""1D exhaust against Fluent's 3D station histories (p125, 9000 rpm, real valves), stations matched by DISTANCE from the valve.

Fluent's wall-mesh cut: at each 2-into-1 collector the two 36.10 mm legs run alone for 30.2 mm and then open into each other
(the crotch, 2.06 pipe areas); the passage contracts to ONE pipe area over the next 75.6 mm (the merge point) and stays 36.10 mm.
The 0034 / as-measured layout put the junction at the merge point (481 mm) and the contraction after it. Geometry "crotch" moves
the junction 75.6 mm upstream at both merges: primaries 407.6 mm, secondaries unchanged in length (crotch to crotch, contraction
in the first 75.6 mm), final pipe 75.6 mm longer with a 50.7 mm neck. Total path unchanged."""
import os; os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
import io, json, math, subprocess, sys, numpy as np, pandas as pd
from concurrent.futures import ThreadPoolExecutor
H = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, H)
import study
from nothrottle import unthrottle
REL = os.path.join(H, "driver", "target", "release"); B = ["plenum_n_cells=160", "restrictor_inertance=400"]; RPM = 9000
ref = pd.read_csv(r"C:\Users\nick5\restrictor_opt\data\exhaust\stations_3d_cyl_p125_9000rpm.csv", comment="#"); ref["th"] = ref.theta_deg.round().astype(int) % 720; ref = ref.drop_duplicates("th").set_index("th").sort_index()
MAP = {"pri1_start": "c1_5", "pri1_mid": "c1_242", "pri1_end": "c1_464", "sec1_start": "c1_504", "sec1_mid": "c1_770", "sec1_end": "c1_1037", "final_start": "c1_1077", "final_mid": "c1_1389", "pri4_start": "c4_5", "pri4_mid": "c4_242"}
DIST = "5,242,464,504,770,1037,1077,1389,1701"; base = json.load(open(os.path.join(H, "cfg", "PRIMARY_p125.json"))); D1 = 0.0361
AR = [(75.6, 2.06), (70, 2.06), (60, 2.05), (50, 1.79), (40, 1.51), (30, 1.29), (20, 1.13), (10, 1.03), (0, 1.00)]          # mm before the merge point, area / pipe area
CONTR = [[round((75.6 - d) / 1000, 5), round(D1 * math.sqrt(a), 5)] for d, a in AR]
HOT = ["primary_wall_t=1100", "secondary_wall_t=1050", "collector_wall_t=1000"]
def cfg(name, crotch=False, lin=False, port=0.02765):
    d = json.loads(json.dumps(base))
    if crotch:
        con = [[0.0, round(D1 * math.sqrt(2.0), 5)], [0.0756, D1]] if lin else CONTR
        for p in d["exhaust_primaries"]: p.update(length=0.4076, n_points=45, diameter_out=D1, diameter=port, diameter_profile=[[0.0, port], [0.065, 0.02975], [0.3674, 0.02975], [0.3774, D1], [0.4076, D1]])
        for p in d["exhaust_secondaries"]: p.update(diameter=con[0][1], diameter_out=D1, diameter_profile=con + [[0.5764, D1]])
        d["exhaust_collector"].update(length=0.7403, n_points=82, diameter=con[0][1], diameter_out=0.0488, diameter_profile=con + [[0.1263, D1], [0.1795, 0.0481], [0.198, 0.0488], [0.7403, 0.0488]])
    f = os.path.join(H, "cfg", f"DIAG_exh2_{name}.json"); json.dump(d, open(f, "w"), indent=1); return f
V = {"as modelled": (cfg("a"), []), "as modelled, hot walls": (cfg("a"), HOT), "crotch geometry": (cfg("c", True), []), "crotch geometry, hot walls": (cfg("c", True), HOT),
     "crotch geometry (linear contraction), hot walls": (cfg("cl", True, True), HOT), "crotch geometry, no wall heat loss": (cfg("c", True), ["exhaust_heat_transfer_multiplier=0.0"]),
     "crotch geometry, hot walls, port 29.75 mm": (cfg("cp", True, False, 0.02975), HOT),
     "crotch geometry, hot walls, merge angle 28 deg": (cfg("c", True), HOT + ["exhaust_merge_angle_deg=28"]),
     "crotch geometry, walls 1000/900/800": (cfg("c", True), ["primary_wall_t=1000", "secondary_wall_t=900", "collector_wall_t=800"]),
     "crotch geometry, hot walls, momentum off": (cfg("c", True), HOT + ["exhaust_junction_momentum=0"])}
def run(n):
    c, ex = V[n]; out = []
    for exe, pre, e2 in (("exhpath.exe", [DIST], []), ("intakepoint.exe", [], ["runner_mouth_extension=0.0000"])):
        p = subprocess.Popen([os.path.join(REL, exe), c, str(RPM), "20", *pre, *B, *ex, *e2], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True); unthrottle(p.pid); out.append(p.communicate()[0])
    x = pd.read_csv(io.StringIO(out[0])); x["th"] = x.theta_deg.round().astype(int) % 720; x = x.drop_duplicates("th").set_index("th").sort_index(); e = json.loads(out[1].strip().splitlines()[-1])
    x.to_csv(os.path.join(H, "diag", "exhaust_match2_" + "".join(ch if ch.isalnum() else "_" for ch in n) + ".csv")); r = dict(variant=n); v = x.c1_5_p / 1e3
    for s, c1 in MAP.items(): r["rms_" + s] = float(np.sqrt(np.mean(((x[c1 + "_p"] - ref[s + "_p"]).dropna() / 1e3) ** 2)))
    r["rms_all"] = float(np.sqrt(np.mean([r["rms_" + s] ** 2 for s in MAP])))
    r.update(overlap_mean=v.loc[322:365].mean(), at_322=v.loc[322], at_365=v.loc[365], blowdown=v.loc[165:260].max(), blowdown_deg=v.loc[165:260].idxmax(), step_deg=(v.loc[110:180].diff(5)).idxmax() - 2,
             pe_peak=(x.c1_464_p.loc[180:250] / 1e3).max(), pe_deg=x.c1_464_p.loc[180:250].idxmax(), partner_peak=(x.c4_5_p.loc[200:290] / 1e3).max(), partner_deg=x.c4_5_p.loc[200:290].idxmax(),
             hump_valve=v.loc[290:350].max(), hump_deg=v.loc[290:350].idxmax(), T_sec=x.c1_770_T.mean(), ve=e["ve"], bt=e["bt"]); return r
if __name__ == "__main__":
    names = [n for n in V if "--only" not in sys.argv or any(k in n for k in sys.argv[sys.argv.index("--only") + 1].split("|"))]
    with ThreadPoolExecutor(study.THREADS // 2) as ex: T = pd.DataFrame(list(ex.map(run, names)))
    v3 = ref.pri1_start_p / 1e3
    print("3D: overlap mean %.0f (%.0f at 322, %.0f at 365), blowdown %.0f at %d, step at %d, pri end (464 mm) peak %.0f at %d, partner valve peak %.0f at %d, hump at valve %.0f at %d, T sec mid %.0f" % (
        v3.loc[322:365].mean(), v3.loc[322], v3.loc[365], v3.loc[165:260].max(), v3.loc[165:260].idxmax(), (v3.loc[110:180].diff(5)).idxmax() - 2, (ref.pri1_end_p.loc[180:250] / 1e3).max(), ref.pri1_end_p.loc[180:250].idxmax(),
        (ref.pri4_start_p.loc[200:290] / 1e3).max(), ref.pri4_start_p.loc[200:290].idxmax(), v3.loc[290:350].max(), v3.loc[290:350].idxmax(), ref.sec1_mid_T.mean()))
    pd.set_option("display.width", 320); c = ["variant", "rms_all", "rms_pri1_start", "rms_pri1_end", "rms_sec1_mid", "rms_final_start", "overlap_mean", "at_322", "at_365", "blowdown", "blowdown_deg", "step_deg", "pe_peak", "pe_deg", "partner_peak", "partner_deg", "hump_valve", "hump_deg", "T_sec", "ve", "bt"]
    print(T[c].round(1).to_string(index=False)); T.round(3).to_csv(os.path.join(H, "diag", "exhaust_match2.csv" if "--only" not in sys.argv else "exhaust_match2_more.csv"), index=False)
