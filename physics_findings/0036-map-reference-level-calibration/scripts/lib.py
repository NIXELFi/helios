import os, sys, json, glob, subprocess
import numpy as np, pandas as pd
from concurrent.futures import ThreadPoolExecutor
# Repo-relative. Build the driver (huntexp_main.rs, a tiny crate depending on
# engine-sim + cfd-core; see ../../0033-sdm26-asbuilt-intake) and point HUNTEXP at it.
H = os.path.dirname(os.path.abspath(__file__))
PF = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
CFG = os.path.normpath(os.path.join(PF, "..", "apps", "desktop", "src-tauri", "resources", "cfd", "configs")).replace("\\", "/")
EXE = os.environ.get("HUNTEXP", "huntexp")
RUNS = os.environ.get("RUNS_0035", os.path.join(H, "runs"))
GRID = np.arange(4000, 10751, 250)
RPMS = sorted(set(list(range(4000, 12501, 250)) + list(range(5000, 10001, 100))))
P = pd.read_csv(PF + "/references/ecu/proxy_lag270.csv").set_index("bin").iloc[:, 0].reindex(GRID)
P12 = pd.read_csv(PF + "/references/ecu/proxy_lag120.csv").set_index("bin").iloc[:, 0].reindex(GRID)
dy = pd.read_csv(PF + "/references/dyno/sdm26-team-dyno.csv").set_index("rpm")
PW = pd.read_csv(PF + "/references/ecu/proxy_wotA.csv").set_index("bin").ve.reindex(GRID)   # 0035: WOT-measured lambda lag
dyno_g = dy.brake_torque_Nm.reindex(dy.index.union(GRID)).interpolate("index").reindex(GRID); dyno_g[GRID < 4500] = np.nan

def corr(a, b):
    j = pd.concat([a, b], axis=1).dropna()
    return np.corrcoef(j.iloc[:, 0] / j.iloc[:, 0].mean(), j.iloc[:, 1] / j.iloc[:, 1].mean())[0, 1]

def run_variant(name, cfg, extra=(), rpms=RPMS, cycles=30, threads=15):
    d = f"{RUNS}/{name}"; os.makedirs(d, exist_ok=True)
    json.dump({"cfg": cfg, "extra": list(extra)}, open(d + "/_meta.json", "w"))
    def one(rpm):
        out = f"{d}/{rpm}.json"
        if os.path.exists(out) and os.path.getsize(out) > 10: return
        r = subprocess.run([EXE, cfg, str(rpm), str(rpm), "250", str(cycles), *extra], capture_output=True, text=True)
        if not r.stdout.strip(): print(name, rpm, "FAILED", r.stderr[-400:], flush=True)
        open(out, "w").write(r.stdout)
    with ThreadPoolExecutor(threads) as ex: list(ex.map(one, rpms))

def load(name):
    if name.startswith("rows:"):  # committed model_rows.csv  rows:<finding>/<variant>
        f, v = name[5:].split("/")
        m = pd.read_csv(f"{PF}/{f}/model_rows.csv"); m = m[m.variant == v].set_index("rpm").sort_index()
    else:
        rows = [json.loads(open(f).read()) for f in glob.glob(f"{RUNS}/{name}/[0-9]*.json") if open(f).read().strip()]
        m = pd.DataFrame(rows).set_index("rpm").sort_index()
    m.index = m.index.astype(int); m["P_kW"] = m.bt * m.index * 2 * np.pi / 60 / 1000
    return m

def depth(ve):
    n = ve / ve.reindex(GRID).mean()
    return n.loc[7300:8200].min() - 0.5 * (n.loc[6000:6600].max() + n.loc[8600:9400].max())

def analyze(name, label=None):
    m = load(name); g = m.ve_del.reindex(GRID); fine = m.ve_del.loc[5000:10000]
    r = dict(variant=label or name, n=len(m), r270=corr(g, P), r120=corr(g, P12), rWOT=corr(g, PW), rT=corr(m.bt.reindex(GRID), dyno_g),
             pk6=int(fine.loc[5500:7000].idxmax()), tr78=int(fine.loc[7000:8500].idxmin()), pk9=int(fine.loc[8500:10000].idxmax()),
             depth=depth(m.ve_del), ve_mean=g.mean())
    j = dy.join(m[["P_kW"]], how="inner"); dP = j.P_kW * 0.85 - j.brake_power_kW
    for lab, lo, hi in [("6-12.5", 6000, 12500), ("6-8.5", 6000, 8500), ("7-11.5", 7000, 11500), ("10.5-12.5", 10500, 12500)]:
        r[f"rmse{lab}"] = np.sqrt((dP.loc[lo:hi] ** 2).mean())
    r["bias"] = dP.loc[6000:12500].mean()
    s = dP.loc[6000:12500]; r["rmse_debiased6-12.5"] = np.sqrt(((s - s.mean()) ** 2).mean())
    return r

def table(names):
    T = pd.DataFrame([analyze(n) if isinstance(n, str) else analyze(*n) for n in names]).set_index("variant")
    pd.set_option("display.width", 250); pd.set_option("display.max_columns", 30)
    return T.round(3)

# ---- exp5: MAP-VE target (exp1) + car intake pressure drop -------------------
_mc = pd.read_csv(H + "/../experiments/ve_map_compare.csv", index_col=0)
MV = _mc.ve_map.reindex(GRID); CAR_DP = _mc.car_dp.reindex(GRID)   # kPa, baro 97.3
RPMS5 = list(range(4000, 10751, 250)) + [11000, 11500, 12000, 12500]

def analyze5(name, p_amb=101325.0):
    m = load(name); g = m.ve_del.reindex(GRID)
    gn = g / g.mean(); mv = MV / MV.mean()
    w = pd.concat([gn, mv], axis=1).dropna().loc[5500:10000]
    slope = np.polyfit(w.iloc[:, 1] - 1, w.iloc[:, 0] - 1, 1)[0]
    dp = (p_amb - m.p_plenum.reindex(GRID)) / 1000
    r = dict(variant=name, rMAP=corr(g, MV), slopeMAP=slope, rWOT=corr(g, PW), rT=corr(m.bt.reindex(GRID), dyno_g),
             depth=depth(m.ve_del), pk6=int(m.ve_del.loc[5500:7000].idxmax()), pk9=int(m.ve_del.loc[8250:10000].idxmax()),
             dp7=dp.loc[7000], dp9=dp.loc[9000], dp10=dp.loc[10000], dp_rmse=np.sqrt(((dp - CAR_DP) ** 2).mean()),
             ve_abs_8k=m.ve_del.loc[8000])
    j = dy.join(m[["P_kW"]], how="inner"); dP = j.P_kW * 0.85 - j.brake_power_kW
    for lab, lo, hi in [("6-12.5", 6000, 12500), ("6-8.5", 6000, 8500), ("7-11.5", 7000, 11500), ("10.5-12.5", 10500, 12500)]:
        r[f"rmse{lab}"] = np.sqrt((dP.loc[lo:hi] ** 2).mean())
    r["bias"] = dP.loc[6000:12500].mean()
    s = dP.loc[6000:12500]; r["rmse_debiased6-12.5"] = np.sqrt(((s - s.mean()) ** 2).mean())
    return r
