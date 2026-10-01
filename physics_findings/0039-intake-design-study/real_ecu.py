"""Finding 0039: the recommended intake driven by REAL SDM26 ECU logs.

Every usable real session (Josh AX 4-26 G4X logs; 4-16 driver-selection and 4-19 mock-endurance MoTeC logs) is run
through the same VRLI controller as the video (vrli_control_new: direct 1D runs, 198-298 mm, 2.75 L box, 123 mm venturi,
200 mm/s servo with rpm low-pass + lead). On-throttle = TPS >= 60 % (as logged; closed reads ~15-18 %).
Also: the best FIXED runner in the same new box, and a first-order time estimate (extra wheel force on throttle ->
extra speed, thrown away at every lift; 1st gear excluded as traction-limited; effective mass 300 kg).
Writes charts/real_ecu/*.png and real_ecu_sessions.csv.
"""
import glob, sys
from vrli_common import *
import vrli_common
sys.path.insert(0, os.path.join(H, "video"))
import vrli_control_new as vc

OUT = vrli_common.OUT = os.path.join(H, "charts", "real_ecu"); os.makedirs(OUT, exist_ok=True)
GEARS = [2.75, 2.0, 1.667, 1.444, 1.304, 1.208]; PRIMARY, FINAL, RW, ETA, MEFF = 2.111, 3.0, 0.2, 0.85, 300.0
CURVE = json.load(open(r"C:\Users\nick5\fsae-sim\sim\data\sdm26-torque.json"))["points"]
CR, CT = np.array([p["rpm"] for p in CURVE], float), np.array([p["torqueNm"] for p in CURVE], float)   # crank torque, car's dyno
D = vc.Design(lo=198.1, hi=298.1)
# throttle response (tip-in runs, tipin_c160.ndjson): extra full-torque time lost per throttle snap with the 2.75 L box at the
# new runner range (ext -40..+35 mean) vs today's 1.44 L / 248 mm: +15.9 ms at 6000 rpm, +10.6 ms at 8500 rpm
# (1.44 L box at the same runner range: +2.6 ms at 6000, -0.1 ms at 8500). A snap is weighted by how far the throttle
# closed (logged TPS 60 -> 17 = full) and how long it stayed shut (plenum drain time ~0.18 s).
BOXCFG = {2.75: ("newintake.ndjson", [15.9, 10.6]), 1.44: ("newintake_box1.44.ndjson", [2.6, -0.1])}
BOX = float(sys.argv[sys.argv.index("--box") + 1]) if "--box" in sys.argv else 2.75
vc.load(os.path.join(H, BOXCFG[BOX][0])); D = vc.Design(lo=198.1, hi=298.1)
TIPIN_DEF_MS = lambda r: float(np.interp(r, [6000, 8500], BOXCFG[BOX][1]))
if BOX != 2.75: OUT = vrli_common.OUT = os.path.join(H, "charts", "real_ecu", f"box{BOX:g}"); os.makedirs(OUT, exist_ok=True)

def sessions():
    out = []
    for f in sorted(glob.glob(os.path.join(H, "data", "josh_raw", "SDM26 Josh Autocross *.csv"))):
        x = pd.read_csv(f, skiprows=[0, 2], usecols=["Section Time", "Engine Speed", "TPS (Main)", "Gear"], low_memory=False)
        x.columns = ["time_s", "rpm", "tps", "gear"]; x = x.iloc[::4]                       # 200 -> 50 Hz
        out.append(("Josh AX 4-26 #" + f[-5], "Josh", "AX 4-26 (G4X)", x))
    S_ = pd.read_csv(os.path.join(H, "data", "ld_sessions.csv")); S_ = S_[S_.used]
    for r in S_.itertuples():
        f = os.path.join(H, "data", "ld_traces", r.session + ".csv")
        if not os.path.exists(f): continue
        x = pd.read_csv(f, usecols=["time_s", "rpm", "tps", "gear"])
        if r._2 == "autocross": x["gear"] = 2                                                 # 4-16: single gear (2nd), gear channel not logged
        drv = r.session.split("__")[1].replace("+_", "+ ").replace("_", " ")
        ev = "AX 4-16 (MoTeC)" if r._2 == "autocross" else "Endurance 4-19 (MoTeC)"
        out.append((f"{drv} {ev.split(' (')[0]} #{r.session.split('__')[-1]}", drv.split(" ")[0], ev, x))
    return out

def analyse(name, drv, ev, x, Dz=None):
    Dz = Dz or D
    t, rpm, tps = x.time_s.values.astype(float), x.rpm.values.astype(float), x.tps.values.astype(float)
    gear = np.nan_to_num(x.gear.values.astype(float), nan=0).astype(int)
    sim = vc.run_lap(t, rpm, tps, Dz)
    on = np.isfinite(sim["gain"]); dt = np.gradient(t)
    w = dt * on
    fixed = {p: np.nansum(np.where(on, np.array([vc.torque(p, r) / vc.base_torque(r) - 1 if o else 0 for r, o in zip(rpm, on)]), 0) * dt) / max(w.sum(), 1e-9) for p in vc.POSG}
    # first-order time estimate
    saved = 0.0; dv = 0.0; lag = 0.0; dvl = 0.0; tipins = 0
    tmin = pd.Series(tps).rolling(25, min_periods=1).min().values          # min TPS over the last 0.5 s
    offlen = np.zeros(len(t)); run_ = 0.0
    for k in range(len(t)): run_ = 0.0 if on[k] else run_ + dt[k]; offlen[k] = run_
    for k in range(len(t)):
        g = gear[k]
        if not on[k] or g < 2 or g > 6 or rpm[k] < 3000: dv = 0.0; dvl = 0.0; continue
        G = GEARS[g - 1] * PRIMARY * FINAL; v = rpm[k] * 2 * math.pi * RW / (60 * G)
        if v < 3: dv = 0.0; dvl = 0.0; continue
        Fw = np.interp(rpm[k], CR, CT) * G * ETA / RW
        if k and not on[k - 1]:                                             # throttle re-applied: charge the box's extra lag
            wgt = float(np.clip((60 - tmin[k]) / (60 - 17), 0, 1)) * (1 - math.exp(-offlen[k - 1] / 0.18))
            tipins += wgt; dvl += Fw * TIPIN_DEF_MS(rpm[k]) / 1000 / MEFF * wgt
        dv += Fw * sim["gain"][k] / MEFF * dt[k]; saved += dv / v * dt[k]; lag += dvl / v * dt[k]
    return dict(session=name, driver=drv, event=ev, onthr_s=float(w.sum()), median_rpm=float(np.nanmedian(rpm[on])) if on.any() else np.nan,
                gain=float(np.nansum(np.nan_to_num(sim["gain"]) * w) / max(w.sum(), 1e-9)) * 100,
                instant=float(np.nansum(np.nan_to_num(sim["ideal"]) * w) / max(w.sum(), 1e-9)) * 100,
                fixed=fixed, saved_s=saved, lag_s=lag, tipins=tipins, sim=sim, t=t, rpm=rpm, tps=tps, gear=gear)

RES = [analyse(*s) for s in sessions()]
RES = [r for r in RES if r["onthr_s"] >= 3]
# best single fixed runner in the new box, chosen on all real on-throttle time pooled
tot = sum(r["onthr_s"] for r in RES)
pool = {p: sum(r["fixed"][p] * r["onthr_s"] for r in RES) / tot for p in vc.POSG}
PF = max(pool, key=pool.get)
for r in RES: r["fixed_best"] = r["fixed"][PF] * 100
T = pd.DataFrame([{k: v for k, v in r.items() if k in ("session", "driver", "event", "onthr_s", "median_rpm", "gain", "instant", "fixed_best", "saved_s", "lag_s", "tipins")} for r in RES])
T["saved_per_min_onthr"] = T.saved_s / T.onthr_s * 60
T["net_s"] = T.saved_s - T.lag_s
# actuator speed sweep on the same real logs (acceleration limit scaled with speed)
SPEEDS = [200, 400, 800]
for sp in SPEEDS[1:]:
    Dsp = vc.Design(lo=198.1, hi=298.1, speed=sp, accel=15.0 * sp)
    T[f"gain_{sp}"] = [analyse(*s_, Dz=Dsp)["gain"] for s_ in sessions() if any(s_[0] == n for n in T.session)]
T.round(3).to_csv(os.path.join(OUT, "real_ecu_sessions.csv"), index=False)
pd.set_option("display.width", 220)
print(T.round(2).to_string(index=False))
E = T.groupby("event").apply(lambda g: pd.Series(dict(sessions=len(g), onthr_s=g.onthr_s.sum(), median_rpm=np.average(g.median_rpm, weights=g.onthr_s),
                                                       gain=np.average(g.gain, weights=g.onthr_s), instant=np.average(g.instant, weights=g.onthr_s),
                                                       fixed_best=np.average(g.fixed_best, weights=g.onthr_s), saved_per_min=g.saved_s.sum() / g.onthr_s.sum() * 60,
                                                       gain_400=np.average(g.gain_400, weights=g.onthr_s), gain_800=np.average(g.gain_800, weights=g.onthr_s),
                                                       tipins_per_min=g.tipins.sum() / g.onthr_s.sum() * 60, lag_per_min=g.lag_s.sum() / g.onthr_s.sum() * 60,
                                                       net_per_min=g.net_s.sum() / g.onthr_s.sum() * 60)), include_groups=False)
print("\nby event (on-throttle-time weighted):"); print(E.round(2).to_string()); print(f"best fixed runner in the new box: {PF:.0f} mm")
E.round(3).to_csv(os.path.join(OUT, "real_ecu_by_event.csv"))

# ---------------- E1: gain per session ----------------
EVC = {"AX 4-26 (G4X)": "#2a78d6", "AX 4-16 (MoTeC)": "#eb6834", "Endurance 4-19 (MoTeC)": "#1baf7a"}
T2 = T.sort_values(["event", "gain"]); fig, ax = plt.subplots(figsize=(14, 0.32 * len(T2) + 2.4))
for i, r in enumerate(T2.itertuples()):
    ax.plot([r.fixed_best, r.instant], [i, i], color=GRID, lw=7, solid_capstyle="round", zorder=1)
    ax.plot(r.fixed_best, i, "s", ms=7, color=MUTED, zorder=2); ax.plot(r.gain, i, "o", ms=8.5, color=EVC[r.event], mec=SURF, mew=1.3, zorder=3)
    ax.text(max(r.instant, r.gain) + 0.25, i, f"{r.gain:+.1f} %  ({r.onthr_s:.0f} s on throttle, median {r.median_rpm / 1000:.1f}k)", va="center", fontsize=8.6, color=INK2)
ax.set_yticks(range(len(T2))); ax.set_yticklabels(T2.session, fontsize=8.8); ax.axvline(0, color=INK, lw=1)
ax.set_xlabel("on-throttle torque gain vs today's intake (%)"); ax.set_xlim(min(-1, T2.fixed_best.min() - 0.5), T2.instant.max() + 7)
hh = [plt.Line2D([], [], ls="", marker="o", ms=8.5, color=c, label=f"new intake (VRLI), {e}") for e, c in EVC.items()]
hh += [plt.Line2D([], [], ls="", marker="s", ms=7, color=MUTED, label=f"fixed {PF:.0f} mm runner in the same new box"), plt.Line2D([], [], color=GRID, lw=7, label="up to an instant actuator")]
ax.legend(handles=hh, loc="lower right", fontsize=9)
head(fig, "The new intake on real SDM26 ECU logs", "Every usable session, driven through the 200 mm/s VRLI controller on the direct 1D torque runs. Gain is averaged over on-throttle time (TPS >= 60 %).", NOTE)
fig.subplots_adjust(left=0.27, right=0.98, top=TOP(fig) - 0.01, bottom=0.07); save(fig, "E1_sessions.png")

# ---------------- E2: real-session traces ----------------
pick = [max((r for r in RES if r["event"] == e), key=lambda r: r["onthr_s"]) for e in EVC if any(r["event"] == e for r in RES)]
fig, axs = plt.subplots(len(pick), 1, figsize=(16, 4.1 * len(pick)), squeeze=False)
for ax, r in zip(axs[:, 0], pick):
    s = r["sim"]; t0 = r["t"][np.argmax(np.isfinite(s["gain"]))] - 2; m = (r["t"] >= t0) & (r["t"] <= t0 + 60)
    tt = r["t"][m] - t0
    ax.fill_between(tt, 0, np.nan_to_num(s["gain"][m]) * 100, color=EVC[r["event"]], alpha=0.35, lw=0, label="gain on throttle (%)")
    ax.plot(tt, (s["act"][m] - 198.1) / 10, color=INK, lw=1.4, label="runner position (198 -> 298 mm, scaled 0-10)")
    ax.plot(tt, r["rpm"][m] / 1000, color=MUTED, lw=1, ls=":", label="rpm / 1000")
    ax.axhline(0, color=INK2, lw=0.6); ax.set_xlim(0, 60); ax.set_ylim(-6, 18); ax.legend(fontsize=8.8, loc="upper right", ncol=3)
    ax.set_title(f"{r['session']}: first 60 s on track, session gain {r['gain']:+.1f} %", loc="left", fontsize=11.5, fontweight="semibold", color=INK)
axs[-1, 0].set_xlabel("time (s)")
head(fig, "What the intake does on real driving", "First minute of the longest session from each event. Gain bands appear only while on throttle.", NOTE)
fig.subplots_adjust(left=0.05, right=0.99, top=TOP(fig) - 0.02, bottom=0.06, hspace=0.35); save(fig, "E2_traces.png")

# ---------------- E3: summary by event ----------------
fig, axs = plt.subplots(1, 2, figsize=(15, 4.4))
ev = list(E.index); y = np.arange(len(ev))
for k, (col, lab, c) in enumerate([("fixed_best", f"fixed {PF:.0f} mm in new box", MUTED), ("gain", "new intake (VRLI, 200 mm/s)", "#2a78d6"), ("instant", "instant actuator", "#86b6ef")]):
    axs[0].barh(y + (k - 1) * 0.26, E[col], height=0.24, color=c, label=lab)
    for yi, v in zip(y, E[col]): axs[0].text(v + 0.1, yi + (k - 1) * 0.26, f"{v:+.1f}", va="center", fontsize=9, color=INK)
axs[0].set_yticks(y); axs[0].set_yticklabels([f"{e}\n{E.loc[e, 'onthr_s']:.0f} s on throttle, median {E.loc[e, 'median_rpm'] / 1000:.1f}k" for e in ev], fontsize=9.5)
axs[0].axvline(0, color=INK, lw=1); axs[0].set_xlabel("on-throttle torque gain vs today (%)"); axs[0].legend(fontsize=9, loc="lower right"); axs[0].invert_yaxis()
axs[0].set_title("Torque gain", loc="left", fontsize=12, fontweight="semibold", color=INK)
axs[1].barh(y, E.saved_per_min, height=0.5, color=[EVC[e] for e in ev])
for yi, v in zip(y, E.saved_per_min): axs[1].text(v + 0.003, yi, f"{v:.3f} s", va="center", fontsize=10, color=INK)
axs[1].set_yticks(y); axs[1].set_yticklabels([]); axs[1].invert_yaxis(); axs[1].set_xlabel("estimated time saved per minute of on-throttle driving (s)")
axs[1].set_title("Rough time estimate", loc="left", fontsize=12, fontweight="semibold", color=INK)
head(fig, "Real ECU data: summary by event", "Weighted by on-throttle time. Time estimate: extra wheel force -> extra speed, discarded at every lift; 1st gear excluded (traction-limited); 300 kg effective mass.", NOTE)
fig.subplots_adjust(left=0.2, right=0.98, top=TOP(fig) - 0.04, bottom=0.14, wspace=0.08); save(fig, "E3_by_event.png")
