"""Finding 0039: the as-measured car (asmeasured.py) against the team dyno, and the VRLI in the real plenum.

Dyno set: wheel torque = brake torque x 0.94 (0036's fitted drivetrain efficiency), logged AFR and spark, 250 rpm steps.
For each geometry: rms error and bias against the dyno over 4500-12500 rpm, the same after the best single scale factor
(shape error: what a drivetrain-efficiency refit cannot fix), and where the torque peaks and dips sit.
Design set: VRLI 198-298 mm in the real plenum (1.826 L, 141 mm) against the fixed runner in the same plenum.
Writes charts/asmeasured/.
"""
import json, os, numpy as np, pandas as pd
import core, vrli_common as vc
from vrli_common import plt, head, TOP, INK, INK2, MUTED, SURF, DC, W_P1

H = core.H; OUT = os.path.join(H, "charts", "asmeasured"); os.makedirs(OUT, exist_ok=True); vc.OUT = OUT
D = pd.DataFrame([json.loads(l) for l in open(os.path.join(H, "asmeasured.ndjson"))]); D = D[D.bt.notna()]
dy = core.dyno(); ETA = 0.94
NAMES = {"model": "as modelled (0036)", "plenum": "+ real plenum (1.83 L, 141 mm)", "intake": "+ real runners (252 / 230 mm)", "exh": "model intake + real exhaust",
         "all": "all measured (80 mm port, 1.83 L)", "all_sharp": "all measured, sharp runner mouths",
         "all_mid": "all measured, plenum + 40 mm (2.77 L)", "all_big": "all measured, plenum + 93 mm (4.03 L)", "model_dump": "as modelled, dump plenum", "all_dump": "all measured, dump plenum",
         "all_port100": "all measured, 100 mm head port", "all_port120": "all measured, 120 mm head port"}
NOTE = "1D engine model, 160-cell plenum, venturi inertance 400 1/m, logged AFR and spark maps. Wheel torque = brake torque x 0.94. Dyno: team chassis dyno, 25 rpm bins."

def curve(case):
    x = D[D.case == case].drop_duplicates("rpm").set_index("rpm").bt.sort_index(); return x.index.values.astype(float), x.values * ETA
rows = []; C = {}
for c in NAMES:
    if not (D.case == c).any(): continue
    r, t = curve(c); m = (r >= 4500) & (r <= 12500); r, t = r[m], t[m]; d = np.interp(r, dy.rpm, dy.Nm); C[c] = (r, t)
    k = float(np.sum(t * d) / np.sum(t * t))                                    # best single scale factor
    pk = r[np.argmax(t)]; hi = (r >= 9000)
    u = r >= 5500; k2 = float(np.sum(t[u] * d[u]) / np.sum(t[u] ** 2))             # the dyno's first 1000 rpm (30 -> 48 N.m) may be the pull's ramp-in; score without it too
    rows.append(dict(case=c, n=len(r), rms_Nm=np.sqrt(np.mean((t - d) ** 2)), bias_Nm=np.mean(t - d), scale=k, shape_rms_Nm=np.sqrt(np.mean((k * t - d) ** 2)),
                     shape_rms_pct=100 * np.sqrt(np.mean((k * t / d - 1) ** 2)), peak_rpm=pk, peak_Nm=t.max(), peak_power_kW=(t * r * np.pi / 30 / 1000).max(),
                     rms_5p5k_up=np.sqrt(np.mean((t - d)[u] ** 2)), scale_5p5k_up=k2, shape_rms_5p5k_up=np.sqrt(np.mean((k2 * t - d)[u] ** 2)), peak_rpm_8_10k=r[(r >= 8000) & (r <= 10000)][np.argmax(t[(r >= 8000) & (r <= 10000)])], rms_4p5_7k=np.sqrt(np.mean((t - d)[r <= 7000] ** 2)), rms_7_10k=np.sqrt(np.mean((t - d)[(r > 7000) & (r <= 10000)] ** 2)), rms_10_12p5k=np.sqrt(np.mean((t - d)[r > 10000] ** 2))))
T = pd.DataFrame(rows); pd.set_option("display.width", 220)
print(f"dyno: peak {dy.Nm.max():.1f} Nm at {dy.rpm[dy.Nm.idxmax()]:.0f} rpm, peak power {dy.kW.max():.1f} kW at {dy.rpm[dy.kW.idxmax()]:.0f} rpm")
print(T.round(3).to_string(index=False)); T.round(4).to_csv(os.path.join(OUT, "dyno_fit.csv"), index=False)

if C:
    SHOW = [("model", "#2a78d6"), ("exh", "#eda100"), ("all", "#eb6834"), ("all_sharp", "#1baf7a")]
    fig, ax = plt.subplots(1, 2, figsize=(15, 6))
    m = (dy.rpm >= 4500) & (dy.rpm <= 12500); ax[0].plot(dy.rpm[m], dy.Nm[m], color=INK, lw=2.6, label="dyno")
    for c, col in SHOW:
        if c not in C: continue
        r, t = C[c]; ax[0].plot(r, t, color=col, label=NAMES[c]); ax[1].plot(r, t - np.interp(r, dy.rpm, dy.Nm), color=col, label=NAMES[c])
    ax[1].axhline(0, color=MUTED, lw=1); ax[0].set_ylabel("wheel torque, N.m"); ax[1].set_ylabel("model minus dyno, N.m")
    ax[0].set_title("torque curve", loc="left", fontsize=11.5, color=INK, pad=8); ax[1].set_title("error against the dyno", loc="left", fontsize=11.5, color=INK, pad=8)
    for a in ax: a.set_xlabel("engine speed, rpm")
    hd, lb = ax[0].get_legend_handles_labels(); fig.legend(hd, lb, loc="upper left", bbox_to_anchor=(0.008, 1 - 0.95 / fig.get_figheight()), ncol=len(lb), fontsize=10, labelcolor=INK2, handlelength=1.6, columnspacing=2.2)
    head(fig, "The as-measured car against the dyno", "Same engine model and tune; only the intake and exhaust dimensions change from the model's estimates to the CAD's.", NOTE)
    fig.subplots_adjust(left=0.055, right=0.985, top=TOP(fig) - 0.14, bottom=0.12, wspace=0.18); vc.save(fig, "A1_dyno.png")

def panel(fname, show, title, sub):
    fig, ax = plt.subplots(1, 2, figsize=(15, 6)); m = (dy.rpm >= 5500) & (dy.rpm <= 12500); ax[0].plot(dy.rpm[m], dy.Nm[m], color=INK, lw=2.6, label="dyno")
    for c, col in show:
        if c not in C: continue
        r, t = C[c]; u = r >= 5500; ax[0].plot(r[u], t[u], color=col, label=NAMES[c]); ax[1].plot(r[u], t[u] - np.interp(r[u], dy.rpm, dy.Nm), color=col, label=NAMES[c])
    ax[1].axhline(0, color=MUTED, lw=1); ax[0].set_ylabel("wheel torque, N.m"); ax[1].set_ylabel("model minus dyno, N.m")
    ax[0].set_title("torque curve", loc="left", fontsize=11.5, color=INK, pad=8); ax[1].set_title("error against the dyno", loc="left", fontsize=11.5, color=INK, pad=8)
    for a in ax: a.set_xlabel("engine speed, rpm")
    hd, lb = ax[0].get_legend_handles_labels(); fig.legend(hd, lb, loc="upper left", bbox_to_anchor=(0.008, 1 - 0.95 / fig.get_figheight()), ncol=len(lb), fontsize=10, labelcolor=INK2, handlelength=1.6, columnspacing=2.2)
    head(fig, title, sub, NOTE); fig.subplots_adjust(left=0.055, right=0.985, top=TOP(fig) - 0.14, bottom=0.12, wspace=0.18); vc.save(fig, fname)
if "all_port120" in C:
    panel("A2_port_length.png", [("all", "#2a78d6"), ("all_port100", "#eb6834"), ("all_port120", "#1baf7a")], "A longer head port moves the model's torque peaks onto the dyno's",
          "All-measured car with the head port (flange to valve seat) at the model's 80 mm estimate, 100 mm and 120 mm.")
if "all_big" in C:
    panel("A3_plenum.png", [("all", "#2a78d6"), ("all_mid", "#eb6834"), ("all_big", "#1baf7a")], "A bigger plenum in the model, against the dyno",
          "All-measured car with the real plenum (1.83 L) and with 40 mm and 93 mm of straight section added (2.77 L, 4.03 L). The dyno is the real 1.83 L plenum.")

# design set: VRLI in the real plenum
R = vc.R; TODAY = core.today()(R)
def dcurve(case):
    x = D[D.case == case].drop_duplicates("rpm").set_index("rpm").bt.reindex(R); return x.values if x.notna().all() else None
B = dcurve("design_static"); pos = sorted(int(c.split("_")[-1]) for c in D.case.unique() if c.startswith("design_vrli_"))
G = [dcurve(f"design_vrli_{p}") for p in pos]
if B is not None and G and all(g is not None for g in G):
    G = np.array(G).T; path = core.dp_schedule(G / B[:, None], W_P1, 1); Tv = G[np.arange(len(R)), path]
    def band(T_, lo, hi):
        m = (R >= lo) & (R <= hi); return (np.trapezoid((TODAY * T_ / B)[m], R[m]) / np.trapezoid(TODAY[m], R[m]) - 1) * 100
    sh = lambda T_: np.interp(np.minimum(R * 1.04, R[-1]), R, T_)
    def score(T_):
        s = {"6-12k": band(T_, 6000, 12000), "7-10.5k": band(T_, 7000, 10500)}
        for k, w in DC.items(): s[k] = (np.sum(w * TODAY * T_ / B) / np.sum(w * TODAY) - 1) * 100; s[k + "+4%"] = (np.sum(w * TODAY * sh(T_) / sh(B)) / np.sum(w * TODAY) - 1) * 100
        return dict(worst=min(s.values()), **{"6-12k": s["6-12k"], "7-10.5k": s["7-10.5k"]}, top=band(T_, 10500, 12500), low=band(T_, 4000, 6000))
    V = pd.DataFrame([dict(intake="VRLI 198-298, 200 mm/s", **score(Tv)), dict(intake="VRLI ideal", **score(G.max(1))), dict(intake="VRLI parked 248", **score(G[:, pos.index(248)]))])
    print("\nVRLI in the real plenum (1.826 L, 141 mm), vs the fixed 248 mm runner in the same plenum, %:"); print(V.round(2).to_string(index=False))
    print("schedule:", "/".join(str(pos[j]) for j in path)); V.round(3).to_csv(os.path.join(OUT, "vrli_real_plenum.csv"), index=False)
