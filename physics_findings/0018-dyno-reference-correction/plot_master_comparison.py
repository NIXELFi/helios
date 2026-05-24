"""
Master comparison plot: simulator vs REAL team dyno data, both engines.

Single combined figure with 4 panels:
  Top row: wheel power vs RPM  (SDM26 left, SDM25 right)
  Bottom row: implied η(RPM)   (SDM26 left, SDM25 right)

Each panel shows:
  - Production knob set (the production state, unchanged this session)
  - Two-zone + c_v γ (new opt-in from finding 0016 — for high-RPM diagnosis)
  - Real team chassis dyno (Dynojet, wheel power, 20mm restricted)
  - The "high-confidence WOT band" 7000–11500 RPM shaded

This is the truthful "where the model stands" picture as of 2026-05-23
against the team's actual engine dyno data.
"""
from __future__ import annotations
import csv, json
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
DYNO_SDM26 = ROOT / "physics_findings/references/dyno/sdm26-team-dyno.csv"
DYNO_SDM25 = ROOT / "physics_findings/references/dyno/sdm25-team-dyno.csv"
ETA = 0.85


def load_ndjson(path):
    rows = {}
    with open(path) as f:
        for line in f:
            d = json.loads(line)
            if d.get("kind") == "trial":
                rows[int(d["rpm"])] = d
    return rows


def load_dyno(path):
    out = {}
    with open(path) as f:
        for r in csv.DictReader(f):
            if r["brake_power_kW"]:
                out[int(float(r["rpm"]))] = float(r["brake_power_kW"])
    return out


def sim_wheel(row):
    return row["brake_power_kW"] * ETA


PATHS = {
    "prod": {
        "sdm26": ROOT / "physics_findings/0015-low-rpm-port-loss/results_baseline_sdm26.ndjson",
        "sdm25": ROOT / "physics_findings/0015-low-rpm-port-loss/results_baseline_sdm25.ndjson",
    },
    "tz_cv": {
        "sdm26": ROOT / "physics_findings/0016-nasa7-gamma-twozone/results_twoZone_cvweighted_sdm26.ndjson",
        "sdm25": ROOT / "physics_findings/0016-nasa7-gamma-twozone/results_twoZone_cvweighted_sdm25.ndjson",
    },
    "tz_v2": {
        "sdm26": ROOT / "physics_findings/0016-nasa7-gamma-twozone/results_twoZone_cvweighted_v2_sdm26.ndjson",
        "sdm25": ROOT / "physics_findings/0016-nasa7-gamma-twozone/results_twoZone_cvweighted_v2_sdm25.ndjson",
    },
}
DYNO = {"sdm26": DYNO_SDM26, "sdm25": DYNO_SDM25}


def plot():
    fig, axes = plt.subplots(2, 2, figsize=(16, 10))

    for col, engine in enumerate(["sdm26", "sdm25"]):
        dyno = load_dyno(DYNO[engine])
        rpm_dyno = sorted(dyno.keys())
        dyno_kw = [dyno[r] for r in rpm_dyno]

        prod = load_ndjson(PATHS["prod"][engine])
        tz_v2 = load_ndjson(PATHS["tz_v2"][engine])

        # --- Top: wheel power ---
        ax = axes[0][col]
        ax.axvspan(7000, 11500, color="green", alpha=0.06,
                   label="High-confidence WOT band 7–11.5 kRPM")
        rpms = sorted(prod.keys())
        ax.plot(rpms, [sim_wheel(prod[r]) for r in rpms],
                "o-", color="tab:blue", lw=2.5, ms=6,
                label="Sim — production (single-zone)")
        rpms2 = sorted(tz_v2.keys())
        ax.plot(rpms2, [sim_wheel(tz_v2[r]) for r in rpms2],
                "D-.", color="tab:green", lw=2.0, ms=5,
                label="Sim — two-zone v2 (c_v γ + R-weighted V_frac, finding 0016)")
        ax.plot(rpm_dyno, dyno_kw, "kx-", lw=2.5, ms=10,
                label=f"REAL {engine.upper()} dyno (Dynojet wheel)")
        ax.set_xlabel("RPM")
        ax.set_ylabel(f"wheel power [kW] (= sim_brake × {ETA})")
        ax.set_title(f"{engine.upper()} — wheel power vs RPM")
        ax.grid(True, alpha=0.3)
        ax.set_xlim(3800, 13700)
        ax.legend(loc="upper left", fontsize=8)

        # --- Bottom: implied η ---
        ax = axes[1][col]
        ax.axvspan(7000, 11500, color="green", alpha=0.06,
                   label="High-confidence WOT band 7–11.5 kRPM")
        common = sorted(set(rpms) & set(rpm_dyno))
        ax.plot(common, [dyno[r] / prod[r]["brake_power_kW"] for r in common],
                "o-", color="tab:blue", lw=2.5, ms=6,
                label="Sim — production (single-zone)")
        common2 = sorted(set(rpms2) & set(rpm_dyno))
        ax.plot(common2, [dyno[r] / tz_v2[r]["brake_power_kW"] for r in common2],
                "D-.", color="tab:green", lw=2.0, ms=5,
                label="Sim — two-zone v2 (finding 0016)")
        ax.axhline(0.85, color="black", lw=1.2, ls="--", alpha=0.7,
                   label="Cameron handbook η = 0.85")
        ax.axhspan(0.80, 0.90, color="black", alpha=0.05,
                   label="Literature drivetrain band")
        ax.set_xlabel("RPM")
        ax.set_ylabel("implied η = dyno_wheel / sim_brake")
        ax.set_title(f"{engine.upper()} — implied drivetrain η(RPM)")
        ax.grid(True, alpha=0.3)
        ax.set_ylim(0.40, 1.40)
        ax.legend(loc="upper left", fontsize=8)

    fig.suptitle("Helios simulator vs REAL team dyno (Dynojet wheel power)\n"
                 "Production knob set unchanged. Real bias: SDM26 +0.5 kW, SDM25 +0.4 kW "
                 "(all RPMs). High-RPM gap: MUSCL exhaust wave damping (worse on SDM25's long 4-1).",
                 fontsize=12)
    fig.tight_layout()
    out = HERE / "fig_master_comparison_real_dyno.png"
    fig.savefig(out, dpi=150)
    plt.close(fig)
    print(f"Wrote {out}")


if __name__ == "__main__":
    plot()
