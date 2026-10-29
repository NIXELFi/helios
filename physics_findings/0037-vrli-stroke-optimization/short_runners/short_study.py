"""Shorter-runner experiment on the extended 0037 surface (E_short: extension -200..+160 mm)."""
import os, glob, numpy as np, pandas as pd
os.environ["VRLI_SURF"] = r"C:\Users\nick5\helios-vrli\physics_findings\0037-vrli-stroke-optimization\out\E_short\surface.csv"
s = pd.read_csv(os.environ["VRLI_SURF"]); conv = s.groupby("ext_mm").converged.all()
ok_ext = conv[conv].index.values; os.environ["VRLI_EXT_MIN"] = str(float(min(ok_ext)))
print("converged extensions:", ok_ext.min(), "..", ok_ext.max(), " unconverged:", conv[~conv].index.tolist())
import vrli_control as vc
from vrli_control import Design, run_lap, torque, BASE
# (a) fixed runner length sweep: P1 (6-12k mean torque) and driver band vs as-built
rows = []
for e in sorted(ok_ext):
    r1 = np.arange(6000, 12001, 250); r2 = np.arange(7000, 10501, 250)
    p1 = np.mean([torque(e, r) for r in r1]) / np.mean([torque(0, r) for r in r1]) - 1
    dr = np.mean([torque(e, r) for r in r2]) / np.mean([torque(0, r) for r in r2]) - 1
    rows.append(dict(ext=e, runner=BASE + e, P1=p1 * 100, driver=dr * 100))
F = pd.DataFrame(rows); print("\nFIXED runner length (dyno-style average vs as-built):"); print(F.round(2).to_string(index=False))
F.to_csv("short_fixed.csv", index=False)
# (b) lap-based, new controller, 10 clean shared laps, designs with long end <= +40
rk = pd.read_csv("shared_ranked.csv"); clean = rk[(rk.cones == 0) & (rk.off == 0) & (rk.assists == 0) & (rk.in_model >= 0.8)].sort_values("raw").head(10)
laps = []
for _, row in clean.iterrows():
    f = glob.glob(os.path.join("shared", f"*{row.file}.csv.gz"))[0]
    x = pd.read_csv(f, usecols=["time_s", "engine.rpm", "engine.tps", "sim.lap"]); x = x[x["sim.lap"] == row.lap]
    laps.append((x.time_s.values, x["engine.rpm"].values, x["engine.tps"].values))
res = []
for long_mm in (40, 20, 0, -20, -40, -60, -80):
    for stroke in (0, 50, 75, 100, 125):
        lo = long_mm - stroke
        if lo < float(os.environ["VRLI_EXT_MIN"]): continue
        d = Design(long_mm=long_mm, stroke_mm=max(stroke, 1e-6))
        m = np.mean([run_lap(*L, d, "smooth")["mean"] for L in laps])
        res.append(dict(long_end=BASE + long_mm, short_end=BASE + lo, stroke=stroke, lap_gain=m * 100))
R = pd.DataFrame(res); R.to_csv("short_designs.csv", index=False)
print("\nLAP-BASED (new controller, 10 clean shared AX laps, on-throttle torque vs as-built):")
print(R.pivot(index="long_end", columns="stroke", values="lap_gain").round(2).sort_index(ascending=False).to_string())
