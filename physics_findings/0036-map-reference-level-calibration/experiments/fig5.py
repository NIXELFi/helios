import os, sys; os.environ['HUNTEXP'] = 'x'
from lib import *
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
INK, INK2, GR, SURF = '#1f1e1c', '#52514e', '#e4e3df', '#fcfcfb'
plt.rcParams.update({'font.size': 9, 'axes.edgecolor': INK2, 'axes.labelcolor': INK2, 'xtick.color': INK2, 'ytick.color': INK2,
                     'axes.facecolor': SURF, 'figure.facecolor': SURF, 'axes.grid': True, 'grid.color': GR,
                     'axes.spines.top': False, 'axes.spines.right': False, 'lines.linewidth': 2})
V = [(a, b, c, d) for a, b, c, d in [
    ("M10", 101325, "momentum collector (p_amb 101.3, venturi R 0.85)", '#2a78d6'),
    ("M_P97", 97300, "+ Tempe ambient 97.3 kPa / 305 K", '#eb6834'),
    ("M_P97_R62", 97300, "+ Tempe ambient + diffuser eff 0.62", '#1baf7a'),
    ("M_P97_R50", 97300, "+ Tempe ambient + diffuser eff 0.50", '#eda100')] if os.path.isdir(f"{RUNS}/{a}")]
ref = pd.read_csv(H + "/../exp1/ve_map_reference.csv").set_index("bin").reindex(GRID)
fig, ax = plt.subplots(3, 1, figsize=(11, 13), sharex=True)
a = ax[0]
a.fill_between(GRID / 1000, ref.ve_map_lo, ref.ve_map_hi, color=GR, alpha=.7, label="car MAP-VE sensitivity band")
a.plot(GRID / 1000, MV / MV.mean(), color=INK, lw=2.6, marker='o', ms=3, label="car: MAP-based VE (exp 1)")
for n, pa, l, c in V:
    g = load(n).ve_del.reindex(GRID); r = analyze5(n, pa)
    a.plot(GRID / 1000, g / g.mean(), color=c, label=f"{l}   r {r['rMAP']:+.2f}, slope {r['slopeMAP']:.2f}")
a.set_ylabel("VE / mean (4-10.75k)"); a.set_title("VE shape vs the car's MAP-based airflow", loc='left'); a.legend(fontsize=8, loc='lower right')
a = ax[1]
a.plot(GRID / 1000, CAR_DP, color=INK, lw=2.6, marker='o', ms=3, label="car: baro 97.3 − MAP")
for n, pa, l, c in V:
    m = load(n); dp = (pa - m.p_plenum.reindex(GRID)) / 1000; r = analyze5(n, pa)
    a.plot(GRID / 1000, dp, color=c, label=f"{l}   RMSE {r['dp_rmse']:.2f} kPa")
a.set_ylabel("intake pressure drop, ambient → plenum (kPa)"); a.set_title("Intake pressure drop vs rpm", loc='left'); a.legend(fontsize=8, loc='upper left')
a = ax[2]
a.plot(dy.index / 1000, dy.brake_torque_Nm, color=INK, lw=2.6, marker='o', ms=4, label="SDM26 team dyno (wheel)")
for n, pa, l, c in V:
    m = load(n); r = analyze5(n, pa)
    a.plot(m.index / 1000, m.bt * 0.85, color=c, label=f"{l}   RMSE {r['rmse6-12.5']:.2f} kW, bias {r['bias']:+.1f}, de-biased {r['rmse_debiased6-12.5']:.2f}")
a.set_ylabel("wheel torque (N·m) [brake × 0.85]"); a.set_xlabel("engine speed (krpm)"); a.set_ylim(28, 54)
a.set_title("Wheel torque vs team dyno (0034 slope tune)", loc='left'); a.legend(fontsize=8, loc='lower center'); a.set_xlim(4, 12.6)
fig.tight_layout(); fig.savefig(H + "/fig_exp5.png", dpi=130); print("ok")
