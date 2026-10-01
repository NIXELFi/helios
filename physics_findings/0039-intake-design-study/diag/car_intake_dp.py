"""The car's intake pressure drop, self-referenced: (engine-off MAP in the same session) - (MAP at WOT), vs rpm.
0036 fitted the venturi's recovery to baro - MAP with baro ASSUMED 97.3 kPa (not logged). Josh AX 4-26 (G4X, 0.1 kPa)."""
import glob, os, sys, json, math, numpy as np, pandas as pd
H = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, H)
import fluent_ingest as fi
rows = []; refs = {}
for f in sorted(glob.glob(os.path.join(H, "data", "josh_raw", "SDM26 Josh Autocross *.csv"))):
    x = pd.read_csv(f, skiprows=[0, 2], low_memory=False)[["Section Time", "Engine Speed", "TPS (Main)", "MAP", "ECT", "% Fuel Cut", "% Ignition Cut"]]
    x.columns = ["t", "rpm", "tps", "map", "ect", "fc", "ic"]
    off = x[x.rpm == 0]; ref = off["map"].median(); refs[os.path.basename(f)[6:-4]] = (ref, off["map"].min(), off["map"].max(), len(off))
    # sustained WOT: TPS >= 95 for the last 0.25 s (50 samples at 200 Hz), no cuts, and rpm not changing faster than 4000 rpm/s
    wot = (x.tps.rolling(50, min_periods=50).min() >= 95) & (x.fc == 0) & (x.ic == 0)
    dr = x.rpm.diff(20) / (x.t.diff(20))
    y = x[wot & (dr.abs() < 6000) & (x.rpm >= 4000)]
    rows.append(pd.DataFrame(dict(rpm=y.rpm, dp=ref - y["map"], drdt=dr[y.index])))
D = pd.concat(rows)
print("engine-off MAP per session (kPa): ", {k: (round(v[0], 1), round(v[1], 1), round(v[2], 1), v[3]) for k, v in refs.items()})
D["bin"] = (D.rpm / 500).round() * 500
C = D.groupby("bin").dp.agg(["mean", "std", "count"]); C = C[C["count"] >= 60]
# model airflow at each rpm (as-built direct runs)
N = pd.DataFrame([json.loads(l) for l in open(os.path.join(H, "newintake.ndjson"))]); b = N[N.case == "base"].groupby("rpm").ve.mean()
cfg = json.load(open(os.path.join(H, "cfg", "V1.44_L1.00_D38_A3.2.json"))); cyl = cfg["cylinder"]; Vd = math.pi / 4 * cyl["bore"] ** 2 * cyl["stroke"] * 4
def dp_model(rpm, p0, cd, R, K=0.0):
    ve = float(np.interp(rpm, b.index, b.values)); rho = 97300 / (287 * 305.0); m = ve * rho * Vd * rpm / 120
    q32 = 0.5 * (m / (rho * math.pi / 4 * 0.032 ** 2)) ** 2 * rho; p_in = p0 - K * q32          # upstream loss lowers the venturi's inlet total pressure
    pr = np.linspace(0.6, 0.9999, 6000); mm = fi.venturi_mdot(pr, cd, R) * (p_in / fi.P0)
    return (p0 - float(np.interp(m, mm[::-1], pr[::-1])) * p_in) / 1000, m
print(f"{'rpm':>6} {'n':>5} {'car dp kPa':>10} {'+-':>5} | {'mdot g/s':>8} | {'1D fit 0.95/0.572':>17} | {'CFD A_CAD 0.965/0.692':>21} | {'CFD + K 0.19':>12} | {'CFD + K 0.4':>11} | implied R (Cd 0.965, K 0.19)")
for rpm, r in C.iterrows():
    a, m = dp_model(rpm, 97300, 0.95, 0.572); c0, _ = dp_model(rpm, 97300, 0.965, 0.692); c1, _ = dp_model(rpm, 97300, 0.965, 0.692, 0.19); c2, _ = dp_model(rpm, 97300, 0.965, 0.692, 0.4)
    Rs = np.linspace(0.2, 0.9, 141); imp = Rs[int(np.argmin([abs(dp_model(rpm, 97300, 0.965, R_, 0.19)[0] - r["mean"]) for R_ in Rs]))]
    print(f"{rpm:6.0f} {int(r['count']):5d} {r['mean']:10.2f} {r['std']:5.2f} | {m*1000:8.1f} | {a:17.2f} | {c0:21.2f} | {c1:12.2f} | {c2:11.2f} | {imp:.2f}")
