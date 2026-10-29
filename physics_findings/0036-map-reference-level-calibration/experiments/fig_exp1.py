import sys; sys.path.insert(0, "../study")
import numpy as np, pandas as pd, lib
from mapve import ve_map, GRID
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
INK, INK2, GR, SURF = '#1f1e1c', '#52514e', '#e4e3df', '#fcfcfb'
C1, C2, C3, C4 = '#2a78d6', '#eb6834', '#1baf7a', '#eda100'
plt.rcParams.update({'font.size': 9, 'axes.edgecolor': INK2, 'axes.labelcolor': INK2, 'xtick.color': INK2, 'ytick.color': INK2,
                     'axes.facecolor': SURF, 'figure.facecolor': SURF, 'axes.grid': True, 'grid.color': GR,
                     'axes.spines.top': False, 'axes.spines.right': False, 'lines.linewidth': 2})
nm = lambda s: s / s.mean()
def depth(s):
    s = nm(s); return s.loc[7250:8250].min() - 0.5*(s.loc[6000:6750].max() + s.loc[8500:9500].max())
cases = {"base": {}, "p0 96.8": dict(p0=96.8), "p0 97.8": dict(p0=97.8), "eta 0": dict(eta=0.0), "eta .8": dict(eta=0.8),
         "n .45": dict(n=0.45), "n .55": dict(n=0.55), "MAP lag 50 ms": dict(lag_ms=50)}
V = {k: nm(ve_map(**kw).ve) for k, kw in cases.items()}
M = pd.DataFrame(V); base = ve_map()
PW = nm(lib.PW); dy = lib.dy.brake_torque_Nm
dyg = dy.reindex(dy.index.union(GRID)).interpolate("index").reindex(GRID); dyg[GRID < 4500] = np.nan
print("case          ripple_std5.5-10k  depth   pk6(rpm) pk9(rpm)")
for k in M: s = M[k]; print(f"{k:14s} {s.loc[5500:10000].std():.3f}   {depth(s):+.3f}   {int(s.loc[5500:7000].idxmax())}  {int(s.loc[8250:10000].idxmax())}")
print("pw*lambda      ", round(PW.loc[5500:10000].std(),3), round(depth(PW),3), int(PW.loc[5500:7000].idxmax()), int(PW.loc[8250:10000].idxmax()))
print("dyno (grid)    ", round(nm(dyg).loc[5500:10000].std(),3), round(depth(dyg),3), int(dyg.loc[5500:7000].idxmax()), int(dyg.loc[8250:10000].idxmax()))
print("corr: ve_map~dyno", round(lib.corr(M["base"], dyg),3), " pw*lambda~dyno", round(lib.corr(PW, dyg),3), " ve_map~pw*lambda", round(lib.corr(M['base'], PW),3))
lo, hi = M.min(axis=1), M.max(axis=1)
pd.DataFrame({"ve_map": M["base"], "ve_map_lo": lo, "ve_map_hi": hi, "ve_map_abs": base.ve, "car_map_kPa": base["map"]}).round(4).to_csv("ve_map_reference.csv")
fig, ax = plt.subplots(2, 1, figsize=(11, 9.5), sharex=True)
a = ax[0]
a.fill_between(GRID/1000, lo, hi, color=INK, alpha=.10, lw=0, label="MAP-VE sensitivity (baro ±0.5 kPa, diffuser recovery 0-0.8, Δp exponent 0.45-0.55, MAP lag)")
a.plot(GRID/1000, M["base"], color=INK, lw=2.6, marker='o', ms=3, label="car: MAP-based VE (restrictor flow from baro − MAP), NEW")
a.plot(GRID/1000, PW, color=INK2, lw=1.3, ls=':', label="car: PW·λ proxy at WOT λ lag (0035)")
a.plot(GRID/1000, nm(dyg), color=C4, lw=1.6, ls='--', label="car: dyno wheel torque / mean")
for n, l, c in [("AB_ex", "model 0034 as-built", C1), ("M10", "model + momentum collector", C2), ("RT_M_LL1_G130", "model + collector + losses + γ, real tune", C3)]:
    m = lib.load(n).ve_del.reindex(GRID)
    a.plot(GRID/1000, nm(m), color=c, lw=1.8, label=f"{l}   r vs MAP-VE {lib.corr(m, M['base']):+.2f}")
a.axvspan(7.3, 8.2, color=GR, alpha=.6)
a.set_ylabel("VE (or torque) / mean, 4-10.75k"); a.set_ylim(0.8, 1.25)
a.set_title("Airflow from MAP: the 7.5-8k dip is real but about −0.09, not −0.25; peaks at 6.0k / 8.75k like the dyno", loc='left')
a.legend(fontsize=7.5, loc='upper left', framealpha=.95)
a = ax[1]
a.fill_between(GRID/1000, 96.8 - base["map"], 97.8 - base["map"], color=INK, alpha=.12, lw=0, label="car, baro 96.8-97.8 kPa (no baro channel; 97.3 = Tempe std)")
a.plot(GRID/1000, 97.3 - base["map"], color=INK, lw=2.6, marker='o', ms=3, label="car: baro − MAP (baro 97.3)")
for n, l, c in [("AB_ex", "model 0034 as-built", C1), ("RT_M_LL1_G130", "model + collector + losses + γ, real tune", C3)]:
    m = lib.load(n).p_plenum.reindex(GRID)
    a.plot(GRID/1000, (101325 - m)/1000, color=c, lw=1.8, label=f"{l}: p_ambient − p_plenum (mean)")
a.set_ylabel("intake pressure drop, ambient → plenum (kPa)"); a.set_xlabel("engine speed (krpm)")
a.set_title("The car loses ~2× the model's pressure across filter + throttle + restrictor", loc='left')
a.legend(fontsize=8, loc='upper left'); a.set_xlim(4, 10.9)
fig.tight_layout(); fig.savefig("fig_exp1_map_ve.png", dpi=130); print("fig_exp1_map_ve.png")
