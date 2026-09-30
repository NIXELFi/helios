# Finding 0038 figures: posterior bands vs car data, prior vs posterior per parameter.
import os, sys, json
import numpy as np, pandas as pd
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
from analyze import F, OUT, PF, GRID, car_ref, dyno, load, ND, wq

INK, INK2, GR, SURF = '#1f1e1c', '#52514e', '#e4e3df', '#fcfcfb'
BLUE, BLUE_L, ORANGE = '#2a78d6', '#9ec5f4', '#eb6834'
plt.rcParams.update({'font.size': 9, 'axes.edgecolor': INK2, 'axes.labelcolor': INK2, 'xtick.color': INK2, 'ytick.color': INK2,
                     'axes.facecolor': SURF, 'figure.facecolor': SURF, 'axes.grid': True, 'grid.color': GR,
                     'axes.spines.top': False, 'axes.spines.right': False, 'lines.linewidth': 2})
S = pd.read_csv(os.path.join(OUT, "samples_scored.csv"), index_col=0)
B = pd.read_csv(os.path.join(OUT, "bands.csv"))
P = pd.read_csv(os.path.join(OUT, "param_posterior.csv"))
summ = json.load(open(os.path.join(OUT, "summary.json")))
ref = pd.read_csv(os.path.join(PF, "references", "ecu", "ve_map_reference.csv")).set_index("bin")
tq_dyno = pd.read_csv(os.path.join(PF, "references", "dyno", "sdm26-team-dyno.csv")).set_index("rpm").brake_torque_Nm
_, d = load(ND)

fig, ax = plt.subplots(3, 1, figsize=(11, 13), sharex=True)
def band(a, qty, label):
    b = B[B.qty == qty].set_index("rpm").sort_index()
    x = b.index / 1000
    a.fill_between(x, b.prior_lo, b.prior_hi, color=GR, alpha=.9, lw=0, label="prior ensemble range (all samples)")
    a.fill_between(x, b["q2.5"], b["q97.5"], color=BLUE_L, alpha=.55, lw=0, label="posterior 95 %")
    a.fill_between(x, b.q10, b.q90, color=BLUE, alpha=.45, lw=0, label="posterior 80 %")
    a.plot(x, b.q50, color=BLUE, label=f"posterior median ({label})")
    return b
b = band(ax[0], "ve_norm", "model")
g = ref.reindex(GRID)
ax[0].plot(GRID / 1000, g.ve_map / g.ve_map.mean(), color=INK, lw=2.4, marker='o', ms=3, label="car MAP-VE (baro 97.3 kPa)")
ax[0].set_ylabel("VE / mean (4-10.75k)"); ax[0].set_ylim(0.78, 1.2)
ax[0].set_title(f"Airflow shape: posterior in-phase ripple slope {summ['slope_post'][1]:.2f} "
                f"(80 %: {summ['slope_post'][0]:.2f}-{summ['slope_post'][2]:.2f}); nominal 0036 = {summ['slope_nominal']:.2f}", loc='left')
ax[0].legend(fontsize=8, loc='lower center', ncol=2)
band(ax[1], "wheel_torque_Nm", "wheel = brake × fitted drivetrain η")
ax[1].plot(tq_dyno.index / 1000, tq_dyno.values, color=INK, lw=2.4, marker='o', ms=4, label="team dyno (wheel)")
ax[1].set_ylabel("wheel torque (N·m)"); ax[1].set_ylim(26, 54); ax[1].set_title("Wheel torque bands vs team dyno", loc='left')
ax[1].legend(fontsize=8, loc='lower center', ncol=2)
band(ax[2], "intake_dp_kPa", "model")
_, cdp = car_ref(97.3)
ax[2].plot(GRID / 1000, cdp.values, color=INK, lw=2.4, marker='o', ms=3, label="car baro − MAP (97.3 kPa)")
ax[2].set_ylabel("intake pressure drop (kPa)"); ax[2].set_xlabel("engine speed (krpm)"); ax[2].set_xlim(4, 12.6)
ax[2].set_title("Intake restriction bands vs the car", loc='left'); ax[2].legend(fontsize=8, loc='upper left')
fig.tight_layout(); fig.savefig(os.path.join(F, "fig_bands.png"), dpi=130); plt.close(fig)

n = len(P); cols = 4; rows = int(np.ceil(n / cols))
fig, ax = plt.subplots(rows, cols, figsize=(13, 2.8 * rows))
ax = ax.ravel()
w = S.weight.values
for i, r in P.iterrows():
    a = ax[i]; x = S["prior:" + r.param].values
    bins = np.linspace(r.prior_min, r.prior_max, 9)
    a.hist(x, bins=bins, color=GR, label="prior samples", density=True)
    a.hist(x, bins=bins, weights=w, color=BLUE, alpha=.8, label="posterior", density=True, rwidth=0.6)
    a.axvline(0.0 if r["mode"] == "delta" else 1.0, color=INK2, lw=1, ls='--')
    a.set_title(f"{r.param}\npost/prior sd {r.sd_ratio:.2f}", fontsize=8, loc='left'); a.tick_params(labelsize=7)
    a.set_yticks([])
for j in range(n, len(ax)): ax[j].axis('off')
ax[0].legend(fontsize=7)
fig.suptitle(f"Prior vs posterior (tempering T = {summ['temperature']:.2f}, ESS {summ['ess_tempered']:.1f}; dashed = 0036 value)", x=0.01, ha='left')
fig.tight_layout(); fig.savefig(os.path.join(F, "fig_params.png"), dpi=120); plt.close(fig)
print("ok")
