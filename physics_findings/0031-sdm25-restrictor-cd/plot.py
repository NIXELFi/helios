"""0031: is SDM25's high-band under-read just a wrong restrictor Cd?
The config carries 0.92 with no provenance while SDM26 carries 0.95 — if
both cars ran the same physical restrictor the Cd should match. Overlay +
banded RMSE for Cd {0.92 (base), 0.95, 0.967}."""
from __future__ import annotations
import csv, json, math
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
ETA = 0.85

CURVES = [
    (ROOT / "physics_findings/0029-exhaust-thermal-woschni/results_base_sdm25.ndjson",
     "Cd 0.92 (config today)", "#9097A0", "--"),
    (HERE / "results_cd095_sdm25.ndjson", "Cd 0.95 (= SDM26)", "#FFC627", "-"),
    (HERE / "results_cd0967_sdm25.ndjson", "Cd 0.967 (bench spec)", "#FF8A65", "-"),
]


def sim(path, field):
    rows = []
    for line in open(path):
        d = json.loads(line)
        if d.get("kind") == "trial":
            rows.append((d["rpm"], d[field] * ETA))
    rows.sort()
    return rows


def dyno(col):
    pts = []
    for r in csv.DictReader(open(ROOT / "physics_findings/references/dyno/sdm25-team-dyno.csv")):
        if r[col]:
            pts.append((float(r["rpm"]), float(r[col])))
    pts.sort()
    return pts


def rmse(sim_rows, dyno_pts, lo, hi):
    d = dict(dyno_pts)
    errs = [v - d[r] for r, v in sim_rows if r in d and lo <= r <= hi]
    if not errs:
        return float("nan"), float("nan")
    return (math.sqrt(sum(e * e for e in errs) / len(errs)),
            sum(errs) / len(errs))


fig, axes = plt.subplots(1, 2, figsize=(13, 5.5))
fig.patch.set_facecolor("#0E0E10")
for ax, (field, ylabel) in zip(axes, [("brake_power_kW", "wheel power (kW)"),
                                      ("brake_torque_Nm", "wheel torque (Nm)")]):
    ax.set_facecolor("#0E0E10")
    dp = dyno(field)
    ax.scatter([r for r, _ in dp], [v for _, v in dp], s=30, c="#CE93D8",
               zorder=5, label="team dyno")
    txt = []
    for path, label, color, ls in CURVES:
        srows = sim(path, field)
        ax.plot([r for r, _ in srows], [v for _, v in srows], ls,
                color=color, lw=2, label=label)
        wr, wb = rmse(srows, dp, 6000, 13500)
        hr, hb = rmse(srows, dp, 10500, 13500)
        txt.append(f"{label.split(' (')[0]:>8}: wot {wr:.2f}  high {hr:.2f}/{hb:+.2f}")
    ax.text(0.985, 0.03, "RMSE / bias\n" + "\n".join(txt), transform=ax.transAxes,
            ha="right", va="bottom", fontsize=8, family="monospace",
            color="#D8DCE2",
            bbox=dict(facecolor="#16171B", edgecolor="#2A2C32", pad=5))
    ax.set_xlabel("RPM", color="#9097A0")
    ax.set_ylabel(ylabel, color="#9097A0")
    ax.tick_params(colors="#9097A0")
    for s in ax.spines.values():
        s.set_color("#2A2C32")
    ax.grid(color="#2A2C32", lw=0.5, alpha=0.6)
axes[0].legend(facecolor="#16171B", edgecolor="#2A2C32", labelcolor="#D8DCE2",
               fontsize=9, loc="upper left")
fig.suptitle("SDM25 — restrictor Cd hypothesis (0.92 has no provenance; SDM26 runs 0.95)",
             color="#D8DCE2")
fig.tight_layout(rect=(0, 0, 1, 0.95))
fig.savefig(HERE / "fig_cd_hypothesis.png", dpi=150, facecolor=fig.get_facecolor())
print("wrote fig_cd_hypothesis.png")
