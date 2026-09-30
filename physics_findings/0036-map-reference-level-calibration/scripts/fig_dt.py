import os, sys, numpy as np, pandas as pd
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
from dtfit import brake_at, MODELS, fit, dy, raw
INK, INK2, GR, SURF = '#1f1e1c', '#52514e', '#e4e3df', '#fcfcfb'
COL = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100']
plt.rcParams.update({'font.size': 9, 'axes.edgecolor': INK2, 'axes.labelcolor': INK2, 'xtick.color': INK2, 'ytick.color': INK2,
                     'axes.facecolor': SURF, 'figure.facecolor': SURF, 'axes.grid': True, 'grid.color': GR,
                     'axes.spines.top': False, 'axes.spines.right': False, 'lines.linewidth': 2})
d = dy.loc[6000:12500]; rpm = d.index.values.astype(float); y = d.brake_power_kW.values
R = np.arange(6000, 12501, 100.0); w = lambda r: r * 2 * np.pi / 60 / 1000
sel = ["L1  wheel = eta*Pb", "L2  eta*Pb - c1*w (const loss torque)", "L3  eta*Pb - c2*w^2", "L6  eta*Pb - c3*w^3 (windage-like)"]
fig, ax = plt.subplots(3, 1, figsize=(10, 12), sharex=True)
ax[0].plot(raw.rpm / 1000, raw.P, color=GR, lw=1, label="raw dyno (25 rpm)")
ax[0].plot(rpm / 1000, y, color=INK, lw=2.6, marker='o', ms=4, label="team dyno wheel power (500 rpm grid)")
for c, n in zip(COL, sel):
    b = fit(MODELS[n](brake_at(rpm), w(rpm)), y); P = MODELS[n](brake_at(R), w(R)) @ b
    ax[0].plot(R / 1000, P, color=c, ls='-' if c == COL[0] else '--', label=n.split("  ")[0] + ": " + n.split("  ")[1] + f"   params {np.round(b, 3).tolist()}")
    ax[1].plot(R / 1000, P / brake_at(R), color=c, ls='-' if c == COL[0] else '--', label=n.split("  ")[0])
    ax[2].plot(rpm / 1000, y - MODELS[n](brake_at(rpm), w(rpm)) @ b, color=c, marker='o', ms=3, ls='-' if c == COL[0] else '--', label=n.split("  ")[0])
ax[0].set_ylabel("wheel power (kW)"); ax[0].set_title("Model brake power × drivetrain loss model vs team dyno (sdm26_asbuilt_cal physics, η_comb 0.94, stock FMEP)", loc='left'); ax[0].legend(fontsize=7.5, loc='lower right')
ax[0].set_xlim(6, 12.6); ax[0].set_ylim(25, 50)
ax[1].set_ylabel("implied wheel / brake"); ax[1].set_ylim(0.88, 1.0); ax[1].set_title("Implied drivetrain efficiency vs rpm: the extra terms only tilt it 0.96 → 0.92", loc='left'); ax[1].legend(fontsize=8)
ax[2].axhline(0, color=INK2, lw=1); ax[2].set_ylabel("dyno − fit (kW)"); ax[2].set_xlabel("engine speed (krpm)")
ax[2].set_title("Residuals: dominated by the engine's peak shape (6k, 8.5k), not by a smooth speed trend", loc='left'); ax[2].legend(fontsize=8)
fig.tight_layout(); fig.savefig(sys.argv[1] if len(sys.argv) > 1 else "fig_drivetrain.png", dpi=130)
