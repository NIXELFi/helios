"""Finding 0039: full intake trade-off study under the team's packaging limits.

Constraints (Nick 2026-10-01): VRLI fully extended <= 300 mm above the head flange, stroke <= 100 mm.
Every design is scored the same way as the rest of 0039 (worst case over the 6-12k and 7-10.5k bands, four on-throttle
duty cycles and their 4 % rpm-shift checks). Restrictor length and throat Cd are folded in as per-rpm torque ratios from
the G4 recovery sweep (Idelchik + wall friction) and the Cd sweep, applied on top of the VRLI torque curve.
Writes charts/tradeoff/*.png and tradeoff_*.csv.
"""
from vrli_common import *
import vrli_common
from matplotlib.colors import TwoSlopeNorm
import study

OUT = vrli_common.OUT = os.path.join(H, "charts", "tradeoff"); os.makedirs(OUT, exist_ok=True)
EXT_CAP, STROKE_CAP = 300.0, 100
COMBOS = pd.read_csv(os.path.join(H, "charts", "combos", "combos_all.csv"))

# ---------------- restrictor and throat-Cd torque ratios (per rpm) ----------------
RSW = json.load(open(os.path.join(H, "charts", "restrictor_R_sweep.json")))
LAM = 0.014
def zfr(D, a): return LAM / (8 * math.sin(math.radians(a))) * (1 - (0.020 / D) ** 4)
RB = study.R_idel(0.038, 3.2); R0 = study.ETA_REL * RB; ETA_F = R0 / (RB - zfr(0.038, 3.2))
def recovery(dout_mm, ang): return ETA_F * (study.R_idel(dout_mm / 1000, ang) - zfr(dout_mm / 1000, ang))
def restrictor_ratio(Rv, V):
    out = []
    for key in ("1.44", "3.5"):
        br = RSW[key]["by_rpm"]; ks = sorted(br, key=float); Rs = np.array([float(k) for k in ks]); M = np.array([br[k] for k in ks]) / 100
        if Rv <= Rs[-1]: r = np.array([np.interp(Rv, Rs, M[:, i]) for i in range(M.shape[1])])
        else: r = M[-1] + (M[-1] - M[-2]) / (Rs[-1] - Rs[-2]) * (Rv - Rs[-1])     # small extrapolation above as-built
        out.append(1 + r)
    f = np.clip((math.log(V) - math.log(1.44)) / (math.log(3.5) - math.log(1.44)), 0, 1)
    return out[0] * (1 - f) + out[1] * f
def best_restrictor(total_mm):
    best = None
    for a in np.arange(2.0, 8.01, 0.5):
        for D in np.arange(22, 50.1, 1):
            L = (D - 20) / 2 / math.tan(math.radians(a))
            if L + 30 <= total_mm:
                Rv = recovery(D, a)
                if best is None or Rv > best[0]: best = (Rv, D, a, L + 30)
    return best
CD = pd.DataFrame([json.loads(l) for l in open(os.path.join(H, "diag", "cd_sweep.ndjson"))])
BASE144 = d[(d.grid == "G1") & (d.V == 1.44) & (d.ext == 0)].sort_values("rpm").bt.values
CDR = {0.95: np.ones(len(R))}
for cd, g in CD.groupby("cd"): CDR[float(cd)] = g.sort_values("rpm").bt.values / BASE144
def cd_ratio(cd):
    ks = sorted(CDR); return np.array([np.interp(cd, ks, [CDR[k][i] for k in ks]) for i in range(len(R))])

# ---------------- scoring with an extra per-rpm multiplier ----------------
def vrli_speed(Venv, lo, st, w, speed=200.0):
    if st == 0: return S.at(Venv, lo), np.full(len(R), float(lo))
    pos = np.arange(lo, lo + st + 1e-9, 5.0); Veff = Venv - BORE_A * (pos - lo)
    T = np.array([S.at(max(v, 0.3), p) for v, p in zip(Veff, pos)]).T
    step = len(pos) if speed is None else max(1, int(round(speed / 3000.0 * (R[1] - R[0]) / 5.0)))
    path = core.dp_schedule(T / S.base[:, None], w, step)
    return T[np.arange(len(R)), path], pos[path]
def score(V, retracted, stroke, mult=1.0, speed=200.0, per_duty=True):
    lo = retracted - OUTSIDE0
    T, sch = vrli_speed(V, lo, stroke, W_P1, speed); T = T * mult
    sc = {"6-12k": band(T, 6000, 12000), "4-6k": band(T, 4000, 6000), "7-10.5k": band(T, 7000, 10500), "10.5-12.5k": band(T, 10500, 12500)}
    ws = [sc["6-12k"], sc["7-10.5k"]]
    for n, w in DC.items():
        Tw = (vrli_speed(V, lo, stroke, np.maximum(w, 1e-4), speed)[0] * mult) if per_duty else T
        a, b = duty(Tw, w), duty(Tw, w, True); sc[n] = a; ws += [a, b]
    sc["worst"] = min(ws); sc["duty_mean"] = float(np.mean([sc[n] for n in DC]))
    return sc, T, sch

# ---------------- feasible set and the pick ----------------
F = COMBOS[(COMBOS.extended <= EXT_CAP + 0.2) & (COMBOS.stroke <= STROKE_CAP)].copy()
F["both"] = F[["7-10.5k", "10.5-12.5k"]].min(axis=1)
F.to_csv(os.path.join(OUT, "tradeoff_feasible.csv"), index=False)
REST_PICK = best_restrictor(125)                         # ~120-125 mm venturi at no measurable loss
RMULT = lambda V: restrictor_ratio(REST_PICK[0], V)
PICK_V = 2.75
pk = F[F.V == PICK_V].sort_values("worst").iloc[-1]
PICK = dict(V=PICK_V, retracted=float(pk.retracted), stroke=int(pk.stroke))
print("pick:", PICK, "restrictor", REST_PICK)

# ---------------- packages (shortlist) ----------------
def pkg(name, V, ret, st, rest_total=125, cd=0.95, note=""):
    b = best_restrictor(rest_total) if rest_total < 228 else (R0, 38, 3.2, 228)
    m = restrictor_ratio(b[0], V) * cd_ratio(cd)
    sc, T, sch = score(V, ret, st, m)
    return dict(name=name, V=V, retracted=ret, extended=ret + st, stroke=st, restrictor_mm=b[3], restrictor=f"{b[1]:.0f} mm / {b[2]:.1f}°", cd=cd,
                mass_kg=mass(st), plenum_h_mm=max(st + CLEAR, TODAY_PLENUM_H), t90_ms=t90(V), note=note, T=T, sch=sch, **sc)
def best_in(V, stroke_cap, ext_cap=EXT_CAP):
    f = COMBOS[(COMBOS.V == V) & (COMBOS.stroke <= stroke_cap) & (COMBOS.extended <= ext_cap + 0.2)].sort_values("worst").iloc[-1]
    return float(f.retracted), int(f.stroke)
P = []
P.append(pkg("0  Today", 1.44, OUTSIDE0, 0, rest_total=228, note="as-built 228 mm venturi"))
P.append(pkg("1  Short restrictor only", 1.44, OUTSIDE0, 0, note="frees ~100 mm"))
P.append(pkg("2  Static: bigger plenum + short restrictor", 2.75, *best_in(2.75, 0), note="no moving parts"))
P.append(pkg("3  VRLI 50 mm, today's plenum volume", 1.44, *best_in(1.44, 50)))
P.append(pkg("4  VRLI 80 mm (fits today's height), 2.75 L", 2.75, *best_in(2.75, 80)))
P.append(pkg("5  VRLI 100 mm, 1.44 L", 1.44, *best_in(1.44, 100)))
P.append(pkg("6  VRLI 100 mm, 2.75 L  (recommended)", 2.75, *best_in(2.75, 100)))
P.append(pkg("7  VRLI 100 mm, 2.75 L + Cd 0.98 nozzle", 2.75, *best_in(2.75, 100), cd=0.98, note="radiused converging side"))
PK = pd.DataFrame([{k: v for k, v in p.items() if k not in ("T", "sch")} for p in P])
PK.round(2).to_csv(os.path.join(OUT, "tradeoff_packages.csv"), index=False)
pd.set_option("display.width", 250)
print(PK[["name", "V", "retracted", "extended", "stroke", "restrictor_mm", "worst", "6-12k", "4-6k", "7-10.5k", "10.5-12.5k", "duty_mean", "mass_kg", "plenum_h_mm", "t90_ms"]].round(2).to_string(index=False))

# ---------------- what matters most: tornado on the worst case, around package 6 ----------------
REC = P[6]; base_w = REC["worst"]
def sw(lst): return [x - base_w for x in lst]
knobs = []
knobs.append(("VRLI stroke 0-100 mm (best placement each)", sw([score(2.75, *best_in(2.75, s), RMULT(2.75))[0]["worst"] for s in (0, 25, 50, 80, 100)])))
knobs.append(("Long-end reach 248-300 mm (stroke <= 100)", sw([score(2.75, *best_in(2.75, 100, e), RMULT(2.75))[0]["worst"] for e in (248.2, 270, 285, 300)])))
knobs.append(("Where the 100 mm sits (148->248 ... 198->298)", sw([score(2.75, r, 100, RMULT(2.75))[0]["worst"] for r in (148.1, 163.1, 178.1, 188.1, 198.1)])))
knobs.append(("Plenum box 1.44-3.5 L (best design each)", sw([score(V, *best_in(V, 100), RMULT(V))[0]["worst"] for V in BOXES])))
knobs.append(("Restrictor length 60-228 mm (best diffuser each)", sw([score(2.75, REC["retracted"], REC["stroke"], restrictor_ratio(best_restrictor(L)[0], 2.75))[0]["worst"] for L in (60, 80, 100, 125, 228)])))
knobs.append(("Throat Cd 0.90-0.99 (converging-side quality)", sw([score(2.75, REC["retracted"], REC["stroke"], RMULT(2.75) * cd_ratio(c))[0]["worst"] for c in (0.90, 0.93, 0.95, 0.97, 0.99)])))
knobs.append(("Actuator speed 50 mm/s - instant", sw([score(2.75, REC["retracted"], REC["stroke"], RMULT(2.75), speed=s)[0]["worst"] for s in (50, 100, 200, 400, None)])))
knobs.append(("ECU table: one table vs tuned per duty cycle", sw([score(2.75, REC["retracted"], REC["stroke"], RMULT(2.75), per_duty=pd_)[0]["worst"] for pd_ in (False, True)])))
knobs.append(("Taller plenum for the travel (120->140 mm, est.)", [-0.2, 0.0]))
K = pd.DataFrame([dict(knob=n, low=min(v), high=max(v), span=max(v) - min(v)) for n, v in knobs]).sort_values("span")
K.round(2).to_csv(os.path.join(OUT, "tradeoff_knobs.csv"), index=False); print(K.round(2).to_string(index=False))

fig, ax = plt.subplots(figsize=(14, 0.62 * len(K) + 2.3))
for i, r in enumerate(K.itertuples()):
    big = r.span >= 1.0
    ax.barh(i, max(r.span, 0.04), left=r.low, height=0.56, color="#2a78d6" if big else "#86b6ef", zorder=2)
    ax.text(max(r.high, 0) + 0.12, i, f"{r.span:.1f} pts", va="center", fontsize=10, color=INK)
ax.axvline(0, color=INK, lw=1.2); ax.set_yticks(range(len(K))); ax.set_yticklabels(K.knob, fontsize=10.5); ax.grid(axis="y", visible=False)
ax.set_xlabel(f"change in worst-case gain vs the recommended package (pts; recommended = {base_w:+.1f} %)")
head(fig, "What matters most (inside your limits)", "Each bar swings one knob across its range with everything else at the recommended package (2.75 L box, 100 mm VRLI ending at 298 mm, ~125 mm restrictor). Dark = 1 pt or more.", NOTE)
fig.subplots_adjust(left=0.29, right=0.97, top=TOP(fig) - 0.02, bottom=0.17); save(fig, "T1_what_matters.png")

# ---------------- what each constraint costs ----------------
fig, ax = plt.subplots(figsize=(14, 6.6))
caps = np.arange(248.1, 409, 5)
for sc_, c in zip([50, 80, 100, 150, 200], RAMP):
    y = [COMBOS[(COMBOS.V == 2.75) & (COMBOS.stroke <= sc_) & (COMBOS.extended <= e + 0.2)].worst.max() for e in caps]
    ax.plot(caps, y, color=c, lw=2.2); ax.text(caps[-1] + 3, y[-1], f"stroke <= {sc_}", fontsize=9.5, color=INK, va="center")
ax.axvline(EXT_CAP, color=INK, ls="--", lw=1.2); ax.text(EXT_CAP + 2, ax.get_ylim()[0] + 0.3, "your 300 mm limit", fontsize=9.5, color=INK)
ax.plot(EXT_CAP, F[F.V == 2.75].worst.max(), "o", ms=10, mfc="none", mec=INK, mew=2)
ax.set_xlim(245, 440); ax.set_xlabel("allowed fully-extended runner length above the flange (mm)"); ax.set_ylabel("best worst-case gain (%)")
head(fig, "What each packaging limit costs (2.75 L box)", "Best robust gain for a given reach limit and stroke limit. Inside your limits (300 mm, 100 mm) the reach is binding: each extra 10 mm of reach is worth ~0.3 pts; extra stroke alone adds little.", NOTE)
fig.subplots_adjust(left=0.06, right=0.97, top=TOP(fig) - 0.02, bottom=0.11); save(fig, "T2_constraint_cost.png")

# ---------------- feasible map (2.75 L) ----------------
fig, ax = plt.subplots(figsize=(13, 7.6))
x = COMBOS[(COMBOS.V == 2.75) & (COMBOS.extended <= 330) & (COMBOS.retracted >= 128)].pivot_table(index="retracted", columns="extended", values="worst")
lim = np.nanmax(np.abs(x.values)); im = ax.pcolormesh(x.columns, x.index, x.values, cmap=LinearSegmentedColormap.from_list("div", ["#b02c2c", "#e34948", "#f2a7a6", "#f0efec", "#86b6ef", "#2a78d6", "#0d366b"]),
                                                       norm=TwoSlopeNorm(0, -lim, lim), shading="nearest")
from matplotlib.colors import ListedColormap
EE, RRm = np.meshgrid(x.columns.values, x.index.values)
infeas = (EE > EXT_CAP + 0.2) | (EE - RRm > STROKE_CAP + 0.1)
ax.pcolormesh(x.columns, x.index, np.where(infeas & np.isfinite(x.values), 1.0, np.nan), cmap=ListedColormap([SURF]), alpha=0.78, shading="nearest", zorder=2)
ax.text(318, 236, "outside your limits", fontsize=10, color=INK2, ha="center", zorder=3)
ax.axvline(EXT_CAP, color=INK, lw=1.6, ls="--"); ax.text(EXT_CAP + 1.5, 132, "300 mm\nreach limit", fontsize=9, color=INK)
xx = np.array([228, 330]); ax.plot(xx, xx - STROKE_CAP, color=INK, lw=1.6, ls="--"); ax.text(305, 305 - STROKE_CAP - 7, "100 mm stroke limit", fontsize=9, color=INK, rotation=33)
ax.plot(xx, xx - 80, color=INK2, lw=1, ls=":"); ax.text(231, 231 - 80 + 3, "80 mm stroke (fits today's height)", fontsize=8.5, color=INK2, rotation=33)
for p, lab in [(P[6], "recommended"), (P[4], "80 mm option"), (P[2], "static")]:
    ax.plot(p["extended"], p["retracted"], "o", ms=12, mfc="none", mec=INK, mew=2)
    ax.annotate(f"{lab}\n{p['retracted']:.0f} -> {p['extended']:.0f}", (p["extended"], p["retracted"]), xytext=(-70, 8), textcoords="offset points", fontsize=9, color=INK,
                bbox=dict(boxstyle="round,pad=0.2", fc=SURF, ec="none", alpha=0.9))
cb = fig.colorbar(im, ax=ax, pad=0.01); cb.set_label("worst-case gain vs today (%)", color=INK2); cb.outline.set_visible(False)
ax.grid(False); ax.set_xlabel("extended runner length above flange (mm)"); ax.set_ylabel("retracted runner length above flange (mm)")
head(fig, "The feasible design space (2.75 L box)", "Buildable = left of the 300 mm reach line and above the 100 mm stroke line (greyed = outside). The best robust designs sit in the corner where both limits meet.", NOTE)
fig.subplots_adjust(left=0.07, right=0.99, top=TOP(fig) - 0.02, bottom=0.1); save(fig, "T3_feasible_space.png")

# ---------------- packages: scores + costs (small multiples) ----------------
names = [p["name"] for p in P]
metrics = [("worst", "worst case (robust)"), ("6-12k", "6-12k (P1)"), ("7-10.5k", "7-10.5k midrange"), ("10.5-12.5k", "10.5-12.5k top end")]
fig, axs = plt.subplots(1, 4, figsize=(18, 0.55 * len(P) + 2.6), sharey=True)
for ax, (k, nm) in zip(axs, metrics):
    v = [p[k] for p in P]
    ax.barh(range(len(P)), v, height=0.58, color=["#2a78d6" if "recommended" in n else "#86b6ef" for n in names], zorder=2)
    for i, x_ in enumerate(v): ax.text(x_ + (0.15 if x_ >= 0 else -0.15), i, f"{x_:+.1f}", va="center", ha="left" if x_ >= 0 else "right", fontsize=9.5, color=INK)
    ax.axvline(0, color=INK, lw=1); ax.set_title(nm, loc="left", fontsize=12, fontweight="semibold", color=INK); ax.grid(axis="y", visible=False)
    ax.set_xlim(min(-0.8, min(v) - 0.8), max(v) + 1.6)
axs[0].set_yticks(range(len(P))); axs[0].set_yticklabels(names, fontsize=10); axs[0].invert_yaxis()
head(fig, "Shortlist: complete intake packages", "Gain vs today's intake (%). Each package includes the best restrictor that fits ~125 mm (5° half-angle class) unless noted. Recommended package highlighted.", NOTE)
fig.subplots_adjust(left=0.2, right=0.99, top=TOP(fig) - 0.03, bottom=0.12, wspace=0.08); save(fig, "T4_packages_scores.png")

fig, axs = plt.subplots(2, 1, figsize=(15, 10.5), sharex=True, gridspec_kw=dict(height_ratios=[1.5, 1]))
axs[0].axvspan(6, 12, color="#f4f3ef", zorder=0)
show = [0, 2, 4, 6]; cols = [INK, "#eb6834", "#1baf7a", "#2a78d6"]
for i, c in zip(show, cols):
    p = P[i]; axs[0].plot(R / 1000, TODAY * p["T"] / S.base, color=c, lw=2.6 if i == 0 else 2.2, label=f"{p['name'].split('  ')[1]}: worst {p['worst']:+.1f} %, 6-12k {p['6-12k']:+.1f} %")
    if p["stroke"]: axs[1].plot(R / 1000, OUTSIDE0 + p["sch"], color=c, lw=2.2, drawstyle="steps-mid")
axs[0].set_ylabel("wheel torque (N·m)"); axs[0].legend(fontsize=9.5, loc="lower center")
axs[0].set_title("Torque", loc="left", fontsize=12.5, fontweight="semibold", color=INK)
axs[1].axhline(OUTSIDE0, color=INK, lw=1.2, ls="--"); axs[1].axhline(EXT_CAP, color=INK2, lw=1, ls=":"); axs[1].text(4.05, EXT_CAP + 3, "300 mm reach limit", fontsize=9, color=INK2)
axs[1].set_ylabel("runner length above flange (mm)"); axs[1].set_xlabel("engine speed (krpm)")
axs[1].set_title("VRLI ECU schedule (up-sweep, 200 mm/s)", loc="left", fontsize=12.5, fontweight="semibold", color=INK)
head(fig, "Shortlisted packages: torque and runner schedule", "Today vs the best static package vs the two VRLI candidates inside the 300 mm / 100 mm limits.", NOTE)
fig.subplots_adjust(left=0.06, right=0.99, top=TOP(fig) - 0.02, bottom=0.07, hspace=0.18); save(fig, "T5_packages_curves.png")

# ---------------- decision table ----------------
fig, ax = plt.subplots(figsize=(17.5, 0.42 * len(P) + 1.9)); ax.axis("off")
cols_ = ["package", "box", "runner in -> out", "restrictor", "worst", "6-12k", "midrange", "top end", "mass", "plenum h", "throttle t90"]
cell = [[p["name"], f"{p['V']:g} L", f"{p['retracted']:.0f} -> {p['extended']:.0f} mm" if p["stroke"] else f"{p['retracted']:.0f} mm fixed",
         f"{p['restrictor_mm']:.0f} mm ({p['restrictor']})", f"{p['worst']:+.1f} %", f"{p['6-12k']:+.1f} %", f"{p['7-10.5k']:+.1f} %", f"{p['10.5-12.5k']:+.1f} %",
         f"{p['mass_kg']:.2f} kg" if p["stroke"] else "-", f"{p['plenum_h_mm']:.0f} mm", f"{p['t90_ms']:.0f} ms"] for p in P]
tb = ax.table(cellText=cell, colLabels=cols_, cellLoc="center", colLoc="center", bbox=[0, 0, 1, 1], colWidths=[0.24, 0.05, 0.1, 0.12, 0.06, 0.06, 0.07, 0.06, 0.06, 0.07, 0.08])
tb.auto_set_font_size(False); tb.set_fontsize(10)
for (i, j), c in tb.get_celld().items():
    c.set_edgecolor(GRID); c.set_linewidth(0.8)
    if i == 0: c.set_text_props(color=INK, fontweight="semibold"); c.set_facecolor("#f0efec")
    else:
        rec = "recommended" in P[i - 1]["name"]; c.set_facecolor("#e8f1fc" if rec else SURF)
        if rec: c.set_text_props(fontweight="semibold", color=INK)
        if j == 0: c.set_text_props(ha="left"); c._loc = "left"
head(fig, "Decision table: intake packages inside the 300 mm / 100 mm limits", "Worst = robust score over dyno bands, four real duty cycles and the model's 4 % rpm offset. Throttle t90 = time to 90 % torque after a 6000 rpm snap.", NOTE)
fig.subplots_adjust(left=0.01, right=0.99, top=TOP(fig) - 0.02, bottom=0.05); save(fig, "T6_decision_table.png")
