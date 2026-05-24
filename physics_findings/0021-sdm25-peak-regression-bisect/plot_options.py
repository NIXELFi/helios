"""
Plot the four production-knob-set options (A/B/C/D) against the real
team dyno data, both engines, single combined figure.
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


# Options:
OPTIONS = [
    # (label, k, fc, color, style, lw)
    ("CURRENT  (k=0.30, fc=0.003)        — old prod",  "0_30", "fmep_curr_0.003",   "tab:red",    "o-",  2.0),
    ("Option A (k=0.30, fc=0.00075)      — finding 0020",  "0_30", "fmep_fix_0.00075",  "tab:purple", "s--", 1.8),
    ("Option B (k=0.10, fc=0.00075)      — RECOMMENDED",  "0_10", "fmep_fix_0.00075",  "tab:green",  "D-",  2.5),
    ("Option C (k=0.00, fc=0.00075)      — ideal nozzle", "0_00", "fmep_fix_0.00075",  "tab:cyan",   "^:",  1.6),
]


def plot():
    fig, axes = plt.subplots(2, 2, figsize=(16, 10))
    for col, eng in enumerate(["sdm26", "sdm25"]):
        dyno = load_dyno(DYNO[eng])
        rpm_dyno = sorted(dyno.keys())

        ax_p = axes[0][col]
        ax_e = axes[1][col]
        ax_p.axvspan(7000, 11500, color="green", alpha=0.06, label="High-confidence WOT band")
        ax_e.axvspan(7000, 11500, color="green", alpha=0.06, label="High-confidence WOT band")

        for label, k, fc, color, style, lw in OPTIONS:
            path = HERE / f"results_k{k}_{fc}_{eng}.ndjson"
            sim = load_ndjson(path)
            rpms = sorted(sim)
            ax_p.plot(rpms, [sim[r]["brake_power_kW"]*ETA for r in rpms],
                      style, color=color, lw=lw, ms=5, label=label)
            common = sorted(set(rpms) & set(rpm_dyno))
            ax_e.plot(common, [sim[r]["brake_power_kW"]*ETA - dyno[r] for r in common],
                      style, color=color, lw=lw, ms=5, label=label)

        ax_p.plot(rpm_dyno, [dyno[r] for r in rpm_dyno], "kx-", lw=2.5, ms=10,
                  label=f"REAL {eng.upper()} dyno (Dynojet wheel)")
        ax_e.axhline(0, color="black", lw=1.0)
        ax_e.fill_between([3000, 14000], -5, 5, color="gray", alpha=0.05, label="±5 kW dyno tolerance")

        ax_p.set_xlabel("RPM")
        ax_p.set_ylabel(f"wheel power [kW] (= sim_brake × {ETA})")
        ax_p.set_title(f"{eng.upper()} — wheel power vs RPM")
        ax_p.grid(True, alpha=0.3)
        ax_p.set_xlim(3800, 13700)
        ax_p.legend(loc="upper left", fontsize=7)

        ax_e.set_xlabel("RPM")
        ax_e.set_ylabel("error: sim_wheel − dyno [kW]")
        ax_e.set_title(f"{eng.upper()} — per-RPM error")
        ax_e.grid(True, alpha=0.3)
        ax_e.set_xlim(3800, 13700)
        ax_e.set_ylim(-15, 18)
        ax_e.legend(loc="upper right", fontsize=7)

    fig.suptitle("Finding 0021 — production knob set options vs REAL team dyno\n"
                 "Option B (k=0.10, fc=0.00075) is the recommended compromise: "
                 "best symmetric fit on both engines without leaving Heywood literature.",
                 fontsize=11)
    fig.tight_layout()
    out = HERE / "fig_options_vs_real_dyno.png"
    fig.savefig(out, dpi=150)
    plt.close(fig)
    print(f"Wrote {out}")


if __name__ == "__main__":
    plot()
