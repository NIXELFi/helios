# Finding 0037 figures + summary table from the `helios-bench vrli` outputs in out/<study>/.
# Usage (repo root or anywhere): python physics_findings/0037-vrli-stroke-optimization/plot.py
import json, os, sys
import numpy as np, pandas as pd
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
from matplotlib.colors import TwoSlopeNorm

H = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(H, "out")
INK, INK2, GR, SURF = '#1f1e1c', '#52514e', '#e4e3df', '#fcfcfb'
C = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4']
plt.rcParams.update({'font.size': 9, 'axes.edgecolor': INK2, 'axes.labelcolor': INK2, 'xtick.color': INK2, 'ytick.color': INK2,
                     'axes.facecolor': SURF, 'figure.facecolor': SURF, 'axes.grid': True, 'grid.color': GR,
                     'axes.spines.top': False, 'axes.spines.right': False, 'lines.linewidth': 2})
STUDIES = [("A_neutral_disp", "neutral tune, plenum displacement ON (physical)"),
           ("B_neutral_nodisp", "neutral tune, plenum volume held constant (plenum enlarged to compensate)"),
           ("C_loggedtune_disp", "logged car tune, displacement ON (reference)")]
have = [(s, l) for s, l in STUDIES if os.path.exists(os.path.join(OUT, s, "strokes.csv"))]

def load(s):
    d = os.path.join(OUT, s)
    return (pd.read_csv(os.path.join(d, "surface.csv")), pd.read_csv(os.path.join(d, "strokes.csv")),
            pd.read_csv(os.path.join(d, "ecu_map.csv")), json.load(open(os.path.join(d, "recommended.json"))))

# ---- summary table ----------------------------------------------------------
rows = []
for s, lab in have:
    surf, st, em, rec = load(s)
    fixed = st[st.stroke_mm == 0].iloc[0]
    for _, r in st.iterrows():
        rows.append(dict(study=s, stroke_mm=r.stroke_mm, runner_min_mm=rec["base_runner_length_mm"] + r.lmin_mm,
                         runner_max_mm=rec["base_runner_length_mm"] + r.lmax_mm, ext_min=r.lmin_mm, ext_max=r.lmax_mm,
                         P1_vs_asbuilt=100 * r.p1_gain, P1_table=100 * r.p1_gain_quantised,
                         P1_follow_6000rpm_s=100 * r.p1_gain_follow, P1_dp_bound=100 * r.p1_gain_rate_limited,
                         vs_best_fixed=100 * ((1 + r.p1_gain) / (1 + fixed.p1_gain) - 1),
                         driver_7_10k5=100 * r.driver_gain, P2=r.p2_ratio, P2_rpm=r.p2_rpm,
                         failsafe_ext=r.failsafe_mm, failsafe_gain=100 * r.failsafe_gain,
                         req_speed=r.required_speed_mm_s, avail_speed=r.available_speed_mm_s, jump_mm=r.max_map_jump_mm,
                         mass_kg=r.mass_kg, feasible=bool(r.feasible_mass) and bool(r.feasible_packaging)))
T = pd.DataFrame(rows)
T.round(3).to_csv(os.path.join(H, "summary.csv"), index=False)
pd.set_option("display.width", 250); pd.set_option("display.max_columns", 30)
print(T.round(2).to_string(index=False))
for s, _ in have:
    rec = load(s)[3]
    k, b = rec["recommended_knee"], rec["best_feasible"]
    print(s, "knee:", k and (k["stroke_mm"], k["lmin_mm"], round(100 * k["p1_gain"], 2)),
          "best feasible:", b and (b["stroke_mm"], b["lmin_mm"], round(100 * b["p1_gain"], 2)))

if not have:
    sys.exit("no study outputs yet")

# ---- figure 1: surface ------------------------------------------------------
s0, lab0 = have[0]
surf, st, em, rec = load(s0)
L0 = rec["base_runner_length_mm"]
P = surf.pivot(index="ext_mm", columns="rpm", values="brake_torque_Nm")
OK = surf.pivot(index="ext_mm", columns="rpm", values="converged").astype(bool)
rel = (P / P.loc[0.0] - 1.0).where(OK)          # unconverged (non-periodic) points blank
fig, ax = plt.subplots(1, 1, figsize=(11, 6.5))
lim = np.nanmax(np.abs(rel.values)) * 100
im = ax.pcolormesh(rel.columns / 1000, L0 + rel.index, rel.values * 100, cmap="RdBu", norm=TwoSlopeNorm(0, -lim, lim), shading="nearest")
cb = fig.colorbar(im, ax=ax); cb.set_label("brake torque vs as-built runner (%)")
best = P.where(OK).idxmax(axis=0)
ax.plot(best.index / 1000, L0 + best.values, color=INK, lw=1.4, ls=":", marker='.', ms=4, label="best length at each rpm (grid)")
k = rec["recommended_knee"] or rec["best_feasible"]
ax.plot(em.rpm / 1000, em.runner_length_mm, color=INK, lw=2.4, label=f"recommended ECU table ({k['stroke_mm']:.0f} mm stroke, F3-quantised)")
ax.axhspan(L0 + k["lmin_mm"], L0 + k["lmax_mm"], color=INK, alpha=0.06)
ax.axhline(L0, color=INK2, lw=1, ls="--"); ax.text(4.05, L0 + 3, "as-built SDM26 runner", color=INK2, fontsize=8)
mp = rec.get("max_protrusion_mm")
if mp is not None and rec.get("trumpet_od_mm", 0) > 0 and mp < 1e6:
    y = L0 + rec["displacement_ref_mm"] + rec["max_protrusion_mm"]
    ax.axhline(y, color=INK, lw=1, ls="-."); ax.text(4.05, y + 3, f"packaging: trumpets fill {100 * (1 - rec['min_plenum_fraction']):.0f} % of the plenum", color=INK, fontsize=8)
ax.axvspan(6, 12, color=INK, alpha=0.0)
ax.set_xlabel("engine speed (krpm)"); ax.set_ylabel("runner length incl. head port (mm)")
ax.set_title(f"Brake torque vs runner length and rpm — {lab0}", loc='left'); ax.legend(fontsize=8, loc="upper right")
fig.tight_layout(); fig.savefig(os.path.join(H, "fig_surface.png"), dpi=130)

# ---- figure 2: envelope -----------------------------------------------------
fig, ax = plt.subplots(2, 1, figsize=(11, 9), sharex=True)
best_fixed = st[st.stroke_mm == 0].iloc[0]
col = lambda e: P.apply(lambda c: np.interp(e, P.index.values, c.values))
a = ax[0]
a.plot(em.rpm / 1000, em.torque_baseline, color=INK, lw=2.6, label="as-built fixed runner (baseline)")
a.plot(P.columns / 1000, col(best_fixed.lmin_mm), color=C[3], ls="--", label=f"best fixed runner ({L0 + best_fixed.lmin_mm:.0f} mm)")
a.plot(em.rpm / 1000, em.torque_fixed_short, color=C[0], lw=1.3, label=f"VRLI fully short ({L0 + k['lmin_mm']:.0f} mm)")
a.plot(em.rpm / 1000, em.torque_fixed_long, color=C[2], lw=1.3, label=f"VRLI fully long ({L0 + k['lmax_mm']:.0f} mm)")
a.plot(em.rpm / 1000, em.torque_table, color=C[1], lw=2.6, label=f"VRLI {k['stroke_mm']:.0f} mm, ECU table, slow sweep (P1 {100 * k['p1_gain_quantised']:+.1f}%)")
a.plot(em.rpm / 1000, em.torque_follow, color=C[4], lw=1.6, ls="--", label=f"same table, plate chasing it in 1st gear, 6000 rpm/s (P1 {100 * k['p1_gain_follow']:+.1f}%)")
a.axvspan(6, 12, color=GR, alpha=0.35, lw=0); a.set_ylabel("brake torque (N·m)")
a.set_title("Torque: VRLI envelope vs fixed runners (grey = P1 band 6-12k)", loc='left'); a.legend(fontsize=8, loc="lower center")
a = ax[1]
for y, c, l in [(em.torque_table, C[1], "VRLI table (slow sweep)"), (em.torque_follow, C[4], "VRLI, 1st-gear sweep"),
                (col(best_fixed.lmin_mm).values, C[3], "best fixed runner"),
                (em.torque_fixed_short, C[0], "VRLI fully short"), (em.torque_fixed_long, C[2], "VRLI fully long")]:
    a.plot(em.rpm / 1000, (np.asarray(y) / em.torque_baseline - 1) * 100, color=c, label=l, lw=2.4 if c == C[1] else 1.4)
a.axhline(0, color=INK, lw=1); a.axvspan(6, 12, color=GR, alpha=0.35, lw=0)
a.set_ylabel("vs as-built (%)"); a.set_xlabel("engine speed (krpm)"); a.legend(fontsize=8)
fig.tight_layout(); fig.savefig(os.path.join(H, "fig_envelope.png"), dpi=130)

# ---- figure 3: gain vs stroke ----------------------------------------------
fig, ax = plt.subplots(2, 1, figsize=(10, 8), sharex=True)
for i, (s, lab) in enumerate(have):
    t = T[T.study == s]
    ax[0].plot(t.stroke_mm, t.P1_table, color=C[i], marker='o', ms=5, label=f"{lab}: ECU table, slow sweep")
    ax[0].plot(t.stroke_mm, t.P1_follow_6000rpm_s, color=C[i], ls="--", lw=1.3, label=f"{lab}: plate chasing table, 1st gear")
ax[0].axhline(5, color=INK2, lw=1, ls=":"); ax[0].text(1, 5.1, "P1 target +5 %", color=INK2, fontsize=8)
ax[0].axvline(100, color=INK2, lw=1, ls=":")
ax[0].set_ylabel("P1: avg brake torque 6-12k vs as-built (%)"); ax[0].set_title("Gain vs stroke (best placement per stroke)", loc='left')
ax[0].legend(fontsize=7.5)
t = T[T.study == have[0][0]]
ax[1].plot(t.stroke_mm, t.mass_kg, color=INK, marker='o', ms=5, label="added mass (CDR-based model)")
ax[1].axhline(1.5, color=INK2, lw=1, ls=":"); ax[1].text(1, 1.52, "C2 limit 1.5 kg", color=INK2, fontsize=8)
ax[1].set_ylabel("added mass (kg)"); ax[1].set_xlabel("stroke (mm)"); ax[1].legend(fontsize=8)
fig.tight_layout(); fig.savefig(os.path.join(H, "fig_pareto.png"), dpi=130)
print("figures written")
