import sys, json
from analyze import *
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
BEST = json.load(open(H + "/best.json"))["name"]
out = sys.argv[1] if len(sys.argv) > 1 else H + "/fig_exhaust.png"
INK, INK2, GR, SURF = '#1f1e1c', '#52514e', '#e4e3df', '#fcfcfb'
plt.rcParams.update({'font.size': 9, 'axes.edgecolor': INK2, 'axes.labelcolor': INK2, 'xtick.color': INK2, 'ytick.color': INK2,
                     'axes.facecolor': SURF, 'figure.facecolor': SURF, 'axes.grid': True, 'grid.color': GR,
                     'axes.spines.top': False, 'axes.spines.right': False})
V = [("V1", "V1 shipped sdm26.json", '#e08a2b', '-'),
     ("AB_intake", "as-built intake (0033)", '#86b6ea', '-'),
     (BEST, "as-built intake + as-built exhaust", '#1f5fb4', '-'),
     ("AB_full_tune", "as-built intake + exhaust + real tune", '#b0306a', '--')]
fig, ax = plt.subplots(2, 1, figsize=(11, 10), sharex=True)
def shade(a):
    for lo, hi in [(6.0, 6.4), (8.9, 9.1)]: a.axvspan(lo, hi, color='#2ca25f', alpha=.10)
    for lo, hi in [(4.5, 4.7), (7.4, 8.0)]: a.axvspan(lo, hi, color='#de2d26', alpha=.08)
a = ax[0]
a.plot(dy.index / 1000, dy.brake_torque_Nm, color=INK, lw=2.6, marker='o', ms=4, label="SDM26 team dyno (wheel)", zorder=5)
for n, l, c, ls in V:
    m = load(n); j = dy.join(m[["P_kW"]], how="inner"); dP = j.P_kW * 0.85 - j.brake_power_kW
    r = np.sqrt((dP.loc[6000:12500] ** 2).mean()); r68 = np.sqrt((dP.loc[6000:8500] ** 2).mean())
    a.plot(m.index / 1000, m.bt * 0.85, color=c, lw=1.9, ls=ls, label=f"{l}   RMSE 6-12.5k {r:.2f} kW, 6-8.5k {r68:.2f} kW")
a.set_ylabel("wheel torque (N·m)  [sim brake × 0.85]"); a.set_ylim(22, 50)
a.set_title("Wheel torque vs team dyno (green bands = car VE peaks, red = car VE troughs)", loc='left')
a.legend(fontsize=8, loc='lower center'); shade(a)
a = ax[1]; nm = lambda s: s / s.mean()
a.plot(GRID / 1000, nm(P), color=INK, lw=2.6, label="car: ECU VE proxy PW×λ (λ lag 270 ms)", zorder=5)
for n, l, c, ls in V:
    m = load(n).ve_del.loc[4000:10750]
    a.plot(m.index / 1000, nm(m), color=c, lw=1.9, ls=ls, label=f"{l}   r = {corr(m.reindex(GRID), P):+.2f}")
a.set_ylabel("delivered VE / mean (4-10.75k)"); a.set_xlabel("engine speed (krpm)")
a.set_title("VE shape vs the car (tune-independent airflow proxy)", loc='left')
a.legend(fontsize=8, loc='lower center'); shade(a); a.set_xlim(4, 12.6)
fig.tight_layout(); fig.savefig(out, dpi=130); print(out)
# chart rows for the web chart
rows = []
for n, lab in [("V1", "V1"), ("AB_intake", "AB_intake"), (BEST, "AB_full"), ("AB_full_tune", "AB_full_tune")]:
    m = load(n)
    for rpm, r in m.iterrows():
        rows.append(dict(variant=lab, rpm=int(rpm), P_wheel_kW=round(r.P_kW * 0.85, 3), T_wheel_Nm=round(r.bt * 0.85, 3), ve_del=round(r.ve_del, 5)))
pd.DataFrame(rows).to_csv(H + "/chart_rows.csv", index=False); print("chart_rows", len(rows))
