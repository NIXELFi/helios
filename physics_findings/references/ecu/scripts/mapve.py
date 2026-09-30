# MAP-based, tune-independent airflow reference: restrictor mass flow from (baro - MAP).
import pandas as pd, numpy as np
import os
# Needs log.pkl from load.py (raw Log 7.5.csv from the vault). Baro is NOT logged: 97.3 kPa = Tempe standard.
d = pd.read_pickle(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'log.pkl'))
GRID = np.arange(4000, 10751, 250)
G, R, T0 = 1.4, 287.0, 305.0
AT = 0.25*np.pi*0.020**2; CD = 0.97; VD = 599e-6
def mdot(p0, mp, eta, n=None):
    """Restrictor flow. n given -> incompressible power law k*dp^n. Else compressible nozzle to throat static pt,
    diffuser recovers eta*(p0-pt): MAP = pt + eta*(p0-pt)."""
    dp = np.maximum(p0 - mp, 1e-3)
    if n is not None: return dp**n
    pt = (mp - eta*p0)/(1 - eta)
    pr = np.clip(pt/p0, (2/(G+1))**(G/(G-1)), 1.0)
    return CD*AT*p0*1e3*np.sqrt(2*G/((G-1)*R*T0)*np.maximum(pr**(2/G) - pr**((G+1)/G), 0))
def mask(x):
    m = (x["APS (Main)"] >= 85) & (x["% Ignition Cut"] == 0) & (x["% Fuel Cut"] == 0) & (x["Engine Speed"] > 3500) & (x["Fuel Pressure"] > 300)
    cut = ((x["% Fuel Cut"] > 0) | (x["% Ignition Cut"] > 0)).astype(float).rolling(700, min_periods=1).max().shift(-700).fillna(1)
    return m & (cut == 0)
def ve_map(p0=97.3, eta=0.5, n=None, lag_ms=0, smooth=1):
    x = d.copy()
    mp = x["MAP"].rolling(smooth, center=True, min_periods=1).mean().values if smooth > 1 else x["MAP"].values
    if lag_ms: mp = np.roll(mp, -lag_ms)   # MAP(t+lag) pairs with rpm(t) if the sensor lags
    x["md"] = mdot(p0, mp, eta, n)
    x = x[mask(x)]
    x["ve"] = x.md / (p0*1e3/(R*T0) * VD * x["Engine Speed"]/120)
    x["bin"] = (x["Engine Speed"]/250).round()*250
    g = x.groupby("bin").agg(n=("ve", "size"), ve=("ve", "median"), map=("MAP", "median"))
    return g[g.n >= 50].reindex(GRID)
if __name__ == "__main__":
    base = ve_map()
    print("absolute VE (p0 97.3, eta 0.5):"); print(base.round(3).to_string())
    V = {}
    for lab, kw in [("base p0 97.3 eta .5", {}), ("p0 96.3", dict(p0=96.3)), ("p0 98.3", dict(p0=98.3)),
                    ("eta 0", dict(eta=0.0)), ("eta .8", dict(eta=0.8)), ("n .5", dict(n=0.5)), ("n .45", dict(n=0.45)), ("n .55", dict(n=0.55)),
                    ("lag 50ms", dict(lag_ms=50)), ("smooth 51", dict(smooth=51))]:
        g = ve_map(**kw); V[lab] = g.ve/g.ve.mean()
        print(f"{lab:22s} absVE 6.25k {g.ve.loc[6250]:.3f} 8k {g.ve.loc[8000]:.3f} 9k {g.ve.loc[9000]:.3f}")
    T = pd.DataFrame(V); T.to_csv("ve_map_sensitivity.csv"); print(T.round(3).to_string())
