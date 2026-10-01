"""Finding 0039 addendum: every VRLI start/end combination.

Retracted runner 108-248 mm above the head flange (5 mm steps) x stroke 0-200 mm (5 mm steps), extended end capped at
408 mm (the simulated grid edge), four plenum boxes. Every combo gets the full scoring (worst case over bands, duty
cycles and 4 % rpm-shift checks) plus a band breakdown: 4-6k, 7-10.5k (driver band), 10.5-12.5k (top end).
Writes charts/combos/*.png and combos_all.csv.
"""
from vrli_common import *
from matplotlib.colors import TwoSlopeNorm
from scipy.optimize import brentq

import vrli_common
OUT = vrli_common.OUT = os.path.join(H, "charts", "combos"); os.makedirs(OUT, exist_ok=True)   # save() writes to vrli_common.OUT
RET = list(range(-140, 1, 5))                     # retracted = 248 + lo: 108 .. 248 mm
STK = list(range(0, 201, 5))
GRID_END = S.exts[-1]                             # +160 -> 408 mm
S_MASS = brentq(lambda s: mass(s) - 1.5, 50, 300) # stroke where the CDR mass model hits C2 (1.5 kg)
S_HEIGHT = TODAY_PLENUM_H - CLEAR                 # 80 mm: longest stroke inside today's 120 mm plenum height

rows = []
for V in BOXES:
    for lo in RET:
        for st in STK:
            if lo + st > GRID_END or V - BORE_A * st < S.Vs[0]: continue
            T, _ = vrli(V, lo, st, W_P1)
            sc = {"6-12k": band(T, 6000, 12000), "4-6k": band(T, 4000, 6000), "7-10.5k": band(T, 7000, 10500), "10.5-12.5k": band(T, 10500, 12500)}
            ws = [sc["6-12k"], sc["7-10.5k"]]
            for n, w in DC.items():
                Tw, _ = vrli(V, lo, st, np.maximum(w, 1e-4)); a, b = duty(Tw, w), duty(Tw, w, True); sc[n] = a; ws += [a, b]
            sc["worst"] = min(ws); sc["duty_mean"] = float(np.mean([sc[n] for n in DC]))
            rows.append(dict(V=V, retracted=OUTSIDE0 + lo, extended=OUTSIDE0 + lo + st, stroke=st, mass_kg=mass(st),
                             plenum_h_mm=max(st + CLEAR, TODAY_PLENUM_H), **sc))
X = pd.DataFrame(rows).round(3)
X.to_csv(os.path.join(OUT, "combos_all.csv"), index=False)
print(len(X), "combos; mass limit at", round(S_MASS), "mm stroke")

DIV = LinearSegmentedColormap.from_list("div", ["#b02c2c", "#e34948", "#f2a7a6", "#f0efec", "#86b6ef", "#2a78d6", "#0d366b"])
ASKED = (180, 80)
def iso(ax, s_, lbl, style="-"):
    x0 = max(OUTSIDE0 - 140 + s_, OUTSIDE0 - 140); x1 = min(OUTSIDE0 + s_, OUTSIDE0 + 160)
    if x1 <= x0: return
    ax.plot([x0, x1], [x0 - s_, x1 - s_], color=INK2, lw=0.9, ls=style, zorder=4)
    ax.text(x0 + 1, x0 - s_ - 3, lbl, fontsize=8, color=INK2, va="top", ha="left", rotation=38)

METRICS = [("worst", "worst case over every scoring (the robust number)"), ("6-12k", "6-12k average (P1, dyno-style)"),
           ("7-10.5k", "7-10.5k driver band (midrange)"), ("10.5-12.5k", "10.5-12.5k top end")]
for key, nm in METRICS:
    vmin, vmax = np.nanmin(X[key]), np.nanmax(X[key])
    norm = TwoSlopeNorm(0, min(vmin, -0.5), max(vmax, 0.5))
    fig, axs = plt.subplots(2, 2, figsize=(16, 13), sharex=True, sharey=True)
    for ax, V in zip(axs.flat, BOXES):
        x = X[X.V == V].pivot_table(index="retracted", columns="extended", values=key)
        im = ax.pcolormesh(x.columns, x.index, x.values, cmap=DIV, norm=norm, shading="nearest")
        for s_, lbl, stl in [(50, "50 mm", ":"), (S_HEIGHT, f"{S_HEIGHT:.0f} (fits)", "--"), (100, "100", ":"), (150, "150", ":"), (S_MASS, f"{S_MASS:.0f} (1.5 kg)", "--")]:
            iso(ax, s_, lbl, stl)
        b = X[X.V == V].loc[lambda t: t.groupby("stroke")[key].idxmax()]
        b = b[b.stroke.isin(range(10, 201, 10))]
        ax.plot(b.extended, b.retracted, "o", ms=5, mfc=INK, mec=SURF, mew=1.2, zorder=5, label="best start for each stroke")
        a = X[(X.V == V) & (X.stroke == ASKED[1])].iloc[(X[(X.V == V) & (X.stroke == ASKED[1])].retracted - ASKED[0]).abs().argsort()[:1]]
        ax.plot(a.extended, a.retracted, "o", ms=13, mfc="none", mec=INK, mew=2, zorder=6)
        ax.annotate(f"180+80: {a[key].iloc[0]:+.1f} %", (a.extended.iloc[0], a.retracted.iloc[0]), xytext=(10, -16), textcoords="offset points", fontsize=9, color=INK,
                    bbox=dict(boxstyle="round,pad=0.2", fc=SURF, ec="none", alpha=0.9))
        best = X[X.V == V].sort_values(key).iloc[-1]
        ax.set_title(f"{V:g} L box - best {best[key]:+.1f} % at {best.retracted:.0f} -> {best.extended:.0f} mm", loc="left", fontsize=12, fontweight="semibold", color=INK)
        ax.grid(False); ax.set_xlim(OUTSIDE0 - 145, OUTSIDE0 + 175); ax.set_ylim(OUTSIDE0 - 185, OUTSIDE0 + 3)
    for ax in axs[-1]: ax.set_xlabel("extended runner length above flange (mm)")
    for ax in axs[:, 0]: ax.set_ylabel("retracted runner length above flange (mm)")
    axs[0, 0].legend(loc="lower right", fontsize=9)
    cax = fig.add_axes([0.92, 0.2, 0.012, 0.55]); cb = fig.colorbar(im, cax=cax); cb.set_label(f"{key} gain vs today (%)", color=INK2); cb.outline.set_visible(False)
    head(fig, f"Every start/end combination: {nm}", "Cell = VRLI retracting to the row's length and extending to the column's; diagonals = constant stroke (mm); ring = 180 -> 260; '80 (fits)' = longest stroke inside today's 120 mm plenum height. Vertical bands = extended length drives it; horizontal = retracted length does.", NOTE)
    fig.subplots_adjust(left=0.06, right=0.9, top=TOP(fig) - 0.01, bottom=0.06, hspace=0.12, wspace=0.05)
    save(fig, f"C_map_{key.replace('.', 'p').replace('-', '_')}.png")

# ---------------- midrange vs top-end trade-off (2.75 L) ----------------
for V in (2.75, 1.44):
    x = X[(X.V == V) & (X.stroke > 0)]
    fig, ax = plt.subplots(figsize=(14, 8.2))
    sc_ = ax.scatter(x["10.5-12.5k"], x["7-10.5k"], c=x.stroke, cmap=SEQ, s=16, edgecolors="none", vmin=0, vmax=200, zorder=2)
    f0 = X[(X.V == V) & (X.stroke == 0)]; ax.scatter(f0["10.5-12.5k"], f0["7-10.5k"], s=26, marker="s", color=MUTED, zorder=3, label="fixed runners (stroke 0)")
    for (r_, s_), lab in [((180, 80), "180 -> 260"), ((208, 80), "208 -> 288"), ((238, 80), "238 -> 318"), ((248, 150), "248 -> 398"), ((208, 150), "208 -> 358")]:
        p = x[(abs(x.retracted - r_) < 3) & (x.stroke == s_)].iloc[0]
        ax.plot(p["10.5-12.5k"], p["7-10.5k"], "o", ms=11, mfc="none", mec=INK, mew=1.8, zorder=4)
        ax.annotate(f"{lab}\nworst {p.worst:+.1f} %", (p["10.5-12.5k"], p["7-10.5k"]), xytext=(9, 6), textcoords="offset points", fontsize=9, color=INK)
    ax.axhline(0, color=INK2, lw=0.8); ax.axvline(0, color=INK2, lw=0.8)
    ax.set_xlabel("top end 10.5-12.5k gain (%)"); ax.set_ylabel("midrange 7-10.5k gain (%)")
    cb = fig.colorbar(sc_, ax=ax, pad=0.01); cb.set_label("stroke (mm)", color=INK2); cb.outline.set_visible(False); ax.legend(loc="lower left", fontsize=9)
    head(fig, f"Midrange or top end? Every combination, {V:g} L box", "Each dot is one start/end combo. Up = midrange (where the real duty cycles live), right = top end. Short retracted lengths buy top end; long ones buy midrange.", NOTE)
    fig.subplots_adjust(left=0.07, right=0.99, top=TOP(fig) - 0.01, bottom=0.09); save(fig, f"C_tradeoff_{str(V).replace('.', 'p')}L.png")

# ---------------- best achievable per objective vs stroke (2.75 L) ----------------
fig, ax = plt.subplots(figsize=(14, 6.6))
OBJ = [("worst", "worst case", "#2a78d6"), ("6-12k", "6-12k", "#eb6834"), ("7-10.5k", "7-10.5k midrange", "#1baf7a"), ("10.5-12.5k", "10.5-12.5k top end", "#eda100")]
for key, lab, c in OBJ:
    b = X[X.V == 2.75].groupby("stroke")[key].max()
    ax.plot(b.index, b.values, color=c, lw=2.2, marker="o", ms=4, mec=SURF, mew=1)
    ax.text(203, b.values[-1], lab, color=INK, fontsize=10, va="center")
ax.axvline(S_HEIGHT, color=INK2, ls="--", lw=1); ax.text(S_HEIGHT + 2, ax.get_ylim()[1] * 0.97, "fits today's plenum height", fontsize=9, color=INK2, va="top")
ax.axvline(S_MASS, color=INK2, ls="--", lw=1); ax.text(S_MASS + 2, ax.get_ylim()[1] * 0.97, "1.5 kg mass limit", fontsize=9, color=INK2, va="top")
ax.set_xlim(-3, 235); ax.set_xlabel("stroke (mm)"); ax.set_ylabel("best achievable gain vs today (%)")
ax.legend(handles=[plt.Line2D([], [], color=c, lw=2.2, label=l) for _, l, c in OBJ], loc="upper left", fontsize=9.5)
head(fig, "Best you can get at each stroke, by objective (2.75 L box)", "Each line re-optimises the start point for its own objective, so the four lines are four different designs at each stroke.", NOTE)
fig.subplots_adjust(left=0.06, right=0.97, top=TOP(fig) - 0.02, bottom=0.11); save(fig, "C_best_by_objective_2p75L.png")

# ---------------- lookup grid (worst case), 2.75 L ----------------
RR = list(range(128, 249, 20)); SS = [0, 25, 50, 80, 100, 125, 150, 175, 200]
fig, axs = plt.subplots(1, 2, figsize=(17, 6.4))
for ax, (key, nm) in zip(axs, [("worst", "worst case"), ("10.5-12.5k", "top end 10.5-12.5k")]):
    M = np.full((len(RR), len(SS)), np.nan)
    for i, r_ in enumerate(RR):
        for j, s_ in enumerate(SS):
            p = X[(X.V == 2.75) & (abs(X.retracted - r_) < 3) & (X.stroke == s_)]
            if len(p): M[i, j] = p[key].iloc[0]
    lim = np.nanmax(np.abs(M)); ax.pcolormesh(np.arange(len(SS)), np.arange(len(RR)), M, cmap=DIV, norm=TwoSlopeNorm(0, -lim, lim), shading="nearest"); ax.grid(False)
    for i in range(len(RR)):
        for j in range(len(SS)):
            if np.isfinite(M[i, j]): ax.text(j, i, f"{M[i, j]:+.1f}\n{RR[i]}->{RR[i] + SS[j]}", ha="center", va="center", fontsize=8.3, color="white" if abs(M[i, j]) > 0.62 * lim else INK)
    ax.set_xticks(range(len(SS))); ax.set_xticklabels([f"{s}" for s in SS]); ax.set_yticks(range(len(RR))); ax.set_yticklabels([f"{r}" for r in RR])
    ax.set_xlabel("stroke (mm)"); ax.set_ylabel("retracted length above flange (mm)")
    ax.set_title(f"{nm} (%), 2.75 L box", loc="left", fontsize=12, fontweight="semibold", color=INK)
head(fig, "Lookup: retracted length x stroke (2.75 L box)", "Each cell: gain vs today and the runner range (retracted -> extended, mm above flange). Blank = extends past 408 mm (outside the simulated grid). Full data: charts/combos/combos_all.csv.", NOTE)
fig.subplots_adjust(left=0.05, right=0.99, top=TOP(fig) - 0.03, bottom=0.11, wspace=0.12); save(fig, "C_lookup_2p75L.png")

top = X.sort_values("worst", ascending=False).groupby("V").head(3)
print(top[["V", "retracted", "extended", "stroke", "worst", "6-12k", "7-10.5k", "10.5-12.5k", "mass_kg"]].to_string(index=False))
