import sys
from lib import *
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
N = ["a_base", "b_hot", "c_vhot", "d_hx03", "e_hx05", "f_hot_hx05"]
rows = []
for n in N:
    r = analyze5(n, p_amb=97300.0); m = load(n)
    r["ripple_std"] = (m.ve_del.reindex(GRID) / m.ve_del.reindex(GRID).mean()).loc[5500:10000].std()
    r["egt_6_10k"] = m.egt_massavg.loc[6000:10000].mean(); r["egt_12k"] = m.egt_massavg.get(12000, np.nan)
    rows.append(r)
T = pd.DataFrame(rows).set_index("variant")
mvn = (MV / MV.mean()).loc[5500:10000]; print("car MAP-VE ripple std", round(mvn.std(), 3))
pd.set_option("display.width", 300); pd.set_option("display.max_columns", 40)
cols = ["rMAP", "slopeMAP", "ripple_std", "depth", "pk6", "pk9", "dp_rmse", "dp9", "rmse6-12.5", "rmse6-8.5", "rmse7-11.5", "rmse10.5-12.5", "bias", "rmse_debiased6-12.5", "egt_6_10k", "egt_12k"]
print(T[cols].round(3).to_string()); T.to_csv("exp6_summary.csv")
INK, INK2, GR, SURF = '#1f1e1c', '#52514e', '#e4e3df', '#fcfcfb'
plt.rcParams.update({'font.size': 9, 'axes.edgecolor': INK2, 'axes.labelcolor': INK2, 'xtick.color': INK2, 'ytick.color': INK2,
                     'axes.facecolor': SURF, 'figure.facecolor': SURF, 'axes.grid': True, 'grid.color': GR,
                     'axes.spines.top': False, 'axes.spines.right': False, 'lines.linewidth': 2})
K = [("a_base", "base (walls 650/550/500 K)", '#2a78d6', '-'), ("b_hot", "walls 900/750/650 K", '#eb6834', '-'),
     ("c_vhot", "walls 1000/850/750 K", '#1baf7a', '-'), ("e_hx05", "exhaust h × 0.5", '#eda100', '--')]
fig, ax = plt.subplots(2, 1, figsize=(11, 10), sharex=True)
a = ax[0]; nm = lambda s: s / s.mean()
mc = pd.read_csv(H + "/../exp1/ve_map_reference.csv", index_col=0)
a.plot(GRID / 1000, nm(MV), color=INK, lw=2.6, marker='o', ms=3, label="car: MAP-based VE (exp1)", zorder=5)
for n, l, c, ls in K:
    v = load(n).ve_del.reindex(GRID); t = T.loc[n]
    a.plot(GRID / 1000, nm(v), color=c, ls=ls, label=f"{l}   r {t.rMAP:+.2f}, in-phase slope {t.slopeMAP:.2f}")
a.set_ylabel("delivered VE / mean (4-10.75k)"); a.set_title("VE shape vs car MAP-VE (ambient 97.3 kPa, diffuser η 0.62, momentum collector)", loc='left'); a.legend(fontsize=8, loc='lower center')
a = ax[1]
a.plot(dy.index / 1000, dy.brake_torque_Nm, color=INK, lw=2.6, marker='o', ms=4, label="SDM26 team dyno (wheel)", zorder=5)
for n, l, c, ls in K:
    m = load(n); t = T.loc[n]
    a.plot(m.index / 1000, m.bt * 0.85, color=c, ls=ls, label=f"{l}   RMSE 6-12.5k {t['rmse6-12.5']:.2f} kW (de-biased {t['rmse_debiased6-12.5']:.2f}, bias {t.bias:+.1f})")
a.set_ylabel("wheel torque (N·m) [sim brake × 0.85]"); a.set_xlabel("engine speed (krpm)"); a.set_ylim(28, 52); a.set_xlim(4, 12.6)
a.set_title("Wheel torque vs team dyno (slope tune, no level re-fit)", loc='left'); a.legend(fontsize=8, loc='lower center')
fig.tight_layout(); fig.savefig("fig_exp6.png", dpi=130); print("fig_exp6.png")
