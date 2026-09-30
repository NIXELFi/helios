# Drivetrain-efficiency refit + linearity test (finding 0036 follow-up).
# Brake power: A_e94 = sdm26_asbuilt_cal physics with the SHIPPED level (eta_comb 0.94, FMEP x1.0).
import os, sys, numpy as np, pandas as pd
import lib   # scripts/lib.py (RUNS_0035 must hold the A_e94 run)
m = lib.load("A_e94")                                   # rpm-indexed; P_kW = brake
dy = lib.dy
raw = pd.read_csv(os.environ.get("SDM_DYNO_RAW", "SDM.CSV"), skiprows=[1], usecols=[0, 1, 2])  # raw Dynojet export, see references/dyno/README.md; raw.columns = ["rpm", "hp", "lbft"]
raw = raw.apply(pd.to_numeric, errors="coerce").dropna(); raw["P"] = raw.hp * 0.745699872
def brake_at(rpm): return np.interp(rpm, m.index.values, m.P_kW.values)
MODELS = {
  "L1  wheel = eta*Pb":                      lambda Pb, w: np.c_[Pb],
  "L2  eta*Pb - c1*w (const loss torque)":   lambda Pb, w: np.c_[Pb, -w],
  "L3  eta*Pb - c2*w^2":                     lambda Pb, w: np.c_[Pb, -w**2],
  "L4  eta*Pb - c0 (const loss power)":      lambda Pb, w: np.c_[Pb, -np.ones_like(w)],
  "L5  eta*Pb - c1*w - c2*w^2":              lambda Pb, w: np.c_[Pb, -w, -w**2],
  "L6  eta*Pb - c3*w^3 (windage-like)":      lambda Pb, w: np.c_[Pb, -w**3],
}
def fit(X, y):
    b, *_ = np.linalg.lstsq(X, y, rcond=None); return b
def evaluate(rpm, y):
    Pb = brake_at(rpm); w = rpm * 2 * np.pi / 60 / 1000   # w in krad/s for conditioning
    out = []
    for name, f in MODELS.items():
        X = f(Pb, w); b = fit(X, y); r = y - X @ b; n, k = len(y), X.shape[1]
        loo = np.array([y[i] - X[i] @ fit(np.delete(X, i, 0), np.delete(y, i)) for i in range(n)])
        rss = (r ** 2).sum(); bic = n * np.log(rss / n) + k * np.log(n)
        eff = (X @ b) / Pb   # implied wheel/brake ratio per point
        out.append(dict(model=name, params=np.round(b, 4).tolist(), rmse=np.sqrt(rss / n), loo=np.sqrt((loo ** 2).mean()),
                        bic=bic, eff_6k=np.interp(6000, rpm, eff), eff_9k=np.interp(9000, rpm, eff), eff_12k=np.interp(12000, rpm, eff)))
    return pd.DataFrame(out).set_index("model")
pd.set_option("display.width", 250); pd.set_option("display.max_colwidth", 60)
d = dy.loc[6000:12500]; print("== 500-rpm dyno grid 6-12.5k (n=%d)" % len(d)); print(evaluate(d.index.values.astype(float), d.brake_power_kW.values).round(3).to_string())
r = raw[(raw.rpm >= 6000) & (raw.rpm <= 12500)]; print("\n== raw 25-rpm dyno 6-12.5k (n=%d, autocorrelated)" % len(r)); print(evaluate(r.rpm.values, r.P.values).round(3).to_string())
d2 = dy.loc[7000:12500]; print("\n== 7-12.5k only (n=%d)" % len(d2)); print(evaluate(d2.index.values.astype(float), d2.brake_power_kW.values).round(3).to_string())
