"""Finding 0039: report for plenum2.py (plenum volume x height, static runner and VRLI 198-298 mm, venturi inertance on).

Every gain is against today's intake in the SAME runs: 1.44 L, 120 mm tall, fixed 248 mm runner. Scores are the 0039 set
(dyno bands, four on-throttle duty cycles and their 4 % rpm-shifted variants; worst = the minimum of all of them).
VRLI = five trumpet positions, schedule limited to one 25 mm step per 500 rpm (200 mm/s at 3000 rpm/s), P1-weighted.
Tip-in = full-torque time lost in a snap from 40 kPa (sum over cycles of 1 - torque / steady torque).
Only complete cases are scored, so this runs on a partial plenum2.ndjson. Writes charts/plenum2/.
"""
import json, os, numpy as np, pandas as pd
import core, vrli_common as vc
from vrli_common import plt, head, TOP, INK, INK2, MUTED, SURF, DC, DC_LABEL, W_P1

H = core.H; OUT = os.path.join(H, "charts", "plenum2"); os.makedirs(OUT, exist_ok=True); vc.OUT = OUT
D = pd.DataFrame([json.loads(l) for l in open(os.path.join(H, "plenum2.ndjson"))]); D = D[D.bt.notna()]
R = np.array(sorted(D.rpm.unique()), float); TODAY = core.today()(R); assert np.array_equal(R, vc.R)
POS = sorted(D[D.kind == "vrli"].pos.unique()); HEIGHTS = sorted(D.h.unique()); VOLS = sorted(D.V.unique())
HC = {120: "#2a78d6", 165: "#eb6834", 213: "#1baf7a"}; HL = {120: "120 mm tall (today)", 165: "165 mm tall", 213: "213 mm tall (today + 93)"}
NOTE = ("1D engine model, 160-cell plenum, venturi inertance 400 1/m, neutral tune. Gains vs today's intake in the same runs (1.44 L, 120 mm tall, fixed 248 mm runner). "
        "Runner lengths are above the head flange.")

def curve(V, h, kind, pos):
    x = D[(D.V == V) & (D.h == h) & (D.kind == kind) & (np.isclose(D.pos, pos))].drop_duplicates("rpm").set_index("rpm").bt.reindex(R)
    return x.values if x.notna().all() else None
BASE = curve(1.44, 120, "static", 248.1)
shifted = lambda T: np.interp(np.minimum(R * 1.04, R[-1]), R, T)
def band(T, lo, hi):
    m = (R >= lo) & (R <= hi); return (np.trapezoid((TODAY * T / BASE)[m], R[m]) / np.trapezoid(TODAY[m], R[m]) - 1) * 100
def duty(T, w, sh=False):
    a, b = (shifted(T), shifted(BASE)) if sh else (T, BASE)
    return (np.sum(w * TODAY * a / b) / np.sum(w * TODAY) - 1) * 100
def score(T):
    s = {"6-12k": band(T, 6000, 12000), "7-10.5k": band(T, 7000, 10500), "top 10.5-12.5k": band(T, 10500, 12500), "low 4-6k": band(T, 4000, 6000)}
    for k, w in DC.items(): s[k] = duty(T, w); s[k + "+4%"] = duty(T, w, True)
    s["worst"] = min(v for k, v in s.items() if k not in ("top 10.5-12.5k", "low 4-6k")); return s

rows = []; CUR = {}
for h in HEIGHTS:
    for V in VOLS:
        Ts = curve(V, h, "static", 248.1)
        if Ts is not None: rows.append(dict(V=V, h=h, intake="static 248", **score(Ts))); CUR[(V, h, "static")] = Ts
        G = [curve(V, h, "vrli", p) for p in POS]
        if all(g is not None for g in G):
            G = np.array(G).T; path = core.dp_schedule(G / BASE[:, None], W_P1, 1); Tv = G[np.arange(len(R)), path]
            rows.append(dict(V=V, h=h, intake="VRLI 198-298", **score(Tv), sched="/".join(f"{POS[j]:.0f}" for j in path))); CUR[(V, h, "vrli")] = Tv
            rows.append(dict(V=V, h=h, intake="VRLI ideal", **score(G.max(1))))
            rows.append(dict(V=V, h=h, intake="VRLI parked 248", **score(G[:, POS.index(248.1)])))
T = pd.DataFrame(rows)

# tip-in: full-torque time lost per snap, ms
tp = os.path.join(H, "plenum2_tipin.ndjson"); TI = {}
if os.path.exists(tp):
    for l in open(tp):
        x = json.loads(l); r0 = x["rows"][0]; rr = x["rows"][1:]; t = np.array([0.0] + [r["t"] for r in rr])
        TI[(x["V"], x["h"], x["rpm"])] = 1000 * sum((1 - r["bt"] / r0["bt_ss"]) * (t[i + 1] - t[i]) for i, r in enumerate(rr))
    for rpm in (6000, 8500):
        T[f"lost_ms_{rpm}"] = [TI.get((V, h, rpm), np.nan) - TI.get((1.44, 120, rpm), np.nan) for V, h in zip(T.V, T.h)]
cols = ["V", "h", "intake", "worst", "6-12k", "7-10.5k", "top 10.5-12.5k", "low 4-6k"] + [c for c in T if c.startswith("lost_ms")]
pd.set_option("display.width", 220); print(T[T.intake.isin(["static 248", "VRLI 198-298"])][cols].round(2).to_string(index=False))
T.round(3).to_csv(os.path.join(OUT, "plenum2_scores.csv"), index=False)

def legend(fig, ax):
    hd, lb = ax.get_legend_handles_labels(); fig.legend(hd, lb, loc="upper left", bbox_to_anchor=(0.008, 1 - 0.95 / fig.get_figheight()), ncol=len(lb), fontsize=10, labelcolor=INK2, handlelength=1.6, columnspacing=2.2)

def lines(ax, intake, col, ylabel):
    for h in HEIGHTS:
        x = T[(T.intake == intake) & (T.h == h)].sort_values("V")
        if len(x) < 2: continue
        ax.plot(x.V, x[col], color=HC[h], marker="o", ms=7, mec=SURF, mew=2, label=HL[h])
    ax.axhline(0, color=MUTED, lw=1); ax.set_xlabel("plenum volume, L"); ax.set_ylabel(ylabel); ax.set_xticks(VOLS); ax.margins(x=0.08)

for intake, tag, title in [("static 248", "P1_static", "Fixed 248 mm runner: what plenum volume and height do"),
                           ("VRLI 198-298", "P2_vrli", "VRLI 198-298 mm: what plenum volume and height do")]:
    if not len(T[T.intake == intake]): continue
    fig, ax = plt.subplots(1, 3, figsize=(15.5, 5.6))
    for a, (col, yl) in zip(ax, [("worst", "worst-case torque gain, %"), ("7-10.5k", "7-10.5k torque gain, %"), ("top 10.5-12.5k", "10.5-12.5k torque gain, %")]):
        lines(a, intake, col, yl); a.set_title(yl.split(",")[0], loc="left", fontsize=11.5, color=INK, pad=8)
    lo = min(a.get_ylim()[0] for a in ax); hi = max(a.get_ylim()[1] for a in ax)
    for a in ax: a.set_ylim(lo, hi)
    head(fig, title, "Torque gain over today's intake (1.44 L, 120 mm tall, fixed runner), one line per plenum height.", NOTE); legend(fig, ax[0])
    fig.subplots_adjust(left=0.05, right=0.985, top=TOP(fig) - 0.14, bottom=0.14, wspace=0.26); vc.save(fig, tag + ".png")

if TI:
    fig, ax = plt.subplots(1, 2, figsize=(12.5, 5.4))
    for a, rpm in zip(ax, (6000, 8500)):
        lines(a, "static 248", f"lost_ms_{rpm}", "extra full-torque time lost per snap, ms"); a.set_title(f"snap open at {rpm} rpm", loc="left", fontsize=11.5, color=INK, pad=8)
    head(fig, "Throttle response: what plenum volume and height cost", "Full-torque time lost in a snap from 40 kPa, relative to today's plenum. Higher is slower.", NOTE); legend(fig, ax[0])
    fig.subplots_adjust(left=0.07, right=0.98, top=TOP(fig) - 0.15, bottom=0.14, wspace=0.28); vc.save(fig, "P3_tipin.png")

# torque curves: today's plenum vs the tall ones, fixed runner and VRLI
fig, ax = plt.subplots(1, 2, figsize=(14.5, 5.8))
for a, kind, ttl in zip(ax, ("static", "vrli"), ("fixed 248 mm runner", "VRLI 198-298 mm, rate-limited schedule")):
    for h in HEIGHTS:
        Tq = CUR.get((1.44, h, kind))
        if Tq is None: continue
        a.plot(R, (Tq / BASE - 1) * 100, color=HC[h], label=HL[h])
    a.axhline(0, color=MUTED, lw=1); a.set_xlabel("engine speed, rpm"); a.set_title("1.44 L plenum, " + ttl, loc="left", fontsize=11.5, color=INK, pad=8)
for a in ax: a.set_ylabel("torque vs today's intake, %")
head(fig, "Where a taller plenum changes the torque curve", "Same 1.44 L volume, three heights. Left: fixed runner. Right: with the VRLI. The two panels have different scales.", NOTE); legend(fig, ax[0])
fig.subplots_adjust(left=0.06, right=0.985, top=TOP(fig) - 0.15, bottom=0.13, wspace=0.2); vc.save(fig, "P4_curves.png")
