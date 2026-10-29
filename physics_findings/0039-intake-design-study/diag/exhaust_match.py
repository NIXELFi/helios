"""Which 1D exhaust setting reproduces Fluent's 3D station histories (p125, 9000 rpm, cylinder behind each valve)?
Scores each variant by the rms pressure difference against the 3D over cylinder 1's whole cycle at seven stations, and by the
overlap state at the valve. Variants change gas temperature (wall temperatures) and how open the merges are (the trunk that follows
each 2-into-1 merge starts at 51.05 mm = two pipe areas in the model; a jet that does not spread sees less)."""
import os; os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
import io, json, subprocess, sys, numpy as np, pandas as pd
from concurrent.futures import ThreadPoolExecutor
H = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, H)
import study
from nothrottle import unthrottle
REL = os.path.join(H, "driver", "target", "release"); B = ["plenum_n_cells=160", "restrictor_inertance=400"]
F3D = sys.argv[sys.argv.index("--ref") + 1] if "--ref" in sys.argv else r"C:\Users\nick5\restrictor_opt\data\exhaust\stations_3d_cyl_p125_cycle4_9000rpm.csv"
ref = pd.read_csv(F3D, comment="#"); ref["th"] = ref.theta_deg.round().astype(int) % 720; ref = ref.drop_duplicates("th").set_index("th").sort_index()
ST = ["pri1_start", "pri1_mid", "pri1_end", "sec1_mid", "sec1_end", "final_start", "final_mid"]; base = json.load(open(os.path.join(H, "cfg", "PRIMARY_p125.json")))
HOT = ["primary_wall_t=1100", "secondary_wall_t=1050", "collector_wall_t=1000"]
def cfg(name, trunk=None, ftrunk=None, fine=1):
    d = json.loads(json.dumps(base))
    if fine != 1:                                              # exhaust grid refinement (cells per pipe x fine)
        for p in d["exhaust_primaries"] + d["exhaust_secondaries"] + [d["exhaust_collector"]]: p["n_points"] = int(round(p["n_points"] * fine))
    if trunk:
        for p in d["exhaust_secondaries"]: p["diameter_profile"][0][1] = trunk; p["diameter"] = trunk
    if ftrunk: d["exhaust_collector"]["diameter_profile"][0][1] = ftrunk; d["exhaust_collector"]["diameter"] = ftrunk
    f = os.path.join(H, "cfg", f"DIAG_exh_{name}.json"); json.dump(d, open(f, "w"), indent=1); return f
V = {"as modelled": (cfg("a"), []), "hot walls": (cfg("a"), HOT), "trunk 44 mm": (cfg("t44", 0.044), []), "trunk 36.1 mm (no spread)": (cfg("t36", 0.0361), []),
     "hot + trunk 44": (cfg("t44", 0.044), HOT), "hot + trunk 36.1": (cfg("t36", 0.0361), HOT), "hot + both trunks 44": (cfg("t44f44", 0.044, 0.044), HOT),
     "hot + both trunks 36.1": (cfg("t36f36", 0.0361, 0.0361), HOT), "hot + trunk 36.1, momentum off": (cfg("t36", 0.0361), HOT + ["exhaust_junction_momentum=0"]),
     "hot + trunk 36.1, exhaust grid x2": (cfg("t36x2", 0.0361, None, 2), HOT), "hot + trunk 36.1, exhaust grid x4": (cfg("t36x4", 0.0361, None, 4), HOT),
     "as modelled, exhaust grid x2": (cfg("ax2", None, None, 2), []), "as modelled, exhaust grid x4": (cfg("ax4", None, None, 4), []),
     "no heat loss + both trunks 36.1": (cfg("t36f36", 0.0361, 0.0361), ["exhaust_heat_transfer_multiplier=0.0"])}
def run(n):
    c, ex = V[n]; out = []
    for exe, e2 in (("exhstations.exe", []), ("intakepoint.exe", ["runner_mouth_extension=0.0000"])):
        p = subprocess.Popen([os.path.join(REL, exe), c, "9000", "20", *B, *ex, *e2], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True); unthrottle(p.pid); out.append(p.communicate()[0])
    x = pd.read_csv(io.StringIO(out[0])); x["th"] = x.theta_deg.round().astype(int) % 720; x = x.drop_duplicates("th").set_index("th").sort_index(); e = json.loads(out[1].strip().splitlines()[-1])
    r = dict(variant=n); v = x.pri1_start_p / 1e3
    for s in ST: r["rms_" + s] = float(np.sqrt(np.mean(((x[s + "_p"] - ref[s + "_p"]).dropna() / 1e3) ** 2)))
    r["rms_all"] = float(np.sqrt(np.mean([r["rms_" + s] ** 2 for s in ST])))
    r.update(overlap_mean=v.loc[322:365].mean(), at_365=v.loc[365], blowdown=v.loc[165:260].max(), pri_end_peak=(x.pri1_end_p.loc[180:250] / 1e3).max(), pri_end_peak_deg=x.pri1_end_p.loc[180:250].idxmax(),
             step_deg=(v.loc[110:180].diff(5)).idxmax() - 2, T_sec=x.sec1_mid_T.mean(), ve=e["ve"], bt=e["bt"]); return r
if __name__ == "__main__":
    names = [n for n in V if "--only" not in sys.argv or sys.argv[sys.argv.index("--only") + 1] in n]
    with ThreadPoolExecutor(study.THREADS // 2) as ex: T = pd.DataFrame(list(ex.map(run, names)))
    v3 = ref.pri1_start_p / 1e3; print("3D: overlap mean %.0f, at 365 %.0f, blowdown %.0f, pri end peak %.0f at %d, step at %d, T sec mid %.0f" % (v3.loc[322:365].mean(), v3.loc[365], v3.loc[165:260].max(),
          (ref.pri1_end_p.loc[180:250] / 1e3).max(), ref.pri1_end_p.loc[180:250].idxmax(), (v3.loc[110:180].diff(5)).idxmax() - 2, ref.sec1_mid_T.mean()))
    pd.set_option("display.width", 280); print(T.round(1).to_string(index=False)); T.round(3).to_csv(os.path.join(H, "diag", "exhaust_match.csv" if "--only" not in sys.argv else "exhaust_match_grid.csv"), index=False)
