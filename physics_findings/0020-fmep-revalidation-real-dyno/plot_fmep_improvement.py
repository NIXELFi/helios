"""
Plot sim vs real dyno: current fmep_c=0.003 vs Heywood midpoint fmep_c=0.00075.
Both engines on a single figure.
"""
from __future__ import annotations
import csv, json
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
DYNO = {
    "sdm26": ROOT / "physics_findings/references/dyno/sdm26-team-dyno.csv",
    "sdm25": ROOT / "physics_findings/references/dyno/sdm25-team-dyno.csv",
}
ETA = 0.85


def load_ndjson(p):
    rows = {}
    for line in open(p):
        d = json.loads(line)
        if d.get("kind") == "trial":
            rows[int(d["rpm"])] = d
    return rows


def load_dyno(p):
    out = {}
    for r in csv.DictReader(open(p)):
        if r["brake_power_kW"]:
            out[int(float(r["rpm"]))] = float(r["brake_power_kW"])
    return out


def plot():
    fig, axes = plt.subplots(2, 2, figsize=(16, 10))

    for col, eng in enumerate(["sdm26", "sdm25"]):
        dyno = load_dyno(DYNO[eng])
        rpm_dyno = sorted(dyno.keys())
        dyno_kw = [dyno[r] for r in rpm_dyno]

        # current (fc=0.003) — same as `results_current_{eng}.ndjson`
        cur = load_ndjson(HERE / f"results_current_{eng}.ndjson")
        rpms = sorted(cur.keys())
        # Heywood midpoint (fc=0.00075)
        new = load_ndjson(HERE / f"results_fc_0_00075_{eng}.ndjson")

        # --- Top: wheel power ---
        ax = axes[0][col]
        ax.axvspan(7000, 11500, color="green", alpha=0.06, label="High-confidence WOT band")
        ax.plot(rpms, [cur[r]["brake_power_kW"]*ETA for r in rpms],
                "o-", color="tab:red", lw=2.0, ms=5,
                label="Sim — production current (fmep_c=0.003 = 3× Heywood ceiling)")
        ax.plot(rpms, [new[r]["brake_power_kW"]*ETA for r in rpms],
                "D-", color="tab:green", lw=2.5, ms=6,
                label="Sim — fmep_c = 0.00075 (Heywood Tab 13.3 midpoint)")
        ax.plot(rpm_dyno, dyno_kw, "kx-", lw=2.5, ms=10,
                label=f"REAL {eng.upper()} dyno (Dynojet wheel)")
        ax.set_xlabel("RPM")
        ax.set_ylabel(f"wheel power [kW] (= sim_brake × {ETA})")
        ax.set_title(f"{eng.upper()} — wheel power vs RPM")
        ax.grid(True, alpha=0.3)
        ax.set_xlim(3800, 13700)
        ax.legend(loc="upper left", fontsize=8)

        # --- Bottom: error per RPM ---
        ax = axes[1][col]
        ax.axvspan(7000, 11500, color="green", alpha=0.06, label="High-confidence WOT band")
        ax.axhline(0, color="black", lw=1.0)
        common = sorted(set(rpms) & set(rpm_dyno))
        ax.plot(common, [cur[r]["brake_power_kW"]*ETA - dyno[r] for r in common],
                "o-", color="tab:red", lw=2.0, ms=5,
                label="Current — error (sim − dyno)")
        ax.plot(common, [new[r]["brake_power_kW"]*ETA - dyno[r] for r in common],
                "D-", color="tab:green", lw=2.5, ms=6,
                label="fmep_c → Heywood midpoint — error")
        ax.fill_between([3000, 14000], -5, 5, color="gray", alpha=0.05, label="±5 kW dyno tolerance")
        ax.set_xlabel("RPM")
        ax.set_ylabel("error: sim_wheel − dyno [kW]")
        ax.set_title(f"{eng.upper()} — per-RPM error")
        ax.grid(True, alpha=0.3)
        ax.set_xlim(3800, 13700)
        ax.set_ylim(-15, 18)
        ax.legend(loc="upper right", fontsize=8)

    fig.suptitle("FMEP revalidation: fmep_c = 0.003 (above Heywood ceiling) vs 0.00075 (Heywood midpoint)\n"
                 "Moving fmep_c into Heywood Tab 13.3 motorcycle range improves both SDM25 and SDM26 by ~16% RMSE",
                 fontsize=11)
    fig.tight_layout()
    out = HERE / "fig_fmep_improvement.png"
    fig.savefig(out, dpi=150)
    plt.close(fig)
    print(f"Wrote {out}")


if __name__ == "__main__":
    plot()
