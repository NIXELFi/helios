import sys
from lib import *
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
INK, INK2, GR, SURF = '#1f1e1c', '#52514e', '#e4e3df', '#fcfcfb'
plt.rcParams.update({'font.size': 9, 'axes.edgecolor': INK2, 'axes.labelcolor': INK2, 'xtick.color': INK2, 'ytick.color': INK2,
                     'axes.facecolor': SURF, 'figure.facecolor': SURF, 'axes.grid': True, 'grid.color': GR,
                     'axes.spines.top': False, 'axes.spines.right': False, 'lines.linewidth': 2})
# fixed categorical order (blue, orange, aqua, yellow)
TQ = [("RT", "0034 as-built + real tune (committed)", '#2a78d6', '-'),
      ("RT_M10", "+ momentum collector", '#eb6834', '-'),
      ("RT_M_LL1", "+ momentum + bend/muffler losses", '#1baf7a', '-'),
      ("RT_M_LL1_G130", "+ momentum + losses + exhaust gas γ/R", '#eda100', '--')]
VE = [("AB_ex", "0034 as-built (committed)", '#2a78d6', '-'),
      ("M10", "+ momentum collector", '#eb6834', '-'),
      ("M_LL1", "+ momentum + losses", '#1baf7a', '-'),
      ("M_LL1_G130", "+ momentum + losses + exhaust gas γ/R", '#eda100', '--')]
fig, ax = plt.subplots(2, 1, figsize=(11, 10), sharex=True)
a = ax[0]
a.plot(dy.index / 1000, dy.brake_torque_Nm, color=INK, lw=2.6, marker='o', ms=4, label="SDM26 team dyno (wheel)", zorder=5)
for n, l, c, ls in TQ:
    m = load(n); j = dy.join(m[["P_kW"]], how="inner"); dP = j.P_kW * 0.85 - j.brake_power_kW
    r = np.sqrt((dP.loc[6000:12500] ** 2).mean()); r7 = np.sqrt((dP.loc[7000:11500] ** 2).mean())
    a.plot(m.index / 1000, m.bt * 0.85, color=c, ls=ls, label=f"{l}   RMSE 6-12.5k {r:.2f} kW, 7-11.5k {r7:.2f}")
a.set_ylabel("wheel torque (N·m)  [sim brake × 0.85]"); a.set_ylim(28, 52)
a.set_title("Wheel torque vs team dyno, real tune loaded", loc='left'); a.legend(fontsize=8, loc='lower center')
a = ax[1]; nm = lambda s: s / s.mean()
a.plot(GRID / 1000, nm(PW), color=INK, lw=2.6, label="car: ECU VE proxy, λ lag measured at WOT (0035)", zorder=5)
a.plot(GRID / 1000, nm(P), color=INK2, lw=1.2, ls=':', label="car: ECU VE proxy, λ lag 270 ms (0033/0034)")
for n, l, c, ls in VE:
    m = load(n).ve_del.loc[4000:10750]
    a.plot(m.index / 1000, nm(m), color=c, ls=ls, label=f"{l}   r = {corr(m.reindex(GRID), PW):+.2f} (270 ms: {corr(m.reindex(GRID), P):+.2f})")
a.axvspan(7.3, 8.2, color=GR, alpha=.6)
a.set_ylabel("delivered VE / mean (4-10.75k)"); a.set_xlabel("engine speed (krpm)")
a.set_title("VE shape vs the car (tune-independent airflow proxy); grey = car trough", loc='left')
a.legend(fontsize=8, loc='lower center'); a.set_xlim(4, 12.6)
fig.tight_layout(); out = sys.argv[1] if len(sys.argv) > 1 else "fig_0035.png"; fig.savefig(out, dpi=130); print(out)
