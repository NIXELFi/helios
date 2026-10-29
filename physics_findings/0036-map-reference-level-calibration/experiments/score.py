import os, sys
os.environ["RUNS_0035"] = os.path.abspath("runs")
sys.path.insert(0, "C:/Users/nick5/helios-exp-damping/physics_findings/0035-collector-merge-lambda-lag/scripts")
from lib import *
MV = pd.read_csv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "exp1", "ve_map_reference.csv")).set_index("bin").ve_map.reindex(GRID)
def nm(s): s = s.reindex(GRID); return s / s.mean()
def inphase(model, car):
    j = pd.concat([nm(model), nm(car)], axis=1).loc[5500:10000].dropna()
    return np.polyfit(j.iloc[:, 1] - 1, j.iloc[:, 0] - 1, 1)[0]
def score(n):
    m = load(n); v = m.ve_del
    r = dict(variant=n, n=len(m), std=nm(v).loc[5500:10000].std(),
             r_wot=corr(v.reindex(GRID), PW), slope_wot=inphase(v, PW),
             r_map=corr(v.reindex(GRID), MV), slope_map=inphase(v, MV),
             depth=depth(v), pk6=int(v.loc[5500:7000].idxmax()), tr78=int(v.loc[7000:8500].idxmin()), pk9=int(v.loc[8500:10000].idxmax()),
             ve_mean=v.reindex(GRID).mean())
    j = dy.join(m[["P_kW"]], how="inner"); dP = j.P_kW * 0.85 - j.brake_power_kW
    for lab, lo, hi in [("6-10.5", 6000, 10500), ("6-8.5", 6000, 8500), ("7-10.5", 7000, 10500)]:
        r[f"rmse{lab}"] = np.sqrt((dP.loc[lo:hi] ** 2).mean())
    r["bias"] = dP.loc[6000:10500].mean()
    return r
names = [d for d in os.listdir("runs") if sum(f[0].isdigit() for f in os.listdir("runs/" + d)) >= 28]
order = ["base", "fric0", "fric05", "fric2", "heat0", "heat2", "fh0", "heatEx0", "heatIn0", "superbee", "weno5", "cfl03", "grid2x"]
T = pd.DataFrame([score(n) for n in order if n in names]).set_index("variant")
pd.set_option("display.width", 250); pd.set_option("display.max_columns", 30)
car = dict(std_wot=nm(PW).loc[5500:10000].std(), std_map=nm(MV).loc[5500:10000].std(), depth_map=depth(MV.reindex(GRID).rename(None)) if True else None)
print(T.round(3).to_string()); print("car:", {k: round(v, 3) for k, v in car.items()})
T.round(4).to_csv("damping_audit.csv")
