"""Round-review overlay for 0029: every variant vs base vs dyno, power +
torque, both engines. Run after every round and LOOK at it — a shape
regression (hump phasing, plateau loss) is a fail even if banded RMSE wins.
Usage: python plot_overlay.py [variant ...]   (default: all with results)"""
from __future__ import annotations
import csv, json, sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
ETA = 0.85
COLORS = ["#FFC627", "#4FC3F7", "#A5D6A7", "#F48FB1", "#FF8A65", "#80DEEA", "#FFF59D"]


def sim_curve(variant, eng, field):
    rows = []
    for line in open(HERE / f"results_{variant}_{eng}.ndjson"):
        d = json.loads(line)
        if d.get("kind") == "trial":
            rows.append((d["rpm"], d[field] * ETA))
    rows.sort()
    return [r for r, _ in rows], [v for _, v in rows]


def dyno_pts(eng, col):
    pts = []
    for r in csv.DictReader(open(ROOT / f"physics_findings/references/dyno/{eng}-team-dyno.csv")):
        if r[col]:
            pts.append((float(r["rpm"]), float(r[col])))
    pts.sort()
    return [r for r, _ in pts], [v for _, v in pts]


variants = sys.argv[1:] or sorted(
    {p.stem.removeprefix("results_").removesuffix("_sdm26")
     for p in HERE.glob("results_*_sdm26.ndjson")} - {"base"})

fig, axes = plt.subplots(2, 2, figsize=(13, 9), sharex="col")
fig.patch.set_facecolor("#0E0E10")
for row, (field, col, ylabel) in enumerate([
        ("brake_power_kW", "brake_power_kW", "wheel power (kW)"),
        ("brake_torque_Nm", "brake_torque_Nm", "wheel torque (Nm)")]):
    for c, eng in enumerate(("sdm26", "sdm25")):
        ax = axes[row][c]
        ax.set_facecolor("#0E0E10")
        dx, dy = dyno_pts(eng, col)
        ax.scatter(dx, dy, s=30, c="#CE93D8", zorder=5, label="team dyno")
        x, y = sim_curve("base", eng, field)
        ax.plot(x, y, "--", color="#9097A0", lw=1.8, label="base (0028)")
        for i, v in enumerate(variants):
            x, y = sim_curve(v, eng, field)
            ax.plot(x, y, "-", color=COLORS[i % len(COLORS)], lw=1.6, label=v)
        if row == 0:
            ax.set_title(eng.upper(), color="#D8DCE2", fontsize=13)
        if c == 0:
            ax.set_ylabel(ylabel, color="#9097A0")
        if row == 1:
            ax.set_xlabel("RPM", color="#9097A0")
        ax.tick_params(colors="#9097A0")
        for s in ax.spines.values():
            s.set_color("#2A2C32")
        ax.grid(color="#2A2C32", lw=0.5, alpha=0.6)
axes[0][0].legend(facecolor="#16171B", edgecolor="#2A2C32",
                  labelcolor="#D8DCE2", fontsize=8, loc="lower right")
fig.suptitle("0029 round review — variants vs base vs dyno", color="#D8DCE2")
fig.tight_layout(rect=(0, 0, 1, 0.97))
out = HERE / "fig_round_review.png"
fig.savefig(out, dpi=150, facecolor=fig.get_facecolor())
print(f"wrote {out.name}")
