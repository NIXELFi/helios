"""Progress summary requested by Nick 2026-06-10: how much better is the
model now? Legacy defaults vs the v4.3.2-shipped production set vs the
current 0028/0029 calibration, vs both team dynos, power + torque, with
WOT-band (6k+, the trusted band) RMSE annotated per panel."""
from __future__ import annotations
import csv, json, math
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
ETA = 0.85

VARIANTS = [
    ("all_off", "legacy (pre-v4.2)", "#777777", "--"),
    ("prod", "v4.3.2 shipped", "#4FC3F7", "-."),
    ("shipped", "now (0028 cal)", "#FFC627", "-"),
]


def sim(variant, eng, field):
    rows = []
    for line in open(HERE / f"results_{variant}_{eng}.ndjson"):
        d = json.loads(line)
        if d.get("kind") == "trial":
            rows.append((d["rpm"], d[field] * ETA))
    rows.sort()
    return rows


def dyno(eng, col):
    pts = []
    for r in csv.DictReader(open(ROOT / f"physics_findings/references/dyno/{eng}-team-dyno.csv")):
        if r[col]:
            pts.append((float(r["rpm"]), float(r[col])))
    pts.sort()
    return pts


def wot_rmse(sim_rows, dyno_pts):
    d = dict(dyno_pts)
    errs = [v - d[r] for r, v in sim_rows if r in d and r >= 6000]
    return math.sqrt(sum(e * e for e in errs) / len(errs))


fig, axes = plt.subplots(2, 2, figsize=(13.5, 9.5), sharex="col")
fig.patch.set_facecolor("#0E0E10")
for row, (field, ylabel, unit) in enumerate([
        ("brake_power_kW", "wheel power (kW)", "kW"),
        ("brake_torque_Nm", "wheel torque (Nm)", "Nm")]):
    for c, eng in enumerate(("sdm26", "sdm25")):
        ax = axes[row][c]
        ax.set_facecolor("#0E0E10")
        dp = dyno(eng, field)
        ax.scatter([r for r, _ in dp], [v for _, v in dp], s=30, c="#CE93D8",
                   zorder=5, label="team dyno")
        lines = []
        for variant, label, color, ls in VARIANTS:
            srows = sim(variant, eng, field)
            rmse = wot_rmse(srows, dp)
            ax.plot([r for r, _ in srows], [v for _, v in srows], ls,
                    color=color, lw=2, label=f"{label}")
            lines.append((label, color, rmse))
        # RMSE box (trusted 6k+ band)
        txt = "\n".join(f"{l}: {r:.2f} {unit}" for l, _, r in lines)
        old, new = lines[0][2], lines[2][2]
        txt += f"\nimprovement: −{(1 - new / old) * 100:.0f}%"
        ax.text(0.985, 0.03, "RMSE (6k+)\n" + txt, transform=ax.transAxes,
                ha="right", va="bottom", fontsize=8.5, family="monospace",
                color="#D8DCE2",
                bbox=dict(facecolor="#16171B", edgecolor="#2A2C32", pad=5))
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
                  labelcolor="#D8DCE2", fontsize=8.5, loc="upper left")
fig.suptitle("Helios engine model accuracy — legacy vs v4.3.2 vs now (team dynos, wheel-side)",
             color="#D8DCE2", fontsize=14)
fig.tight_layout(rect=(0, 0, 1, 0.96))
fig.savefig(HERE / "fig_progress_summary.png", dpi=150, facecolor=fig.get_facecolor())
print("wrote fig_progress_summary.png")
