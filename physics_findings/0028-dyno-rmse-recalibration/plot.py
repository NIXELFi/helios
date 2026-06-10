"""Figure for finding 0028: wheel power vs the real team dynos for the
legacy defaults, the production knob set, and the shipped 0028 calibration."""
from __future__ import annotations
import csv, json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
ETA = 0.85

VARIANTS = [
    ("all_off", "legacy defaults", "#888888", "--"),
    ("prod", "production knobs (0021)", "#4FC3F7", "-."),
    ("shipped", "0028 calibration (shipped)", "#FFC627", "-"),
]


def sim_curve(variant: str, eng: str):
    rows = []
    for line in open(HERE / f"results_{variant}_{eng}.ndjson"):
        d = json.loads(line)
        if d.get("kind") == "trial":
            rows.append((d["rpm"], d["brake_power_kW"] * ETA))
    rows.sort()
    return [r for r, _ in rows], [p for _, p in rows]


def dyno_curve(eng: str):
    pts = []
    p = ROOT / f"physics_findings/references/dyno/{eng}-team-dyno.csv"
    for r in csv.DictReader(open(p)):
        if r["brake_power_kW"]:
            pts.append((float(r["rpm"]), float(r["brake_power_kW"])))
    pts.sort()
    return [r for r, _ in pts], [p for _, p in pts]


fig, axes = plt.subplots(1, 2, figsize=(13, 5.5), sharey=True)
fig.patch.set_facecolor("#0E0E10")
for ax, eng in zip(axes, ("sdm26", "sdm25")):
    ax.set_facecolor("#0E0E10")
    dx, dy = dyno_curve(eng)
    ax.scatter(dx, dy, s=28, c="#CE93D8", zorder=5, label="team dyno (wheel)")
    for variant, label, color, ls in VARIANTS:
        x, y = sim_curve(variant, eng)
        ax.plot(x, y, ls, color=color, lw=2, label=label)
    ax.set_title(f"{eng.upper()} — wheel power vs team dyno", color="#D8DCE2")
    ax.set_xlabel("RPM", color="#9097A0")
    ax.tick_params(colors="#9097A0")
    for s in ax.spines.values():
        s.set_color("#2A2C32")
    ax.grid(color="#2A2C32", lw=0.5, alpha=0.6)
axes[0].set_ylabel("wheel power (kW)", color="#9097A0")
axes[0].legend(facecolor="#16171B", edgecolor="#2A2C32", labelcolor="#D8DCE2", fontsize=9)
fig.tight_layout()
fig.savefig(HERE / "fig_0028_calibration_vs_dyno.png", dpi=150,
            facecolor=fig.get_facecolor())
print("wrote fig_0028_calibration_vs_dyno.png")
