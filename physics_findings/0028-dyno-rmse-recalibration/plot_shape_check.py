"""Shape check requested by Nick 2026-06-10: old model (production set as
shipped in v4.3.2) vs new model (0028 calibration) vs the real team dynos,
power AND torque, both engines. Wheel-side everywhere (sim x 0.85)."""
from __future__ import annotations
import csv, json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
ETA = 0.85


def sim_curve(variant: str, eng: str, field: str):
    rows = []
    for line in open(HERE / f"results_{variant}_{eng}.ndjson"):
        d = json.loads(line)
        if d.get("kind") == "trial":
            rows.append((d["rpm"], d[field] * ETA))
    rows.sort()
    return [r for r, _ in rows], [v for _, v in rows]


def dyno_pts(eng: str, col: str):
    pts = []
    p = ROOT / f"physics_findings/references/dyno/{eng}-team-dyno.csv"
    for r in csv.DictReader(open(p)):
        if r[col]:
            pts.append((float(r["rpm"]), float(r[col])))
    pts.sort()
    return [r for r, _ in pts], [v for _, v in pts]


PANELS = [
    ("brake_power_kW", "brake_power_kW", "wheel power (kW)"),
    ("brake_torque_Nm", "brake_torque_Nm", "wheel torque (Nm)"),
]

fig, axes = plt.subplots(2, 2, figsize=(13, 9), sharex="col")
fig.patch.set_facecolor("#0E0E10")
for row, (sim_field, dyno_col, ylabel) in enumerate(PANELS):
    for col, eng in enumerate(("sdm26", "sdm25")):
        ax = axes[row][col]
        ax.set_facecolor("#0E0E10")
        dx, dy = dyno_pts(eng, dyno_col)
        ax.scatter(dx, dy, s=30, c="#CE93D8", zorder=5, label="team dyno")
        x, y = sim_curve("prod", eng, sim_field)
        ax.plot(x, y, "-.", color="#4FC3F7", lw=2, label="old model (v4.3.2)")
        x, y = sim_curve("shipped", eng, sim_field)
        ax.plot(x, y, "-", color="#FFC627", lw=2.2, label="new model (0028)")
        if row == 0:
            ax.set_title(eng.upper(), color="#D8DCE2", fontsize=13)
        if col == 0:
            ax.set_ylabel(ylabel, color="#9097A0")
        if row == 1:
            ax.set_xlabel("RPM", color="#9097A0")
        ax.tick_params(colors="#9097A0")
        for s in ax.spines.values():
            s.set_color("#2A2C32")
        ax.grid(color="#2A2C32", lw=0.5, alpha=0.6)
axes[0][0].legend(facecolor="#16171B", edgecolor="#2A2C32",
                  labelcolor="#D8DCE2", fontsize=9, loc="lower right")
fig.suptitle("Old vs new model vs team dyno — wheel power & torque",
             color="#D8DCE2", fontsize=14)
fig.tight_layout(rect=(0, 0, 1, 0.97))
fig.savefig(HERE / "fig_0028_shape_check.png", dpi=150,
            facecolor=fig.get_facecolor())
print("wrote fig_0028_shape_check.png")
