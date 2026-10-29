import sys, lib, numpy as np, pandas as pd
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
INK, INK2, GR, SURF = '#1f1e1c', '#52514e', '#e4e3df', '#fcfcfb'
C1, C2 = '#2a78d6', '#eb6834'
plt.rcParams.update({'font.size': 9, 'axes.edgecolor': INK2, 'axes.labelcolor': INK2, 'xtick.color': INK2, 'ytick.color': INK2,
                     'axes.facecolor': SURF, 'figure.facecolor': SURF, 'axes.grid': True, 'grid.color': GR,
                     'axes.spines.top': False, 'axes.spines.right': False, 'lines.linewidth': 2})
ref = pd.read_csv(lib.PF + "/references/ecu/ve_map_reference.csv").set_index("bin")
G = lib.GRID
V = [("RT", "0034 as-built + logged tune (before)", C1, 101325.0), ("CAL2", "0036 sdm26_asbuilt_cal (after)", C2, 97300.0)]
fig, ax = plt.subplots(3, 1, figsize=(11, 13), sharex=True)
a = ax[0]
a.fill_between(G / 1000, ref.ve_map_lo.reindex(G) / ref.ve_map.reindex(G).mean(), ref.ve_map_hi.reindex(G) / ref.ve_map.reindex(G).mean(), color=GR, alpha=.8, lw=0, label="car MAP-VE sensitivity band")
a.plot(G / 1000, ref.ve_map.reindex(G) / ref.ve_map.reindex(G).mean(), color=INK, lw=2.6, marker='o', ms=3, label="car: MAP-based VE (restrictor flow from baro − MAP)")
for n, l, c, _ in V:
    r = lib.analyze5(n, _); m = lib.load(n).ve_del.loc[4000:10750]
    a.plot(m.index / 1000, m / m.reindex(G).mean(), color=c, label=f"{l}   r {r['rMAP']:+.2f}, in-phase ripple {r['slopeMAP']:.2f} of car")
a.set_ylim(0.78, 1.2); a.set_ylabel("VE / mean (4-10.75k)"); a.set_title("Airflow shape vs the car (MAP-based reference)", loc='left'); a.legend(fontsize=8, loc='lower center')
a = ax[1]
a.plot(G / 1000, lib.CAR_DP, color=INK, lw=2.6, marker='o', ms=3, label="car: baro (97.3 kPa) − MAP")
for n, l, c, p in V:
    m = lib.load(n); dp = (p - m.p_plenum.reindex(G)) / 1000
    a.plot(G / 1000, dp, color=c, label=f"{l}   RMSE {np.sqrt(((dp - lib.CAR_DP) ** 2).mean()):.2f} kPa")
a.set_ylabel("intake pressure drop, ambient → plenum (kPa)"); a.set_title("Intake restriction vs the car", loc='left'); a.legend(fontsize=8, loc='upper left')
a = ax[2]
a.plot(lib.dy.index / 1000, lib.dy.brake_torque_Nm, color=INK, lw=2.6, marker='o', ms=4, label="SDM26 team dyno (wheel)")
for n, l, c, p in V:
    r = lib.analyze5(n, p); m = lib.load(n)
    a.plot(m.index / 1000, m.bt * 0.85, color=c, label=f"{l}   RMSE 6-12.5k {r['rmse6-12.5']:.2f} kW, 7-11.5k {r['rmse7-11.5']:.2f}, 10.5-12.5k {r['rmse10.5-12.5']:.2f}")
a.set_ylim(28, 52); a.set_xlim(4, 12.6); a.set_xlabel("engine speed (krpm)"); a.set_ylabel("wheel torque (N·m)  [sim brake × 0.85]")
a.set_title("Wheel torque vs team dyno, logged tune", loc='left'); a.legend(fontsize=8, loc='lower center')
fig.tight_layout(); out = sys.argv[1] if len(sys.argv) > 1 else "fig_0036.png"; fig.savefig(out, dpi=130); print(out)
