"""Finding 0039: report for primary_dia.py (exhaust primary 1.25 in vs 1.5 in OD). Torque curves against the dyno, band
differences against the CAD exhaust (p125) for each junction model, and where the peaks sit. Writes charts/asmeasured/."""
import json, os, numpy as np, pandas as pd
import core, vrli_common as vc
from vrli_common import plt, head, TOP, INK, INK2, MUTED

import sys
TAG = sys.argv[1] if len(sys.argv) > 1 else ""                           # "crotch" = primary_dia_crotch.py
H = core.H; vc.OUT = os.path.join(H, "charts", "asmeasured"); dy = core.dyno(); ETA = 0.94
D = pd.DataFrame([json.loads(l) for l in open(os.path.join(H, "primary_dia" + ("_" + TAG if TAG else "") + ".ndjson"))]); D = D[D.bt.notna()]
NAMES = {"p125": "1.25 in primaries (CAD)", "p150": "1.5 in primaries, whole system scaled", "p150only": "1.5 in primaries only"}; COL = {"p125": "#2a78d6", "p150": "#eb6834", "p150only": "#1baf7a"}
NOTE = ("1D engine model, all-measured car (runners 260 / 256 mm, dump plenum 1.807 L, exhaust 481 / 576 mm), logged AFR and spark, inertance on. "
        "Wheel torque = brake torque x 0.94. Same lengths in all three exhausts.")
rows = []; CUR = {}
for jn in D.junction.unique():
    for c in NAMES:
        x = D[(D.junction == jn) & (D.case == c)].drop_duplicates("rpm").set_index("rpm").sort_index()
        if len(x) < 30: continue
        CUR[(jn, c)] = (x.index.values.astype(float), x.bt.values * ETA, x.ve.values)
    if (jn, "p125") not in CUR: continue
    r, b, vb = CUR[(jn, "p125")]
    for c in NAMES:
        if (jn, c) not in CUR: continue
        _, t, v = CUR[(jn, c)]; d = np.interp(r, dy.rpm, dy.Nm)
        band = lambda lo, hi: (np.trapezoid(t[(r >= lo) & (r <= hi)], r[(r >= lo) & (r <= hi)]) / np.trapezoid(b[(r >= lo) & (r <= hi)], r[(r >= lo) & (r <= hi)]) - 1) * 100
        pk = lambda lo, hi: r[(r >= lo) & (r <= hi)][np.argmax(t[(r >= lo) & (r <= hi)])]
        rows.append(dict(junction=jn, case=c, **{"4-6k": band(4000, 6000), "6-12k": band(6000, 12000), "7-10.5k": band(7000, 10500), "10.5-12.5k": band(10500, 12500)},
                         peak_Nm=t.max(), peak_kW=(t * r * np.pi / 30 / 1000).max(), lower_peak=pk(5000, 7250), upper_peak=pk(7750, 10000),
                         rms_7_10k=np.sqrt(np.mean((t - d)[(r >= 7000) & (r <= 10000)] ** 2)), rms_5p5up=np.sqrt(np.mean((t - d)[r >= 5500] ** 2)),
                         max_gain_pct=((t / b - 1) * 100).max(), at=r[np.argmax(t / b)], max_loss_pct=((t / b - 1) * 100).min(), at_=r[np.argmin(t / b)]))
T = pd.DataFrame(rows); pd.set_option("display.width", 250); print(T.round(2).to_string(index=False)); T.round(3).to_csv(os.path.join(vc.OUT, "primary_dia" + ("_" + TAG if TAG else "") + "_bands.csv"), index=False)
jn = "as modelled" if not TAG else "calibrated walls"
if (jn, "p150") in CUR:
    r = CUR[(jn, "p125")][0]; print(pd.DataFrame({c: CUR[(jn, c)][1] for c in NAMES if (jn, c) in CUR}, index=r).assign(dyno=np.interp(r, dy.rpm, dy.Nm)).loc[4000:12500:2].round(1).T.to_string())
    fig, ax = plt.subplots(1, 2, figsize=(15, 6)); m = (dy.rpm >= 5500) & (dy.rpm <= 12500); ax[0].plot(dy.rpm[m], dy.Nm[m], color=INK, lw=2.6, label="dyno (1.25 in, real car)")
    for c in NAMES:
        if (jn, c) not in CUR: continue
        r, t, _ = CUR[(jn, c)]; ax[0].plot(r, t, color=COL[c], label=NAMES[c])
        if c != "p125": ax[1].plot(r, (t / CUR[(jn, "p125")][1] - 1) * 100, color=COL[c], label=NAMES[c])
    ax[1].axhline(0, color=MUTED, lw=1); ax[0].set_ylabel("wheel torque, N.m"); ax[1].set_ylabel("torque vs 1.25 in primaries, %")
    ax[0].set_title("torque curve", loc="left", fontsize=11.5, color=INK, pad=8); ax[1].set_title("change against the CAD exhaust", loc="left", fontsize=11.5, color=INK, pad=8)
    for a in ax: a.set_xlabel("engine speed, rpm")
    hd, lb = ax[0].get_legend_handles_labels(); fig.legend(hd, lb, loc="upper left", bbox_to_anchor=(0.008, 1 - 0.95 / fig.get_figheight()), ncol=len(lb), fontsize=10, labelcolor=INK2, handlelength=1.6, columnspacing=2.2)
    head(fig, "Exhaust primary diameter: 1.25 in against 1.5 in", "p150 scales every diameter downstream of the primaries by 1.176; the head port is unchanged.", NOTE)
    fig.subplots_adjust(left=0.055, right=0.985, top=TOP(fig) - 0.14, bottom=0.12, wspace=0.18); vc.save(fig, "A6_primary_diameter" + ("_" + TAG if TAG else "") + ".png")
