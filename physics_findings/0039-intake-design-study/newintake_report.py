"""Finding 0039: report for the direct simulation of the recommended intake (newintake_sim.py) vs the baseline.

Stage 1 (default): engine curves, ECU table, interpolated-vs-direct check, duty-cycle scores, and fsae-sim torque files
  (team chassis-dyno curve x the new/baseline torque ratio) -> charts/newintake/, data/fsae_curves/.
Stage 2 (--laps DIR_BASE DIR_NEW [DIR_NEW_SHIFT]): lap-time comparison from car_envelope_curve.mjs outputs.
"""
import sys
from vrli_common import *
import vrli_common

OUT = vrli_common.OUT = os.path.join(H, "charts", "newintake"); os.makedirs(OUT, exist_ok=True)
CURVES = os.path.join(H, "data", "fsae_curves"); os.makedirs(CURVES, exist_ok=True)
rows = [json.loads(l) for l in open(os.path.join(H, "newintake.ndjson"))]
N = pd.DataFrame([r for r in rows if "bt" in r])
RG = np.array(sorted(N[N.case == "base"].rpm.unique()), float)
BASE = N[N.case == "base"].set_index("rpm").bt.reindex(RG).values
G = N[N.case == "new"].pivot_table(index="rpm", columns="pos", values="bt").reindex(RG)
POS = np.array(G.columns, float)
CD98 = N[N.case == "cd98"].set_index("rpm").bt.reindex(RG).values
TODAY_RG = np.interp(RG, R, TODAY)                                   # calibrated wheel torque today, 250 rpm grid
DY = core.dyno()

# steady ECU table (dyno-style slow sweep) and the rate-limited schedule (200 mm/s at 3000 rpm/s up-sweeps)
best_idx = np.nanargmax(G.values, axis=1); T_steady = G.values[np.arange(len(RG)), best_idx]; table = POS[best_idx]
step = max(1, int(round(200.0 / 3000.0 * (RG[1] - RG[0]) / (POS[1] - POS[0]))))
W = np.where((RG >= 6000) & (RG <= 12000), 1.0, 0.15)
path = core.dp_schedule(G.values / BASE[:, None], W, step); T_rate = G.values[np.arange(len(RG)), path]; sched = POS[path]

def bandg(T, lo, hi):
    m = (RG >= lo) & (RG <= hi); return (np.trapezoid((TODAY_RG * T / BASE)[m], RG[m]) / np.trapezoid(TODAY_RG[m], RG[m]) - 1) * 100
DCW = {n: np.interp(RG, R, w) for n, w in DC.items()}; DCW = {n: w / w.sum() for n, w in DCW.items()}
def dutyg(T, w, sh=False):
    if sh: T, B = np.interp(np.minimum(RG * 1.04, RG[-1]), RG, T), np.interp(np.minimum(RG * 1.04, RG[-1]), RG, BASE)
    else: B = BASE
    return (np.sum(w * TODAY_RG * T / B) / np.sum(w * TODAY_RG) - 1) * 100
def scores(T):
    s = {"6-12k": bandg(T, 6000, 12000), "4-6k": bandg(T, 4000, 6000), "7-10.5k": bandg(T, 7000, 10500), "10.5-12.5k": bandg(T, 10500, 12500)}
    ws = [s["6-12k"], s["7-10.5k"]]
    for n, w in DCW.items(): s[n] = dutyg(T, w); ws += [s[n], dutyg(T, w, True)]
    s["worst"] = min(ws); return s
HP = lambda T, r: T * r * 2 * math.pi / 60 / 745.7
cases = {"new, slow sweep (ECU table)": T_steady, "new, 1st/2nd-gear sweep (200 mm/s)": T_rate, "new + Cd 0.98 nozzle (table)": CD98}
SC = {k: scores(v) for k, v in cases.items()}
# what the interpolated grid predicted for the same design (tradeoff.py package 6)
pred = pd.read_csv(os.path.join(H, "charts", "tradeoff", "tradeoff_packages.csv"))
pred6 = pred[pred.name.str.contains("recommended")].iloc[0]
summary = pd.DataFrame(SC).T.round(2); summary.to_csv(os.path.join(OUT, "newintake_scores.csv"))
pd.set_option("display.width", 220); print(summary.to_string()); print("grid prediction (rate-limited, restrictor-scaled):", {k: round(pred6[k], 2) for k in ["worst", "6-12k", "4-6k", "7-10.5k", "10.5-12.5k"]})
peak = lambda T: (HP(TODAY_RG * T / BASE, RG).max(), RG[np.argmax(HP(TODAY_RG * T / BASE, RG))])
print("peak hp today %.1f @ %d | new table %.1f @ %d | new+cd %.1f @ %d" % (*peak(BASE), *peak(T_steady), *peak(CD98)))

# ---------------- R1: torque + power ----------------
fig, axs = plt.subplots(2, 1, figsize=(15, 11), sharex=True)
for ax, f, lab in [(axs[0], lambda T: TODAY_RG * T / BASE, "wheel torque (N·m)"), (axs[1], lambda T: HP(TODAY_RG * T / BASE, RG), "wheel power (hp)")]:
    ax.axvspan(6, 12, color="#f4f3ef", zorder=0)
    ax.plot(DY.rpm / 1000, DY.Nm if "torque" in lab else DY.hp, color=MUTED, lw=1.1, label="team chassis dyno (measured)", zorder=2)
    ax.plot(RG / 1000, f(BASE), color=INK, lw=2.6, label="baseline sim: today's intake", zorder=5)
    for (k, T), c in zip(cases.items(), ["#2a78d6", "#86b6ef", "#eb6834"]):
        ax.plot(RG / 1000, f(T), color=c, lw=2.2, zorder=4, label=f"{k}: worst {SC[k]['worst']:+.1f} %, 6-12k {SC[k]['6-12k']:+.1f} %")
    ax.set_ylabel(lab); ax.legend(fontsize=9.5, loc="lower center" if "torque" in lab else "upper left")
axs[1].set_xlabel("engine speed (krpm)")
head(fig, "Recommended intake vs today: direct 1D simulation", "2.75 L box, VRLI 198 -> 298 mm above the flange (100 mm stroke, trumpets displace plenum air), ~123 mm venturi. Every point is a real engine run, not the design-grid interpolation.", NOTE)
fig.subplots_adjust(left=0.06, right=0.99, top=TOP(fig) - 0.02, bottom=0.07, hspace=0.1); save(fig, "R1_torque_power.png")

# ---------------- R2: gain by rpm + ECU table ----------------
fig, axs = plt.subplots(2, 1, figsize=(15, 9.5), sharex=True, gridspec_kw=dict(height_ratios=[1.3, 1]))
g1 = (T_steady / BASE - 1) * 100; g2 = (T_rate / BASE - 1) * 100
axs[0].bar(RG / 1000, g1, width=0.2, color=["#2a78d6" if v >= 0 else "#e34948" for v in g1], zorder=2, label="slow sweep (ECU table)")
axs[0].plot(RG / 1000, g2, color=INK, lw=1.6, marker="o", ms=4, label="1st/2nd-gear sweep (actuator-limited)", zorder=3)
axs[0].axhline(0, color=INK, lw=1); axs[0].set_ylabel("torque vs today (%)"); axs[0].legend(fontsize=9.5)
axs[0].set_title("Where the gain is", loc="left", fontsize=12.5, fontweight="semibold", color=INK)
axs[1].plot(RG / 1000, table, color="#2a78d6", lw=2.2, drawstyle="steps-mid", label="ECU table (best position at each rpm, from the runs)")
axs[1].plot(RG / 1000, sched, color=INK, lw=1.6, ls="--", drawstyle="steps-mid", label="what a 200 mm/s actuator follows in a 3000 rpm/s sweep")
axs[1].axhline(OUTSIDE0, color=MUTED, lw=1, ls=":"); axs[1].text(4.05, OUTSIDE0 + 2, "today's runner 248 mm", fontsize=9, color=INK2)
axs[1].set_ylim(190, 306); axs[1].set_ylabel("runner length above flange (mm)"); axs[1].set_xlabel("engine speed (krpm)"); axs[1].legend(fontsize=9.5, loc="upper left", bbox_to_anchor=(0.35, 1.13), ncol=2)
axs[1].set_title("ECU table", loc="left", fontsize=12.5, fontweight="semibold", color=INK)
head(fig, "Gain by rpm and the ECU table that produces it", "Positions tested every 10 mm from 198 to 298 mm at every 250 rpm.", NOTE)
fig.subplots_adjust(left=0.07, right=0.99, top=TOP(fig) - 0.02, bottom=0.08, hspace=0.18); save(fig, "R2_gain_and_table.png")
pd.DataFrame(dict(rpm=RG, table_mm=table, sched_3000rpm_s_mm=sched, base_bt=BASE, new_table_bt=T_steady, new_rate_bt=T_rate, new_cd98_bt=CD98,
                  wheel_today=TODAY_RG, wheel_new_table=TODAY_RG * T_steady / BASE)).round(3).to_csv(os.path.join(OUT, "newintake_curves.csv"), index=False)

# ---------------- R3: scores table (direct vs grid prediction) ----------------
fig, ax = plt.subplots(figsize=(15, 3.4)); ax.axis("off")
cols = ["", "worst case", "6-12k", "4-6k", "7-10.5k", "10.5-12.5k"] + [DC_LABEL[n] for n in DC]
cell = [[k] + [f"{SC[k][c]:+.1f} %" for c in ["worst", "6-12k", "4-6k", "7-10.5k", "10.5-12.5k"]] + [f"{SC[k][n]:+.1f} %" for n in DC] for k in cases]
cell.append(["grid prediction (tradeoff study)"] + [f"{pred6[c]:+.1f} %" for c in ["worst", "6-12k", "4-6k", "7-10.5k", "10.5-12.5k"]] + [f"{pred6[n]:+.1f} %" for n in DC])
tb = ax.table(cellText=cell, colLabels=cols, cellLoc="center", bbox=[0, 0, 1, 1], colWidths=[0.2] + [0.07] * 5 + [0.11] * 4)
tb.auto_set_font_size(False); tb.set_fontsize(9.5)
for (i, j), c in tb.get_celld().items():
    c.set_edgecolor(GRID); c.set_facecolor("#f0efec" if i == 0 else (SURF if i < len(cell) else "#f7f6f3"))
    if i == 0: c.set_text_props(fontweight="semibold", color=INK)
head(fig, "Scores: direct simulation vs what the design grid predicted", "Gain vs today's intake. Worst = min over dyno bands, four real duty cycles and the model's 4 % rpm offset.", NOTE)
fig.subplots_adjust(left=0.01, right=0.99, top=TOP(fig) - 0.06, bottom=0.12); save(fig, "R3_scores.png")

# ---------------- fsae-sim torque files ----------------
base_curve = json.load(open(r"C:\Users\nick5\fsae-sim\sim\data\sdm26-torque.json"))
def write_curve(name, ratio_fn, note):
    c = json.loads(json.dumps(base_curve)); c["name"] = f"SDM26 dyno x {name}"; c["note"] = note
    for p in c["points"]:
        k = ratio_fn(p["rpm"]); p["torqueNm"] = round(p["torqueNm"] * k, 3); p["powerKW"] = round(p["powerKW"] * k, 3)
    json.dump(c, open(os.path.join(CURVES, f"{name}.json"), "w"), indent=1)
ratio = lambda T: (lambda r: float(np.interp(min(max(r, RG[0]), RG[-1]), RG, T / BASE)))
write_curve("newintake_rate", ratio(T_rate), "finding 0039: team dyno x (new intake, 200 mm/s actuator at 3000 rpm/s) / baseline, from direct 1D runs; ratio held flat outside 4000-12500")
write_curve("newintake_table", ratio(T_steady), "finding 0039: team dyno x (new intake, steady ECU table) / baseline")
write_curve("newintake_rate_shift4", lambda r: ratio(T_rate)(r * 1.04), "finding 0039: as newintake_rate but with the model's ~4 % late rpm features corrected (ratio read at 1.04 x rpm)")
print("wrote fsae-sim curves to", CURVES)

# ---------------- stage 2: laps ----------------
if "--laps" in sys.argv:
    dirs = sys.argv[sys.argv.index("--laps") + 1:]
    labs = ["today", "new intake", "new intake (rpm-offset corrected)"][:len(dirs)]
    res = []
    for lab, dd in zip(labs, dirs):
        r = json.load(open(os.path.join(dd, "car_envelope.json")))["lapTimeBound"]["courses"]
        ax_ = r["autocross"]["lines"]; en = r["endurance"]["lines"]
        res.append(dict(case=lab, ax_opt=ax_["optimised"]["oneLapFromRestS"], ax_topt=ax_["timeOptimised"]["oneLapFromRestS"],
                        en_opt=en["optimised"]["twoLapsFromRestS"], en_topt=en["timeOptimised"]["twoLapsFromRestS"]))
    L = pd.DataFrame(res).set_index("case"); L.to_csv(os.path.join(OUT, "newintake_laps.csv")); print(L.to_string())
    fig, axs = plt.subplots(1, 2, figsize=(15, 4.6))
    for ax, (k, nm, scale) in zip(axs, [("ax_opt", "Autocross (one lap from rest)", 1), ("en_opt", "Endurance (2 laps from rest; the 22 km event is ~10 laps)", 1)]):
        base = L[k].iloc[0]; d_ = (L[k] - base).values
        ax.barh(range(len(L)), d_, height=0.55, color=[MUTED] + ["#2a78d6"] * (len(L) - 1), zorder=2)
        for i, (v, t) in enumerate(zip(d_, L[k].values)): ax.text(0.02 * abs(lo_) if (lo_ := min(d_.min() * 1.6, -0.05)) else 0, i, f"{t:.3f} s ({v:+.3f} s)", va="center", ha="left", fontsize=10, color=INK)
        ax.set_yticks(range(len(L))); ax.set_yticklabels(L.index); ax.invert_yaxis(); ax.axvline(0, color=INK, lw=1)
        ax.set_xlabel("lap-time change vs today (s)"); ax.set_title(nm, loc="left", fontsize=12, fontweight="semibold", color=INK)
        lo = min(d_.min() * 1.6, -0.05); ax.set_xlim(lo, -lo * 1.1)
    head(fig, "Lap time in fsae-sim with the new intake", "Quasi-static lap bound on the fsae-sim vehicle model (optimised line), engine = team dyno curve x the direct-sim torque ratio. Same car, tyres, aero, gearing.", "QSS lap bound (no tyre lag/yaw inertia, ideal shifts) - it isolates the engine change. Autocross agrees on both of the tool's lines (-0.12 to -0.24 s); endurance's looser time-optimised line was inconsistent (+0.25 / -0.12 s).")
    fig.subplots_adjust(left=0.2, right=0.98, top=TOP(fig) - 0.06, bottom=0.17, wspace=0.45); save(fig, "R4_laptime.png")
