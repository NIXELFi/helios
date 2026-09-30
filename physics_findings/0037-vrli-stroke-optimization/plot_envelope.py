# Design envelope: P1 gain vs (how much longer the long end may be) x (stroke). Finding 0037 addendum.
import pandas as pd, numpy as np, sys
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap
INK, INK2, GR, SURF = '#1f1e1c', '#52514e', '#e4e3df', '#fcfcfb'
plt.rcParams.update({'font.size': 9, 'axes.edgecolor': INK2, 'axes.labelcolor': INK2, 'xtick.color': INK2, 'ytick.color': INK2,
                     'axes.facecolor': SURF, 'figure.facecolor': SURF, 'axes.spines.top': False, 'axes.spines.right': False})
T = pd.read_csv("out/envelope/envelope.csv")
T = T[T.cap <= 115]
seq = LinearSegmentedColormap.from_list("blue", ['#cde2fb', '#86b6ef', '#3987e5', '#1c5cab', '#0d366b'])
fig, ax = plt.subplots(1, 2, figsize=(14, 5.6), sharey=True, gridspec_kw=dict(wspace=0.08))
for a, col, title in [(ax[0], "table", "Avg torque gain 6-12k (%), dyno sweep"),
                      (ax[1], "driver", "Driver band 7-10.5k gain (%)")]:
    P = T.pivot(index="cap", columns="stroke", values=col)
    im = a.imshow(P.values, origin="lower", aspect="auto", cmap=seq, vmin=-1.5, vmax=7)
    for i in range(P.shape[0]):
        for j in range(P.shape[1]):
            v = P.values[i, j]
            if np.isfinite(v):
                a.text(j, i, f"{v:+.1f}", ha="center", va="center", fontsize=8, color='#ffffff' if v > 4 else INK)
            else:
                a.text(j, i, "–", ha="center", va="center", fontsize=8, color=INK2)
    a.set_xticks(range(P.shape[1])); a.set_xticklabels(P.columns); a.set_yticks(range(P.shape[0]))
    a.set_yticklabels([f"+{c} mm (runner {328 + c})" for c in P.index])
    a.set_xlabel("stroke = how far the trumpets retract from the long end (mm)")
    if col == "table": a.set_ylabel("long end: extension over as-built (mm)")
    a.set_title(title, loc='left')
    if col == "table":
        a.contour(P.values, levels=[5.0], colors=[INK], linewidths=1.6, origin="lower")
        a.text(0.0, -0.2, "black line = P1 target (+5 %)", transform=a.transAxes, va="top", fontsize=8, color=INK)
fig.colorbar(im, ax=ax, shrink=0.8, label="gain (%)")
fig.suptitle("VRLI design envelope (model: sdm26_asbuilt_cal, neutral tune, trumpets displace plenum)   '–' = outside the converged grid", x=0.01, y=1.02, ha='left', fontsize=9, color=INK2)
fig.savefig(sys.argv[1] if len(sys.argv) > 1 else "fig_envelope_design.png", dpi=130, bbox_inches="tight")
