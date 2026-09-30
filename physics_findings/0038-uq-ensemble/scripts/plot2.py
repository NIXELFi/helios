# Finding 0038 phase 2 figures: the probabilistic VRLI design envelope
# (cap x stroke, posterior median + P(P1 >= 5 %) contours), sweep-rate bands for
# key cells, and the ECU-table band of the 0037 recommended design.
import os
import numpy as np, pandas as pd
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap
from phase2 import P2, F, RATES, BASE_RUNNER_MM, REC, wq

INK, INK2, GR, SURF = '#1f1e1c', '#52514e', '#e4e3df', '#fcfcfb'
COL = {"table": '#2a78d6', "dyno_500": '#1baf7a', "gear2_3000": '#eda100', "gear1_6000": '#eb6834'}
LAB = {"table": "quasi-steady table", "dyno_500": "dyno sweep 500 rpm/s", "gear2_3000": "2nd gear 3000 rpm/s", "gear1_6000": "1st gear 6000 rpm/s"}
plt.rcParams.update({'font.size': 9, 'axes.edgecolor': INK2, 'axes.labelcolor': INK2, 'xtick.color': INK2, 'ytick.color': INK2,
                     'axes.facecolor': SURF, 'figure.facecolor': SURF, 'axes.spines.top': False, 'axes.spines.right': False,
                     'lines.linewidth': 2})
G = pd.read_csv(os.path.join(P2, "envelope_distribution.csv"))
seq = LinearSegmentedColormap.from_list("blue", ['#cde2fb', '#86b6ef', '#3987e5', '#1c5cab', '#0d366b'])

# --- 1. probabilistic envelope heatmaps: dyno sweep and 1st gear -------------
fig, ax = plt.subplots(1, 2, figsize=(16, 7.6), sharey=True, gridspec_kw=dict(wspace=0.06))
for a, tag in [(ax[0], "dyno_500"), (ax[1], "gear1_6000")]:
    x = G[G.rate == tag]
    M = 100 * x.pivot(index="cap", columns="stroke", values="gain_q50")
    L = 100 * x.pivot(index="cap", columns="stroke", values="gain_q10")
    U = 100 * x.pivot(index="cap", columns="stroke", values="gain_q90")
    Pp = x.pivot(index="cap", columns="stroke", values="P_p1_ge_5")
    im = a.imshow(M.values, origin="lower", aspect="auto", cmap=seq, vmin=-1.5, vmax=8)
    for i in range(M.shape[0]):
        for j in range(M.shape[1]):
            v = M.values[i, j]
            if np.isfinite(v):
                c = '#ffffff' if v > 4.5 else INK
                a.text(j, i + 0.22, f"{v:+.1f}", ha="center", va="center", fontsize=9, color=c)
                a.text(j, i - 0.05, f"{L.values[i, j]:.1f}–{U.values[i, j]:.1f}", ha="center", va="center", fontsize=6.5, color=c)
                a.text(j, i - 0.3, f"P {100 * Pp.values[i, j]:.0f}%", ha="center", va="center", fontsize=6.5, color=c)
            else:
                a.text(j, i, "–", ha="center", va="center", color=INK2)
    Pv = np.nan_to_num(Pp.values, nan=0.0)
    cs = a.contour(Pv, levels=[0.5, 0.8], colors=[INK, INK], linestyles=['--', '-'], linewidths=1.6, origin="lower")
    a.clabel(cs, fmt={0.5: "P=50 %", 0.8: "P=80 %"}, fontsize=7)
    a.set_xticks(range(M.shape[1])); a.set_xticklabels(M.columns.astype(int)); a.set_yticks(range(M.shape[0]))
    a.set_yticklabels([f"+{c:.0f} mm (runner {BASE_RUNNER_MM + c:.0f})" for c in M.index])
    a.set_xlabel("stroke (mm)")
    if tag == "dyno_500": a.set_ylabel("long end: extension over as-built (mm)")
    a.set_title(f"P1 gain 6-12k (%), {LAB[tag]}\ncell: median / 10–90 % band / P(P1 ≥ 5 %)", loc='left', fontsize=9)
fig.colorbar(im, ax=ax, shrink=0.8, label="median gain (%)")
fig.suptitle("Probabilistic VRLI design envelope (finding 0038 posterior on sdm26_asbuilt_cal, neutral tune, trumpets displace plenum). "
             "Contours: probability the cell meets P1 (+5 %).", x=0.01, y=1.02, ha='left', fontsize=9, color=INK2)
fig.savefig(os.path.join(F, "fig_envelope_uq.png"), dpi=130, bbox_inches="tight"); plt.close(fig)

# --- 2. sweep-rate bands for the cap row of the 0037 recommendation + ECU band --
fig, ax = plt.subplots(1, 2, figsize=(14, 4.8))
a = ax[0]
cap = 115
for tag, _ in RATES:
    g = G[(G.rate == tag) & (G.cap == cap)].sort_values("stroke")
    a.fill_between(g.stroke, 100 * g.gain_q10, 100 * g.gain_q90, color=COL[tag], alpha=.16, lw=0)
    a.plot(g.stroke, 100 * g.gain_q50, color=COL[tag], marker='o', ms=4, label=f"{LAB[tag]}")
a.axhline(5, color=INK2, ls='--', lw=1); a.text(2, 5.15, "P1 target +5 %", color=INK2, fontsize=8)
a.set_xlabel("stroke (mm)"); a.set_ylabel("P1 gain (%)"); a.grid(True, color=GR)
a.set_title(f"Long end up to +{cap} mm: median and 80 % band by sweep rate", loc='left'); a.legend(fontsize=8)
a = ax[1]
T = pd.read_csv(os.path.join(P2, "ecu_table_per_sample.csv"), index_col=0)
R = pd.read_csv(os.path.join(P2, "resampled.csv"))
w = dict(zip(R["sample"].astype(str), R.weight))
X = T.values + BASE_RUNNER_MM
ww = np.array([w[c] for c in T.columns])
q = np.array([wq(row, ww, [0.1, 0.5, 0.9]) for row in X])
rpm = T.index.values
for c in T.columns:
    a.plot(rpm / 1000, T[c].values + BASE_RUNNER_MM, color=GR, lw=1)
a.fill_between(rpm / 1000, q[:, 0], q[:, 2], color='#2a78d6', alpha=.25, lw=0, label="posterior 80 %")
a.plot(rpm / 1000, q[:, 1], color='#2a78d6', marker='o', ms=4, label="posterior median")
lo, hi = BASE_RUNNER_MM + REC["lmin"], BASE_RUNNER_MM + REC["lmin"] + REC["stroke"]
a.axhline(lo, color=INK2, ls='--', lw=1); a.axhline(hi, color=INK2, ls='--', lw=1)
a.set_xlabel("engine speed (krpm)"); a.set_ylabel("runner length (mm)"); a.grid(True, color=GR)
a.set_title(f"ECU table band, 0037 design {REC['stroke']:.0f} mm ({lo:.0f}-{hi:.0f} mm); grey = samples", loc='left')
a.legend(fontsize=8)
fig.tight_layout(); fig.savefig(os.path.join(F, "fig_vrli_rates_ecu.png"), dpi=130)
print("ok")
