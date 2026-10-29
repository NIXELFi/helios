import pandas as pd, numpy as np, sys
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
INK, INK2, GR, SURF = '#1f1e1c', '#52514e', '#e4e3df', '#fcfcfb'
C1, C2, C3 = '#2a78d6', '#eb6834', '#1baf7a'
plt.rcParams.update({'font.size': 9, 'axes.edgecolor': INK2, 'axes.labelcolor': INK2, 'xtick.color': INK2, 'ytick.color': INK2,
                     'axes.facecolor': SURF, 'figure.facecolor': SURF, 'axes.grid': True, 'grid.color': GR,
                     'axes.spines.top': False, 'axes.spines.right': False, 'lines.linewidth': 2})
import os
d = pd.read_pickle(os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','..','references','ecu','scripts','log.pkl'))
fc = d['% Fuel Cut'].values; ic = d['% Ignition Cut'].values; lam = d['Lambda 1'].values; aps = d['APS (Main)'].values
fig, ax = plt.subplots(1, 2, figsize=(12, 4.6))
a = ax[0]; tt = np.arange(-100, 600)
lab = {"wot": 0, "ovr": 0}
for i in np.where((ic[1:] > 0) & (ic[:-1] == 0))[0] + 1:
    dur = np.argmax(ic[i:i + 3000] == 0)
    if aps[i] < 80 or fc[i] > 0 or dur < 400: continue
    b = np.nanmedian(lam[i - 60:i]); pl = np.nanmedian(lam[i + 250:i + 400])
    if abs(pl - b) < 0.08: continue
    a.plot(tt, (lam[i - 100:i + 600] - b) / (pl - b), color=C1, lw=1.4, alpha=.8, label=None if lab["wot"] else "WOT rev-limit ignition cut (~10.8k, MAP 89 kPa)"); lab["wot"] = 1
for i in np.where((fc[1:] >= 50) & (fc[:-1] < 50))[0] + 1:
    dur = np.argmax(fc[i:i + 3000] < 50)
    if dur < 250: continue
    b = np.nanmedian(lam[i - 100:i]); after = lam[i:i + 600]
    k = np.argmax(after > b + 0.1)
    a.plot(tt, np.clip((lam[i - 100:i + 600] - b) / 0.5, -0.2, 1.4), color=C2, lw=1.4, alpha=.8, label=None if lab["ovr"] else "closed-throttle overrun fuel cut (MAP 35-60 kPa)"); lab["ovr"] = 1
a.axvline(270, color=INK2, ls='--', lw=1); a.text(275, -0.2, "270 ms (0033/0034 lag)", color=INK2, fontsize=8)
a.axvline(90, color=INK2, ls=':', lw=1); a.text(95, -0.15, "~90 ms WOT", color=INK2, fontsize=8)
a.set_xlim(-100, 600); a.set_ylim(-0.25, 1.45); a.set_xlabel("time from cut onset (ms)"); a.set_ylabel("λ response (normalised)")
a.set_title("λ sensor lag: WOT vs overrun (ECU Log 7.5, 1 kHz)", loc='left'); a.legend(fontsize=8, loc='upper left', framealpha=.95)
a = ax[1]; G = np.arange(4000, 10751, 250)
for f, lbl, c, ls in [(os.path.join(os.path.dirname(os.path.abspath(__file__)),"..","..","references","ecu","proxy_c270.csv"), "λ lag 270 ms (0033/0034 target)", C2, '--'), (os.path.join(os.path.dirname(os.path.abspath(__file__)),"..","..","references","ecu","proxy_wotA.csv"), "λ lag measured at WOT (≈40 + 50·10.8k/rpm ms)", C1, '-')]:
    g = pd.read_csv(f).set_index("bin").ve.reindex(G); a.plot(G / 1000, g / g.mean(), color=c, ls=ls, label=lbl, marker='o', ms=3)
for lo, hi in [(7.3, 8.2)]: a.axvspan(lo, hi, color=GR, alpha=.6)
a.set_xlabel("engine speed (krpm)"); a.set_ylabel("ECU VE proxy (PW−1 ms)·λ / mean")
a.set_title("Car VE proxy: the 7.4-8k trough is −0.25 at the WOT lag, not −0.40", loc='left'); a.legend(fontsize=8, loc='lower center')
fig.tight_layout(); out = sys.argv[1] if len(sys.argv) > 1 else "fig_lag.png"; fig.savefig(out, dpi=130); print(out)
