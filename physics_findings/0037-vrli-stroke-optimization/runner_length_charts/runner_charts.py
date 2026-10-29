"""Runner-length study charts: estimated wheel torque for fixed runners and VRLI ranges vs today's calibrated sim and the team dyno.

Estimate = calibrated model today (sdm26_asbuilt_cal, wheel = brake x 0.94, logged tune) x the 1D model's torque ratio
T(runner, rpm) / T(as-built, rpm) from the finding-0037 surface (neutral tune, trumpets displace the plenum).
VRLI curves assume the ECU table is followed (dyno-rate sweep).
"""
import os, json, glob, numpy as np, pandas as pd
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap, TwoSlopeNorm

HERE = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(HERE, "charts"); os.makedirs(OUT, exist_ok=True)
SURF = r"C:/Users/nick5/helios-vrli/physics_findings/0037-vrli-stroke-optimization/out/E_short/surface.csv"
BASE = 328.1
# ---- data ----
s = pd.read_csv(SURF)
bad = s.groupby("ext_mm").converged.all(); s = s[s.ext_mm.isin(bad[bad].index)]
P = s.pivot(index="ext_mm", columns="rpm", values="brake_torque_Nm").dropna()
EXT = P.index.values.astype(float); RPM = P.columns.values.astype(float); TQ = P.values
cal = pd.DataFrame([json.loads(open(f).read()) for f in glob.glob(os.path.join(HERE, "..", "cal", "runs", "A_e94", "[0-9]*.json"))]).set_index("rpm").sort_index()
TODAY = np.interp(RPM, cal.index.values, cal.bt.values) * 0.94                 # calibrated wheel torque today
dy = pd.read_csv(r"C:/Users/nick5/helios/physics_findings/references/dyno/sdm26-team-dyno.csv")
dy = dy[(dy.rpm >= 4000) & (dy.rpm <= 12500)]
i0 = int(np.where(EXT == 0)[0][0])
RATIO = TQ / TQ[i0][None, :]
def fixed(ext): i = np.argmin(np.abs(EXT - ext)); return TODAY * RATIO[i]
def vrli(lo, hi):
    m = (EXT >= lo - 1e-9) & (EXT <= hi + 1e-9)
    # continuous positions between grid rows: evaluate on a 2 mm grid by linear interpolation in extension
    pos = np.arange(lo, hi + 1e-9, 2.0)
    R = np.array([[np.interp(p, EXT, RATIO[:, j]) for j in range(len(RPM))] for p in pos])
    k = R.argmax(0); return TODAY * R.max(0), BASE + pos[k]

# ---- style (dataviz reference palette, light) ----
INK, INK2, MUTED, GRID, SURFC = "#1f1e1c", "#52514e", "#8a8984", "#e6e5e0", "#ffffff"
BLUE = ["#86b6ef", "#3987e5", "#1c5cab", "#0d366b"]          # longer than today (blue arm, light->dark = longer)
RED = ["#b02c2c", "#e34948", "#ea7776", "#f2a7a6"]            # shorter than today (red arm, dark = shortest)
CAT = ["#2a78d6", "#eb6834", "#1baf7a"]                        # first three categorical slots (all-pairs safe)
plt.rcParams.update({"font.family": "Segoe UI", "font.size": 10, "axes.edgecolor": INK2, "axes.labelcolor": INK2,
                     "xtick.color": INK2, "ytick.color": INK2, "axes.facecolor": SURFC, "figure.facecolor": SURFC,
                     "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.8, "axes.spines.top": False,
                     "axes.spines.right": False, "lines.linewidth": 2, "legend.frameon": False})
def base_layers(ax):
    ax.plot(RPM / 1000, TODAY, color=INK, lw=2.6, label="today's sim, 328 mm (calibrated)", zorder=6)
    ax.plot(dy.rpm / 1000, dy.brake_torque_Nm, "o", color=INK, mfc="white", mew=1.6, ms=6, label="team dyno", zorder=7)
    ax.set_xlim(4, 12.6); ax.set_xlabel("engine speed (krpm)"); ax.set_ylabel("wheel torque (N·m)")
    ax.axvspan(6, 12, color="#f4f3ef", zorder=0)
def endlabel(ax, y, text, color):
    ax.annotate(text, (RPM[-1] / 1000, y[-1]), xytext=(6, 0), textcoords="offset points", va="center", fontsize=9, color=INK2)
def avg(y, lo=6000, hi=12000):
    m = (RPM >= lo) & (RPM <= hi); return (np.mean(y[m]) / np.mean(TODAY[m]) - 1) * 100
note = "Estimate = calibrated sim today × 1D-model torque ratio for each runner (neutral tune, trumpets displace plenum). Shaded = 6–12k P1 band."

# ---- 1. fixed runners ----
shorter = [-160, -120, -60, -30]; longer = [40, 80, 120, 160]
fig, axs = plt.subplots(1, 2, figsize=(15, 6.2), sharey=True)
for ax, exts, cols, title in [(axs[0], shorter, RED, "Shorter than today"), (axs[1], longer, BLUE, "Longer than today")]:
    base_layers(ax)
    for e, c in zip(exts, cols):
        y = fixed(e); ax.plot(RPM / 1000, y, color=c, lw=2, label=f"{BASE+e:.0f} mm   ({avg(y):+.1f}% avg 6–12k)")
    ax.set_title(title, loc="left", fontsize=13, color=INK, fontweight="semibold"); ax.legend(loc="upper right", fontsize=9, framealpha=0.92, frameon=True, edgecolor="none")
axs[0].set_ylim(18, 60)
fig.suptitle("Fixed runner length: estimated wheel torque", x=0.01, ha="left", fontsize=16, fontweight="bold", color=INK)
fig.text(0.01, 0.005, note, fontsize=8.5, color=MUTED); fig.tight_layout(rect=(0, 0.03, 1, 0.95))
fig.savefig(os.path.join(OUT, "1_fixed_runners_torque.png"), dpi=150); plt.close(fig)

# ---- 2. heatmap: % torque change vs runner length x rpm ----
G = (RATIO - 1) * 100
cmap = LinearSegmentedColormap.from_list("div", ["#b02c2c", "#e34948", "#f2a7a6", "#f0efec", "#86b6ef", "#2a78d6", "#0d366b"])
fig, ax = plt.subplots(figsize=(13, 7.2))
im = ax.pcolormesh(RPM / 1000, BASE + EXT, G, cmap=cmap, norm=TwoSlopeNorm(0, -25, 25), shading="nearest")
cs = ax.contour(RPM / 1000, BASE + EXT, G, levels=[-10, -5, 5, 10, 15], colors=[INK2], linewidths=0.7)
ax.clabel(cs, fmt=lambda v: f"{v:+.0f}%", fontsize=8)
ax.axhline(BASE, color=INK, lw=2); ax.text(4.08, BASE + 4, "today 328 mm", fontsize=9, color=INK, va="bottom")
best = BASE + EXT[G.argmax(0)]; ax.plot(RPM / 1000, best, color=INK, lw=1.4, ls="--"); ax.text(12.1, best[-1] + 6, "best length", fontsize=9, color=INK)
ax.set_xlabel("engine speed (krpm)"); ax.set_ylabel("runner length (mm)"); ax.grid(False)
cb = fig.colorbar(im, ax=ax, pad=0.015); cb.set_label("torque vs today's runner (%)")
ax.set_title("Where each runner length helps (blue) or hurts (red)", loc="left", fontsize=15, fontweight="bold", color=INK)
fig.text(0.01, 0.005, "1D model, neutral tune, trumpets displace plenum. Dashed = best fixed length at each rpm.", fontsize=8.5, color=MUTED)
fig.tight_layout(rect=(0, 0.03, 1, 1)); fig.savefig(os.path.join(OUT, "2_length_rpm_heatmap.png"), dpi=150); plt.close(fig)

# ---- 3. VRLI ranges ----
groupA = [(-140, -40), (-100, 0), (-60, 40)]         # 188-288, 228-328, 268-368
groupB = [(-20, 80), (15, 115), (60, 160)]            # 308-408, 343-443, 388-488
V = {}
fig, axs = plt.subplots(1, 2, figsize=(15, 6.2), sharey=True)
for ax, grp, title in [(axs[0], groupA, "Short-leaning ranges (100 mm stroke)"), (axs[1], groupB, "Long-leaning ranges (100 mm stroke)")]:
    base_layers(ax)
    for (lo, hi), c in zip(grp, CAT):
        y, L = vrli(lo, hi); V[(lo, hi)] = (y, L)
        ax.plot(RPM / 1000, y, color=c, lw=2.2, label=f"VRLI {BASE+lo:.0f}–{BASE+hi:.0f} mm   ({avg(y):+.1f}% avg 6–12k)")
    ax.set_title(title, loc="left", fontsize=13, color=INK, fontweight="semibold"); ax.legend(loc="upper right", fontsize=9, framealpha=0.92, frameon=True, edgecolor="none")
axs[0].set_ylim(18, 60)
fig.suptitle("Variable runners (VRLI): estimated wheel torque, ECU table followed", x=0.01, ha="left", fontsize=16, fontweight="bold", color=INK)
fig.text(0.01, 0.005, note + " Real actuator lag costs ~1.5–2 pts in low gears.", fontsize=8.5, color=MUTED)
fig.tight_layout(rect=(0, 0.03, 1, 0.95)); fig.savefig(os.path.join(OUT, "3_vrli_ranges_torque.png"), dpi=150); plt.close(fig)

# ---- 4. ECU runner-length tables ----
fig, axs = plt.subplots(1, 2, figsize=(15, 5.2), sharey=True)
for ax, grp, title in [(axs[0], groupA, "Short-leaning ranges"), (axs[1], groupB, "Long-leaning ranges")]:
    for (lo, hi), c in zip(grp, CAT):
        y, L = V[(lo, hi)]
        ax.fill_between(RPM / 1000, BASE + lo, BASE + hi, color=c, alpha=0.08, lw=0)
        ax.step(RPM / 1000, L, where="mid", color=c, lw=2.2, label=f"{BASE+lo:.0f}–{BASE+hi:.0f} mm")
    ax.axhline(BASE, color=INK, lw=1.4, ls=":"); ax.text(4.05, BASE + 3, "today 328", fontsize=8.5, color=INK2)
    ax.set_xlim(4, 12.6); ax.set_xlabel("engine speed (krpm)"); ax.set_title(title, loc="left", fontsize=13, color=INK, fontweight="semibold"); ax.legend(loc="upper right", fontsize=9)
axs[0].set_ylabel("runner length commanded (mm)")
fig.suptitle("What the plate does: best runner length at each rpm (dyno sweep)", x=0.01, ha="left", fontsize=16, fontweight="bold", color=INK)
fig.tight_layout(rect=(0, 0, 1, 0.93)); fig.savefig(os.path.join(OUT, "4_vrli_ecu_tables.png"), dpi=150); plt.close(fig)

# ---- 5. summary dot chart ----
rows = []
for e in [-160, -120, -90 + 10, -60, -30, 0, 40, 80, 120, 160]:
    if e < EXT.min() or e > EXT.max(): continue
    y = fixed(e); rows.append((f"fixed {BASE+e:.0f} mm", avg(y), avg(y, 7000, 10500), avg(y, 10500, 12500)))
for (lo, hi) in groupA + groupB + [(-60, 115)]:
    y, _ = vrli(lo, hi); rows.append((f"VRLI {BASE+lo:.0f}–{BASE+hi:.0f}", avg(y), avg(y, 7000, 10500), avg(y, 10500, 12500)))
S = pd.DataFrame(rows, columns=["design", "P1 6–12k", "driver band 7–10.5k", "high 10.5–12.5k"]).sort_values("P1 6–12k")
fig, ax = plt.subplots(figsize=(12, 7.6))
yv = np.arange(len(S))
for col, c, mk in zip(["P1 6–12k", "driver band 7–10.5k", "high 10.5–12.5k"], CAT, ["o", "s", "D"]):
    ax.scatter(S[col], yv, color=c, s=62, marker=mk, label=col, zorder=3, edgecolor="white", linewidth=1.5)
for y, (_, r) in zip(yv, S.iterrows()):
    lo, hi = r[["P1 6–12k", "driver band 7–10.5k", "high 10.5–12.5k"]].min(), r[["P1 6–12k", "driver band 7–10.5k", "high 10.5–12.5k"]].max()
    ax.plot([lo, hi], [y, y], color=GRID, lw=3, zorder=1)
ax.axvline(0, color=INK, lw=1.2); ax.axvline(5, color=INK2, lw=1, ls="--"); ax.text(5.1, len(S) - 0.6, "P1 target +5%", fontsize=9, color=INK2)
ax.set_yticks(yv); ax.set_yticklabels(S.design); ax.set_xlabel("average wheel torque vs today's runner (%)")
ax.legend(loc="lower right", fontsize=9); ax.grid(axis="y", visible=False)
ax.set_title("Every option at a glance, by rpm band", loc="left", fontsize=15, fontweight="bold", color=INK)
fig.tight_layout(); fig.savefig(os.path.join(OUT, "5_summary_by_band.png"), dpi=150); plt.close(fig)
S.round(2).to_csv(os.path.join(OUT, "summary_by_band.csv"), index=False)
print(S.round(2).to_string(index=False))
