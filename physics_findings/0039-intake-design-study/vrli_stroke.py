"""Finding 0039 addendum: VRLI with less stroke. Decision charts for stroke vs gain vs cost.

VRLI-in-plenum (CDR Concept A): the outside runner is fixed at `lo` (<= as-built 248 mm above the flange) and the
trumpets telescope up to `stroke` mm into the plenum box. Scores as in candidates.py: 6-12k, driver 7-10.5k, four
on-throttle duty cycles, each duty cycle also with the model's rpm axis shifted 4 %; worst = min of all.
Costs: CDR mass model (0037), plenum height needed = stroke + 40 mm clearance (today's plenum is 120 mm tall),
throttle tip-in t90 for the box volume (6000 rpm snap, as-built runner).
"""
import os, glob, json, math, numpy as np, pandas as pd
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap
import core
from core import BORE_A, OUTSIDE0

H = core.H; OUT = os.path.join(H, "charts", "stroke"); os.makedirs(OUT, exist_ok=True)
d = core.load(); S = core.Surface(d); R = S.rpm; TODAY = core.today()(R)
BOXES = [1.44, 2.0, 2.75, 3.5]
STROKES = list(range(0, 151, 5))
LOS = list(range(-190, 1, 5))
TODAY_PLENUM_H = 120.0; CLEAR = 40.0

DC = {}
for f in sorted(glob.glob(os.path.join(H, "data", "duty_*.csv"))):
    x = pd.read_csv(f)
    if "frac" not in x: continue
    w = np.interp(R, (x.rpm_lo + x.rpm_hi) / 2, x.frac, left=0, right=0); DC[os.path.basename(f)[5:-4]] = w / w.sum()
DC_LABEL = {"ld416_ax": "4-16 AX, one gear (5.5k median)", "josh_0426": "Josh AX 4-26 (7.4k)",
            "ld416_optshift": "4-16 re-driven, ideal shifts (7.7k)", "ld419_endu": "4-19 endurance (8.6k)"}
W_P1 = np.where((R >= 6000) & (R <= 12000), 1.0, 0.15)
shifted = lambda T: np.interp(np.minimum(R * 1.04, R[-1]), R, T)
def band(T, lo, hi):
    m = (R >= lo) & (R <= hi); return (np.trapezoid((TODAY * T / S.base)[m], R[m]) / np.trapezoid(TODAY[m], R[m]) - 1) * 100
def duty(T, w, sh=False):
    a, b = (shifted(T), shifted(S.base)) if sh else (T, S.base)
    return (np.sum(w * TODAY * a / b) / np.sum(w * TODAY) - 1) * 100
def vrli(Venv, lo, st, w):
    if st == 0:
        return S.at(Venv, lo), np.full(len(R), float(lo))
    pos = np.arange(lo, lo + st + 1e-9, 5.0); Veff = Venv - BORE_A * (pos - lo)
    T = np.array([S.at(max(v, 0.3), p) for v, p in zip(Veff, pos)]).T
    step = max(1, int(round(200.0 / 3000.0 * (R[1] - R[0]) / 5.0)))
    path = core.dp_schedule(T / S.base[:, None], w, step)
    return T[np.arange(len(R)), path], pos[path]
def mass(st): return 0.0 if st == 0 else 0.30 + 0.42 * st / 100 + 0.30 * (st / 100) ** 0.7

# tip-in t90 by box volume (6000 rpm, as-built runner)
TI = {}
for l in open(os.path.join(H, "tipin_c160.ndjson")):
    x = json.loads(l)
    if x["rpm"] != 6000 or x["ext"] != 0 or "_L1.00_" not in x["cfg"]: continue
    r0 = x["rows"][0]; rr = x["rows"][1:]
    t = np.array([0] + [r["t"] for r in rr]); f = np.array([0] + [r["bt"] / r0["bt_ss"] for r in rr])
    k = next(i for i in range(len(f)) if (f[i:] >= 0.9).all())
    TI[float(x["cfg"].split("_")[0][1:])] = 1000 * (t[k - 1] + (0.9 - f[k - 1]) / (f[k] - f[k - 1]) * (t[k] - t[k - 1]))
tv = sorted(TI); t90 = lambda V: float(np.interp(math.log(V), np.log(tv), [TI[v] for v in tv]))

rows = []
for V in BOXES:
    for st in STROKES:
        for lo in LOS:
            if lo + st > S.exts[-1] or V - BORE_A * st < S.Vs[0]: continue
            T, sch = vrli(V, lo, st, W_P1)
            sc = {"P1 6-12k": band(T, 6000, 12000), "driver 7-10.5k": band(T, 7000, 10500)}
            for n, w in DC.items():
                Tw, _ = vrli(V, lo, st, np.maximum(w, 1e-4))
                sc[n] = duty(Tw, w); sc[n + " shift4"] = duty(Tw, w, True)
            rows.append(dict(V=V, stroke=st, lo=lo, retracted=OUTSIDE0 + lo, extended=OUTSIDE0 + lo + st, **sc))
X = pd.DataFrame(rows)
MET = [c for c in X.columns if c not in ("V", "stroke", "lo", "retracted", "extended")]
X["worst"] = X[MET].min(axis=1); X["duty_mean"] = X[list(DC)].mean(axis=1)
X.round(3).to_csv(os.path.join(OUT, "stroke_sweep_all.csv"), index=False)
B = X.loc[X.groupby(["V", "stroke"]).worst.idxmax()].reset_index(drop=True)          # best placement per (box, stroke)
B["mass_kg"] = B.stroke.map(mass); B["plenum_h_mm"] = np.maximum(B.stroke + CLEAR, TODAY_PLENUM_H)
B["tipin_t90_ms"] = B.V.map(t90)
B.round(2).to_csv(os.path.join(OUT, "stroke_best.csv"), index=False)

# ---------------- style (dataviz reference palette, light) ----------------
SURF, INK, INK2, MUTED, GRID = "#fcfcfb", "#0b0b0b", "#52514e", "#8a8984", "#e6e5e0"
BOXC = {1.44: "#2a78d6", 2.0: "#eb6834", 2.75: "#1baf7a", 3.5: "#eda100"}       # validated adjacent set, direct-labelled
RAMP = ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#0d366b"]                  # validated ordinal (5 strokes)
SEQ = LinearSegmentedColormap.from_list("seq", ["#cde2fb", "#86b6ef", "#3987e5", "#1c5cab", "#0d366b"])
plt.rcParams.update({"font.family": "Segoe UI", "font.size": 10.5, "axes.edgecolor": MUTED, "axes.labelcolor": INK2,
                     "xtick.color": INK2, "ytick.color": INK2, "axes.facecolor": SURF, "figure.facecolor": SURF,
                     "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.8, "axes.spines.top": False,
                     "axes.spines.right": False, "lines.linewidth": 2, "legend.frameon": False})
def head(fig, t, sub, note=None):
    h = fig.get_figheight()
    fig.text(0.012, 1 - 0.25 / h, t, fontsize=17, fontweight="bold", color=INK, va="top")
    fig.text(0.012, 1 - 0.62 / h, sub, fontsize=11, color=INK2, va="top")
    if note: fig.text(0.012, 0.012, note, fontsize=8.6, color=MUTED)
TOP = lambda fig: 1 - 1.05 / fig.get_figheight()
NOTE = ("1D engine model (160-cell plenum), neutral tune, scaled to the calibrated SDM26 sim. VRLI = trumpets telescoping inside the plenum box; "
        "retracted runner <= today's 248 mm above the head flange (+80 mm port). Schedule limited to 200 mm/s at 3000 rpm/s sweeps.")
def save(fig, n): fig.savefig(os.path.join(OUT, n), dpi=150); plt.close(fig); print("wrote", n)

# ---------------- 1. gain vs stroke, per box (the headline) ----------------
fig, axs = plt.subplots(1, 2, figsize=(16, 6.4), sharey=True)
for ax, (col, nm) in zip(axs, [("worst", "Worst case over every scoring (the robust number)"), ("P1 6-12k", "6-12k average (the CDR's P1 metric, dyno-style)")]):
    ax.axhspan(5, 8, color="#eef5ee", zorder=0); ax.axhline(5, color=INK2, lw=1, ls="--", zorder=1)
    ax.text(2, 5.08, "P1 target +5 %", fontsize=9, color=INK2, ha="left", va="bottom")
    ax.axvspan(0, TODAY_PLENUM_H - CLEAR, color="#f4f3ef", zorder=0)
    ax.text(2, 7.75, "stroke fits today's 120 mm-tall plenum", fontsize=9, color=INK2, va="top")
    for V in BOXES:
        b = B[B.V == V].sort_values("stroke")
        ax.plot(b.stroke, b[col], color=BOXC[V], lw=2.2, marker="o", ms=5.5, mec=SURF, mew=1.5, zorder=3)
        y = b[col].iloc[-1]; ax.text(152.5, y, f"{V:g} L box", color=INK, fontsize=10, va="center")
    ax.set_xlim(-3, 168); ax.set_ylim(-0.5, 8); ax.set_xlabel("VRLI stroke (mm)")
    ax.set_title(nm, loc="left", fontsize=12.5, fontweight="semibold", color=INK)
axs[0].set_ylabel("torque gain vs today's intake (%)")
h = [plt.Line2D([], [], color=BOXC[V], marker="o", lw=2.2, label=f"{V:g} L plenum box") for V in BOXES]
axs[1].legend(handles=h, loc="lower right", fontsize=9.5)
slope = {V: np.polyfit(B[(B.V == V) & (B.stroke >= 20)].stroke, B[(B.V == V) & (B.stroke >= 20)].worst, 1)[0] * 10 for V in BOXES}
head(fig, "How much stroke do you need?", f"Best placement at every stroke, per plenum box (stroke 0 = best fixed runner). No knee: the worst case grows about +{min(slope.values()):.2f} to +{max(slope.values()):.2f} pts per 10 mm, all the way to 150 mm.", NOTE)
fig.subplots_adjust(left=0.05, right=0.97, top=TOP(fig) - 0.02, bottom=0.12, wspace=0.08); save(fig, "S1_gain_vs_stroke.png")

# ---------------- 2. marginal value of stroke ----------------
fig, axs = plt.subplots(1, 3, figsize=(17, 5.2))
for V in BOXES:
    b = B[B.V == V].sort_values("stroke")
    axs[0].plot(b.stroke, b.worst.diff() / b.stroke.diff() * 10, color=BOXC[V], marker="o", ms=5, mec=SURF, mew=1.2, label=f"{V:g} L box")
axs[0].axhline(0, color=INK2, lw=0.8); axs[0].set_xlabel("stroke (mm)"); axs[0].set_ylabel("worst-case gain added by the last 10 mm (pts)")
axs[0].set_title("Marginal gain per 10 mm of stroke", loc="left", fontsize=12, fontweight="semibold", color=INK); axs[0].legend(fontsize=9)
st = np.array(STROKES)
axs[1].plot(st, [mass(s) for s in st], color=INK, marker="o", ms=5, mec=SURF, mew=1.2)
axs[1].axhline(1.5, color=INK2, ls="--", lw=1); axs[1].text(2, 1.52, "C2 limit 1.5 kg", fontsize=9, color=INK2, va="bottom")
axs[1].set_xlabel("stroke (mm)"); axs[1].set_ylabel("added mass (kg), CDR estimate"); axs[1].set_ylim(0, 1.7)
axs[1].set_title("Mass cost", loc="left", fontsize=12, fontweight="semibold", color=INK)
axs[2].plot(st, np.maximum(st + CLEAR, TODAY_PLENUM_H), color=INK, marker="o", ms=5, mec=SURF, mew=1.2)
axs[2].axhline(TODAY_PLENUM_H, color=INK2, ls="--", lw=1); axs[2].text(2, TODAY_PLENUM_H + 2, "today's plenum height 120 mm", fontsize=9, color=INK2, va="bottom")
axs[2].set_xlabel("stroke (mm)"); axs[2].set_ylabel("plenum height needed (mm)"); axs[2].set_ylim(0, 210)
axs[2].set_title("Packaging cost", loc="left", fontsize=12, fontweight="semibold", color=INK)
head(fig, "What each extra 10 mm of stroke buys, and what it costs", "Left: worst-case gain added per 10 mm (best placement re-chosen at each stroke; noisy because the best placement jumps). Middle/right: mass (CDR model) and plenum height (stroke + 40 mm, never below today's 120 mm).", NOTE)
fig.subplots_adjust(left=0.05, right=0.99, top=TOP(fig) - 0.04, bottom=0.13, wspace=0.25); save(fig, "S2_marginal_and_costs.png")

# ---------------- 3. placement map (2.75 L box): retracted length x stroke ----------------
for Vp in (2.75, 1.44):
    x = X[(X.V == Vp) & (X.lo >= -120)].pivot_table(index="lo", columns="stroke", values="worst")
    fig, ax = plt.subplots(figsize=(14.5, 7.4))
    vmax = np.nanmax(x.values); im = ax.pcolormesh(np.arange(len(x.columns)), np.arange(len(x.index)), x.values, cmap=SEQ, vmin=0, vmax=vmax, shading="nearest")
    for j, s_ in enumerate(x.columns):
        i = int(np.nanargmax(x[s_].values)); ax.plot(j, i, marker="o", ms=7, mfc=INK, mec=SURF, mew=1.5)
    yt = [k for k, l in enumerate(x.index) if (OUTSIDE0 + l) % 20 < 5 or l == 0]
    ax.set_yticks(yt); ax.set_yticklabels([f"{OUTSIDE0 + x.index[k]:.0f}" for k in yt])
    ax.set_xticks(range(len(x.columns))); ax.set_xticklabels([f"{c}" for c in x.columns]); ax.grid(False)
    ax.set_xlabel("VRLI stroke (mm) - the trumpet travels this far into the plenum"); ax.set_ylabel("retracted runner length above the head flange (mm)")
    cb = fig.colorbar(im, ax=ax, pad=0.01); cb.set_label("worst-case gain vs today (%)", color=INK2); cb.outline.set_visible(False)
    head(fig, f"Where to put a short stroke ({Vp:g} L box)", "Colour = worst-case gain for a runner that retracts to the row's length and extends by the column's stroke. Dot = best retracted length. Short strokes want to start at or just under today's 248 mm.", NOTE)
    fig.subplots_adjust(left=0.07, right=0.99, top=TOP(fig) - 0.02, bottom=0.12); save(fig, f"S3_placement_map_{str(Vp).replace('.', 'p')}L.png")

# ---------------- 4. torque curves + ECU schedule for short strokes (2.75 L) ----------------
PICK = [25, 50, 75, 100, 150]
fig, axs = plt.subplots(2, 1, figsize=(15, 10.5), sharex=True, gridspec_kw=dict(height_ratios=[1.5, 1]))
ax = axs[0]; ax.axvspan(6, 12, color="#f4f3ef", zorder=0)
ax.plot(R / 1000, TODAY, color=INK, lw=2.6, label="today (as-built, calibrated sim)", zorder=5)
for s_, c in zip(PICK, RAMP):
    b = B[(B.V == 2.75) & (B.stroke == s_)].iloc[0]; T, sch = vrli(2.75, b.lo, s_, W_P1)
    y = TODAY * T / S.base
    ax.plot(R / 1000, y, color=c, lw=2.2, zorder=4, label=f"{s_} mm stroke: {b.retracted:.0f}->{b.extended:.0f} mm, 6-12k {b['P1 6-12k']:+.1f} %, worst {b.worst:+.1f} %")
    axs[1].plot(R / 1000, OUTSIDE0 + sch, color=c, lw=2.2, drawstyle="steps-mid")
ax.set_ylabel("wheel torque (N·m)"); ax.legend(fontsize=9.5, loc="lower center", ncol=2)
ax.set_title("Torque, 2.75 L box, best placement per stroke", loc="left", fontsize=12.5, fontweight="semibold", color=INK)
axs[1].axhline(OUTSIDE0, color=INK, lw=1.2, ls="--"); axs[1].text(4.05, OUTSIDE0 + 3, "today's runner 248 mm", fontsize=9, color=INK2)
axs[1].set_ylabel("runner length above flange (mm)"); axs[1].set_xlabel("engine speed (krpm)")
axs[1].set_title("ECU schedule the actuator follows (up-sweep, 200 mm/s)", loc="left", fontsize=12.5, fontweight="semibold", color=INK)
head(fig, "Short-stroke VRLI options, side by side", "Darker = longer stroke. The gains sit at 6.5-9.5k and 10.5-11.5k, where today's runner is off-tune; short strokes capture the first region.", NOTE)
fig.subplots_adjust(left=0.06, right=0.99, top=TOP(fig) - 0.02, bottom=0.07, hspace=0.18); save(fig, "S4_short_stroke_curves.png")

# ---------------- 5. robustness: every score for each short-stroke option (2.75 L) ----------------
fig, ax = plt.subplots(figsize=(15, 7.6))
labels = ["P1 6-12k", "driver 7-10.5k"] + list(DC)
names = {"P1 6-12k": "6-12k dyno band", "driver 7-10.5k": "7-10.5k driver band", **DC_LABEL}
for k, s_ in enumerate([0] + PICK):
    b = B[(B.V == 2.75) & (B.stroke == s_)].iloc[0]
    vals = [b[l] for l in labels] + [b[l + " shift4"] for l in DC]
    ax.plot([min(vals), max(vals)], [k, k], color=GRID, lw=9, solid_capstyle="round", zorder=1)
    for j, l in enumerate(labels):
        ax.plot(b[l], k, "o", ms=9, color=["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"][j], mec=SURF, mew=1.5, zorder=3)
    ax.text(max(vals) + 0.15, k, f"worst {b.worst:+.1f} %", va="center", fontsize=9.5, color=INK)
ax.set_yticks(range(len(PICK) + 1)); ax.set_yticklabels(["fixed runner (0)"] + [f"{s} mm stroke" for s in PICK]); ax.invert_yaxis()
ax.axvline(0, color=INK2, lw=0.8); ax.axvline(5, color=INK2, lw=1, ls="--"); ax.set_xlabel("torque gain vs today (%)")
hh = [plt.Line2D([], [], ls="", marker="o", ms=9, color=c, label=names[l]) for c, l in zip(["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"], labels)]
hh.append(plt.Line2D([], [], color=GRID, lw=9, label="range incl. 4 % rpm-shift checks"))
ax.legend(handles=hh, loc="upper center", bbox_to_anchor=(0.5, -0.12), fontsize=9.3, ncol=4)
ax.set_xlim(-0.2, 7.0)
head(fig, "Is it robust to how the car is driven? (2.75 L box)", "Each dot is one way of scoring the same design. A tight row means the gain holds whether the car is driven at 5.5k or 8.6k median on-throttle rpm.", NOTE)
fig.subplots_adjust(left=0.1, right=0.97, top=TOP(fig) - 0.02, bottom=0.25); save(fig, "S5_robustness.png")

# ---------------- 6. decision table ----------------
cand = []
for V in BOXES:
    for s_ in [0, 30, 50, 80, 100, 150]:
        b = B[(B.V == V) & (B.stroke == s_)]
        if len(b): cand.append(b.iloc[0])
C = pd.DataFrame(cand)
fig, ax = plt.subplots(figsize=(15.5, 0.34 * len(C) + 1.9)); ax.axis("off")
cols = ["box", "stroke", "runner in -> out", "6-12k", "worst case", "mass", "plenum height", "throttle t90"]
cell = [[f"{r.V:g} L", f"{r.stroke:.0f} mm", f"{r.retracted:.0f} -> {r.extended:.0f} mm" if r.stroke else f"{r.retracted:.0f} mm (fixed)",
         f"{r['P1 6-12k']:+.1f} %", f"{r.worst:+.1f} %", f"{r.mass_kg:.2f} kg" if r.stroke else "-", f"{r.plenum_h_mm:.0f} mm",
         f"{r.tipin_t90_ms:.0f} ms"] for _, r in C.iterrows()]
tb = ax.table(cellText=cell, colLabels=cols, cellLoc="center", colLoc="center", bbox=[0, 0, 1, 1])
tb.auto_set_font_size(False); tb.set_fontsize(10.5)
for (i, j), c in tb.get_celld().items():
    c.set_edgecolor(GRID); c.set_linewidth(0.8)
    if i == 0: c.set_text_props(color=INK, fontweight="semibold"); c.set_facecolor("#f0efec")
    else:
        r = C.iloc[i - 1]
        c.set_facecolor(SURF if BOXES.index(r.V) % 2 == 0 else "#f3f2ee")
        if j == 4 and r.worst >= 5: c.set_text_props(fontweight="bold", color=INK)
        if j == 6 and r.plenum_h_mm > TODAY_PLENUM_H: c.set_text_props(color=INK2)
head(fig, "Decision table: VRLI stroke options", f"Best placement per box and stroke, by worst-case gain. Bold = worst case >= +5 %. Throttle t90 = time to 90 % torque after a snap at 6000 rpm (today: {t90(1.44):.0f} ms).", NOTE)
fig.subplots_adjust(left=0.01, right=0.99, top=TOP(fig) - 0.015, bottom=0.045); save(fig, "S6_decision_table.png")
print(B[B.stroke.isin([0, 20, 30, 40, 50, 60, 80, 100, 120, 150])][["V", "stroke", "retracted", "extended", "P1 6-12k", "driver 7-10.5k", "worst", "duty_mean", "mass_kg", "plenum_h_mm", "tipin_t90_ms"]].round(2).to_string(index=False))
