"""0030: does an imperfect (band-retarded) ignition map reproduce the SDM26
10.5-12k dyno sag that no breathing/thermal knob could? Overlay: dyno, the
0028 base (idealized smooth map), and the same calibration with spark pulled
~5 deg across 10.5-12k only."""
from __future__ import annotations
import csv, json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
ETA = 0.85


def sim(path, field):
    rows = []
    for line in open(path):
        d = json.loads(line)
        if d.get("kind") == "trial":
            rows.append((d["rpm"], d[field] * ETA))
    rows.sort()
    return [r for r, _ in rows], [v for _, v in rows]


def dyno(col):
    pts = []
    for r in csv.DictReader(open(ROOT / "physics_findings/references/dyno/sdm26-team-dyno.csv")):
        if r[col]:
            pts.append((float(r["rpm"]), float(r[col])))
    pts.sort()
    return [r for r, _ in pts], [v for _, v in pts]


base = ROOT / "physics_findings/0029-exhaust-thermal-woschni/results_base_sdm26.ndjson"
ret = HERE / "results_retmap_sdm26.ndjson"

fig, axes = plt.subplots(1, 2, figsize=(13, 5.5))
fig.patch.set_facecolor("#0E0E10")
for ax, (field, ylabel) in zip(axes, [("brake_power_kW", "wheel power (kW)"),
                                      ("brake_torque_Nm", "wheel torque (Nm)")]):
    ax.set_facecolor("#0E0E10")
    dx, dy = dyno(field)
    ax.scatter(dx, dy, s=30, c="#CE93D8", zorder=5, label="team dyno")
    x, y = sim(base, field)
    ax.plot(x, y, "--", color="#9097A0", lw=1.8, label="0028 base (idealized map)")
    x, y = sim(ret, field)
    ax.plot(x, y, "-", color="#FFC627", lw=2.2, label="spark −5° in 10.5–12k only")
    x, y = sim(HERE / "results_retmap10_sdm26.ndjson", field)
    ax.plot(x, y, "-", color="#FF8A65", lw=2.0, label="spark −10° in 10.5–12k only")
    ax.axvspan(10500, 12000, color="#FF6B6B", alpha=0.08)
    ax.set_xlabel("RPM", color="#9097A0")
    ax.set_ylabel(ylabel, color="#9097A0")
    ax.tick_params(colors="#9097A0")
    for s in ax.spines.values():
        s.set_color("#2A2C32")
    ax.grid(color="#2A2C32", lw=0.5, alpha=0.6)
axes[0].legend(facecolor="#16171B", edgecolor="#2A2C32", labelcolor="#D8DCE2", fontsize=9)
fig.suptitle("SDM26 — can an imperfect tune explain the 10.5–12k sag?", color="#D8DCE2")
fig.tight_layout(rect=(0, 0, 1, 0.96))
fig.savefig(HERE / "fig_tune_sensitivity.png", dpi=150, facecolor=fig.get_facecolor())
print("wrote fig_tune_sensitivity.png")
