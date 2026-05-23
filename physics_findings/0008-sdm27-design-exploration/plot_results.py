#!/usr/bin/env python3
"""SDM27 design-exploration plots.

fig01: BP curves of 7 candidates vs FSAE dyno + stock dyno
fig02: torque curves
fig03: design-metric bar chart (peak BP / peak torque / AUC / smoothness)
fig04: C4 runner-length parametric optimization
fig05: design recommendation summary
"""
import csv, json, math
from pathlib import Path
import matplotlib.pyplot as plt
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
D = ROOT / "physics_findings/0008-sdm27-design-exploration"
ETA = 0.85

def load(p):
    out = {}
    with open(p) as f:
        for line in f:
            d = json.loads(line)
            if d.get('kind')=='trial':
                out[int(d['rpm'])] = d
    return out

def load_dyno(name):
    out = {}
    with open(ROOT / f'physics_findings/references/dyno/cbr600rr-{name}.csv') as f:
        for r in csv.DictReader(f):
            out[int(float(r['rpm']))] = float(r['brake_power_kW'])
    return out

CANDIDATES = [
    ("C1_sdm26_baseline",         "C1: SDM26 baseline (67×42.5mm, 245mm runner, 1.5L plenum)", "tab:red",    "o"),
    ("C2_short_runner_high_peak", "C2: 150mm runner",                                          "tab:orange", "s"),
    ("C3_long_runner_torquey",    "C3: 350mm runner (torque)",                                 "tab:purple", "^"),
    ("C4_big_bore_oversquare",    "C4: 75×33.9mm oversquare ★ BEST",                          "tab:green",  "*"),
    ("C5_small_bore_undersquare", "C5: 62×49.6mm undersquare",                                 "tab:olive",  "v"),
    ("C6_big_plenum",             "C6: 3.0L plenum (smoother)",                                "tab:brown",  "D"),
    ("C7_smart_combo",            "C7: 200mm runner + 2.0L plenum",                            "tab:blue",   "P"),
]

dyno_r = load_dyno('fsae-restricted')
dyno_u = load_dyno('stock-unrestricted')
data = {n: load(D / f"results_{n}.ndjson") for n,_,_,_ in CANDIDATES}
rpms = sorted(data["C1_sdm26_baseline"].keys())

# ---------- Figure 1: BP curves ----------
fig, ax = plt.subplots(figsize=(13, 7))
for n, label, color, marker in CANDIDATES:
    ys = [data[n].get(r, {}).get('brake_power_kW', np.nan) * ETA for r in rpms]
    lw = 2.5 if "BEST" in label else 1.6
    ms = 10 if "BEST" in label else 7
    ax.plot(rpms, ys, color=color, marker=marker, lw=lw, ms=ms, label=label, alpha=0.85)
ax.plot(rpms, [dyno_r.get(r, np.nan) for r in rpms],
        "k-x", lw=2.5, ms=10, label="FSAE-restricted dyno (CBR600 reference)")
ax.plot(rpms, [(dyno_u.get(r, np.nan) or np.nan) * ETA for r in rpms],
        color="gray", marker="*", lw=1.4, ms=10, ls=":", alpha=0.5,
        label=f"stock-unrestricted × {ETA} (est. wheel)")
ax.axhspan(41, 52, color="black", alpha=0.06, label="FSAE peak band 41-52 kW")
ax.set_xlabel("Engine RPM", fontsize=12)
ax.set_ylabel("wheel_power [kW]  (sim_brake × 0.85)", fontsize=12)
ax.set_title("0008 — SDM27 candidate brake-power curves (production knob set, 599cc, 4-cyl, 20mm restrictor)",
             fontsize=13, fontweight="bold")
ax.grid(True, alpha=0.3)
ax.legend(loc="lower right", fontsize=9)
fig.tight_layout()
fig.savefig(D / "fig01_sdm27_candidate_bp_curves.png", dpi=140, bbox_inches="tight")
plt.close(fig)

# ---------- Figure 2: torque curves ----------
fig, ax = plt.subplots(figsize=(13, 7))
for n, label, color, marker in CANDIDATES:
    bps = [data[n].get(r, {}).get('brake_power_kW', np.nan) * ETA for r in rpms]
    # torque [Nm] = power[W] / omega[rad/s] = bp*1000 / (rpm*2π/60)
    torques = [bp*1000 / (r * 2 * math.pi / 60) if not np.isnan(bp) else np.nan for bp, r in zip(bps, rpms)]
    lw = 2.5 if "BEST" in label else 1.6
    ms = 10 if "BEST" in label else 7
    ax.plot(rpms, torques, color=color, marker=marker, lw=lw, ms=ms, label=label, alpha=0.85)
# Dyno torque
d_torques = [dyno_r[r]*1000/(r*2*math.pi/60) if r in dyno_r else np.nan for r in rpms]
ax.plot(rpms, d_torques, "k-x", lw=2.5, ms=10, label="FSAE dyno (wheel-torque)")
ax.set_xlabel("Engine RPM", fontsize=12)
ax.set_ylabel("wheel_torque [Nm]", fontsize=12)
ax.set_title("0008 — SDM27 candidate torque curves", fontsize=13, fontweight="bold")
ax.grid(True, alpha=0.3)
ax.legend(loc="upper right", fontsize=9)
fig.tight_layout()
fig.savefig(D / "fig02_sdm27_candidate_torque.png", dpi=140, bbox_inches="tight")
plt.close(fig)

# ---------- Figure 3: 4-metric bar chart ----------
metrics = {}
for n, _, _, _ in CANDIDATES:
    bps = [data[n].get(r, {}).get('brake_power_kW', np.nan) * ETA for r in rpms]
    torques = [bp*1000/(r*2*math.pi/60) for bp, r in zip(bps, rpms) if not np.isnan(bp)]
    peak_bp = max(bps); rpp = rpms[bps.index(peak_bp)]
    peak_t = max(torques); rpt = rpms[torques.index(peak_t)]
    auc = sum((bps[i] + bps[i+1])/2 * (rpms[i+1]-rpms[i]) for i in range(len(bps)-1)) / 1000
    op = [bps[i] for i, r in enumerate(rpms) if 8000 <= r <= 12000]
    cv = math.sqrt(sum((x-sum(op)/len(op))**2 for x in op)/len(op)) / (sum(op)/len(op))
    metrics[n] = {'peak_bp': peak_bp, 'peak_t': peak_t, 'auc': auc, 'cv': cv,
                  'rpp': rpp, 'rpt': rpt}

fig, axes = plt.subplots(2, 2, figsize=(15, 10))
labels_short = [c[0].replace("_", "\n", 1)[:30] for c in CANDIDATES]
colors = [c[2] for c in CANDIDATES]

# Peak BP
ax = axes[0, 0]
vals = [metrics[c[0]]['peak_bp'] for c in CANDIDATES]
bars = ax.bar(labels_short, vals, color=colors, alpha=0.85)
for b, v, c in zip(bars, vals, CANDIDATES):
    ax.text(b.get_x() + b.get_width()/2, v + 0.3, f"{v:.1f} @ {metrics[c[0]]['rpp']}",
            ha="center", fontsize=8)
ax.set_ylabel("Peak BP_wheel [kW]")
ax.set_title("Peak power (higher = more peak)")
ax.tick_params(axis='x', labelsize=7)
ax.grid(True, alpha=0.3, axis='y')

# Peak torque
ax = axes[0, 1]
vals = [metrics[c[0]]['peak_t'] for c in CANDIDATES]
bars = ax.bar(labels_short, vals, color=colors, alpha=0.85)
for b, v, c in zip(bars, vals, CANDIDATES):
    ax.text(b.get_x() + b.get_width()/2, v + 0.1, f"{v:.1f} @ {metrics[c[0]]['rpt']}",
            ha="center", fontsize=8)
ax.set_ylabel("Peak Torque_wheel [Nm]")
ax.set_title("Peak torque (higher = more torque)")
ax.tick_params(axis='x', labelsize=7)
ax.grid(True, alpha=0.3, axis='y')

# AUC
ax = axes[1, 0]
vals = [metrics[c[0]]['auc'] for c in CANDIDATES]
bars = ax.bar(labels_short, vals, color=colors, alpha=0.85)
for b, v in zip(bars, vals):
    ax.text(b.get_x() + b.get_width()/2, v + 1, f"{v:.0f}", ha="center", fontsize=8)
ax.set_ylabel("Power-RPM area [kW·krpm]")
ax.set_title("Area under BP curve (higher = more total area)")
ax.tick_params(axis='x', labelsize=7)
ax.grid(True, alpha=0.3, axis='y')

# Smoothness (lower CV = smoother)
ax = axes[1, 1]
vals = [metrics[c[0]]['cv']*100 for c in CANDIDATES]
bars = ax.bar(labels_short, vals, color=colors, alpha=0.85)
for b, v in zip(bars, vals):
    ax.text(b.get_x() + b.get_width()/2, v + 0.15, f"{v:.1f}%", ha="center", fontsize=8)
ax.set_ylabel("Coefficient of variation (8-12 kRPM) [%]")
ax.set_title("Smoothness (lower = smoother delivery in FSAE op range)")
ax.tick_params(axis='x', labelsize=7)
ax.grid(True, alpha=0.3, axis='y')

fig.suptitle("0008 — SDM27 candidate design-metric comparison", fontsize=14, fontweight="bold")
fig.tight_layout()
fig.savefig(D / "fig03_design_metrics.png", dpi=140, bbox_inches="tight")
plt.close(fig)

# ---------- Figure 4: C4 runner-length optimization ----------
fig, ax = plt.subplots(figsize=(12, 6.5))
rl_data = {}
for rl_str in ['0p15','0p18','0p22','0p245','0p28','0p32','0p40']:
    rl_data[float(rl_str.replace('p','.'))] = load(D / f"results_C4_runner_{rl_str}.ndjson")
rpms_c4 = sorted(rl_data[0.245].keys())
cmap = plt.cm.viridis(np.linspace(0, 1, len(rl_data)))
for (rl, d), color in zip(sorted(rl_data.items()), cmap):
    bps = [d.get(r, {}).get('brake_power_kW', np.nan)*ETA for r in rpms_c4]
    is_baseline = (rl == 0.245)
    lw = 2.5 if is_baseline else 1.5
    ms = 9 if is_baseline else 6
    marker = "*" if is_baseline else "o"
    label = f"runner = {rl*1000:.0f} mm" + (" ★" if is_baseline else "")
    ax.plot(rpms_c4, bps, color=color, lw=lw, marker=marker, ms=ms, label=label)
ax.plot(rpms_c4, [dyno_r.get(r, np.nan) for r in rpms_c4],
        "k-x", lw=2.5, ms=10, label="FSAE dyno")
ax.set_xlabel("Engine RPM", fontsize=12)
ax.set_ylabel("wheel_power [kW]", fontsize=12)
ax.set_title("0008 — C4 (75×33.9mm oversquare) runner-length optimization\n"
             "Sweet spot: 0.245m (45.3 kW peak); shorter shifts peak earlier; longer kills top-end",
             fontsize=12, fontweight="bold")
ax.grid(True, alpha=0.3)
ax.legend(loc="lower center", fontsize=8, ncol=4)
fig.tight_layout()
fig.savefig(D / "fig04_C4_runner_optimization.png", dpi=140, bbox_inches="tight")
plt.close(fig)

# ---------- Figure 5: SDM27 recommendation summary ----------
fig, ax = plt.subplots(figsize=(11, 6.5))
# Just C1 baseline vs C4 winner vs C7 smart_combo, with FSAE dyno
keep = ["C1_sdm26_baseline", "C4_big_bore_oversquare", "C7_smart_combo"]
for n in keep:
    label = next(c[1] for c in CANDIDATES if c[0]==n)
    color = next(c[2] for c in CANDIDATES if c[0]==n)
    marker = next(c[3] for c in CANDIDATES if c[0]==n)
    ys = [data[n].get(r, {}).get('brake_power_kW', np.nan) * ETA for r in rpms]
    lw = 3.0 if n == "C4_big_bore_oversquare" else 2.0
    ax.plot(rpms, ys, color=color, marker=marker, lw=lw, ms=9, label=label)
ax.plot(rpms, [dyno_r.get(r, np.nan) for r in rpms],
        "k-x", lw=2.5, ms=11, label="FSAE-restricted dyno (CBR600 reference)")
ax.axhspan(41, 52, color="black", alpha=0.06, label="FSAE peak band 41-52 kW")
ax.set_xlabel("Engine RPM", fontsize=12)
ax.set_ylabel("wheel_power [kW]", fontsize=12)
ax.set_title("0008 — SDM27 design recommendation: oversquare beats stock CBR-class geometry\n"
             "C4 (75mm bore, 33.9mm stroke) is ~2 kW higher peak BP, smoother delivery, more AUC",
             fontsize=12, fontweight="bold")
ax.grid(True, alpha=0.3)
ax.legend(loc="lower right", fontsize=10)
# Annotate the WINNER's peak
c4_peak_rpm = metrics["C4_big_bore_oversquare"]['rpp']
c4_peak_bp = metrics["C4_big_bore_oversquare"]['peak_bp']
ax.annotate(f"C4 peak: {c4_peak_bp:.1f} kW @ {c4_peak_rpm} RPM",
            xy=(c4_peak_rpm, c4_peak_bp), xytext=(c4_peak_rpm + 800, c4_peak_bp + 4),
            arrowprops=dict(facecolor='tab:green', shrink=0.05, width=2),
            fontsize=11, fontweight="bold", color="darkgreen")
fig.tight_layout()
fig.savefig(D / "fig05_sdm27_recommendation.png", dpi=140, bbox_inches="tight")
plt.close(fig)

print("Wrote 5 figures to", D)
print("\nSummary metrics:")
for n, label, _, _ in CANDIDATES:
    m = metrics[n]
    print(f"  {n:30s}  peak {m['peak_bp']:.1f} kW @ {m['rpp']}, torque {m['peak_t']:.1f} Nm @ {m['rpt']}, AUC {m['auc']:.0f}, CV {m['cv']*100:.1f}%")
