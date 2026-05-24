"""
Before-vs-after overlay plot using REAL team-specific dyno data.

Replaces `plot_before_vs_after.py` which used the old multi-source-aggregate
CSV that was bad at low RPM. The team dyno files (provided by user 2026-05-23):
  ~/Downloads/SDM (1).CSV    → SDM26 (Dynojet, wheel power)
  ~/Downloads/RunFile_11.csv → SDM25 (Dynojet, wheel power)

Extracted to:
  physics_findings/references/dyno/sdm26-team-dyno.csv
  physics_findings/references/dyno/sdm25-team-dyno.csv

Production knob set is unchanged this session — "before" and "after" overlap.
Extra context lines show the two opt-in capabilities added (two-zone with the
c_v-weighted γ fix from finding 0016).
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
ETA_DRIVETRAIN = 0.85


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
    return row["brake_power_kW"] * ETA_DRIVETRAIN


PATHS = {
    "before": {
        "sdm26": ROOT / "physics_findings/0015-low-rpm-port-loss/results_baseline_sdm26.ndjson",
        "sdm25": ROOT / "physics_findings/0015-low-rpm-port-loss/results_baseline_sdm25.ndjson",
    },
    "tz_leg": {
        "sdm26": HERE / "results_twoZone_baseline_sdm26.ndjson",
        "sdm25": HERE / "results_twoZone_baseline_sdm25.ndjson",
    },
    "tz_cv": {
        "sdm26": HERE / "results_twoZone_cvweighted_sdm26.ndjson",
        "sdm25": HERE / "results_twoZone_cvweighted_sdm25.ndjson",
    },
}
DYNO = {"sdm26": DYNO_SDM26, "sdm25": DYNO_SDM25}


def plot_engine(engine: str, out_path: Path):
    fig, (ax_p, ax_e) = plt.subplots(1, 2, figsize=(16, 6.5))
    dyno = load_dyno(DYNO[engine])
    rpm_dyno = sorted(dyno.keys())
    dyno_kw = [dyno[r] for r in rpm_dyno]

    before = load_ndjson(PATHS["before"][engine])
    rpms = sorted(before.keys())
    before_y = [sim_wheel(before[r]) for r in rpms]

    tz_leg = load_ndjson(PATHS["tz_leg"][engine])
    tz_cv  = load_ndjson(PATHS["tz_cv"][engine])

    # --- left: wheel power ---
    ax_p.plot(rpms, before_y, "o-", color="tab:blue",  lw=3.0, ms=7,
              label="Before this feat (production knobs @ 23adac6)")
    ax_p.plot(rpms, before_y, "x--", color="tab:cyan", lw=1.5, ms=10,
              label="After this feat (production knobs — UNCHANGED)")
    ax_p.plot(sorted(tz_leg), [sim_wheel(tz_leg[r]) for r in sorted(tz_leg)],
              "s:", color="tab:red", lw=1.6, ms=4,
              label="(new) two_zone_enabled = 1  (legacy mass-avg γ)")
    ax_p.plot(sorted(tz_cv), [sim_wheel(tz_cv[r]) for r in sorted(tz_cv)],
              "D-.", color="tab:green", lw=1.6, ms=4,
              label="(new) two_zone + c_v-weighted γ  (finding 0016)")
    ax_p.plot(rpm_dyno, dyno_kw, "kx-", lw=2.5, ms=11,
              label=f"REAL {engine.upper()} dyno (wheel, 20mm restricted)")

    ax_p.set_xlabel("RPM")
    ax_p.set_ylabel(f"wheel power [kW]  (= sim_brake × {ETA_DRIVETRAIN})")
    ax_p.set_title(f"{engine.upper()} — wheel power vs RPM (real team dyno)")
    ax_p.grid(True, alpha=0.3)
    ax_p.set_xlim(3800, 13700)
    ax_p.legend(loc="upper left", fontsize=8)

    # --- right: implied η ---
    rpms_e = sorted(set(rpms) & set(rpm_dyno))
    def eta_of(d):
        return [(r, dyno[r] / d[r]["brake_power_kW"]) for r in rpms_e if r in d and r in dyno]
    pts = eta_of(before)
    ax_e.plot([r for r,_ in pts], [e for _,e in pts], "o-", color="tab:blue",
              lw=3.0, ms=7, label="Before this feat")
    ax_e.plot([r for r,_ in pts], [e for _,e in pts], "x--", color="tab:cyan",
              lw=1.5, ms=10, label="After this feat (production — UNCHANGED)")
    pts = eta_of(tz_leg)
    if pts:
        ax_e.plot([r for r,_ in pts], [e for _,e in pts], "s:", color="tab:red",
                  lw=1.6, ms=4, label="two_zone (legacy γ)")
    pts = eta_of(tz_cv)
    if pts:
        ax_e.plot([r for r,_ in pts], [e for _,e in pts], "D-.", color="tab:green",
                  lw=1.6, ms=4, label="two_zone + c_v γ (0016)")

    ax_e.axhline(0.85, color="black", lw=1.2, ls="--", alpha=0.7,
                 label="Cameron handbook drivetrain η = 0.85")
    ax_e.axhspan(0.80, 0.90, color="black", alpha=0.05,
                 label="Literature drivetrain band 0.80–0.90")
    ax_e.set_xlabel("RPM")
    ax_e.set_ylabel("implied η = dyno_wheel / sim_brake")
    ax_e.set_title(f"{engine.upper()} — implied drivetrain η(RPM)")
    ax_e.grid(True, alpha=0.3)
    ax_e.set_ylim(0.40, 1.40)
    ax_e.legend(loc="upper left", fontsize=8)

    fig.suptitle(f"{engine.upper()} — before vs after the 2026-05-23 work session vs REAL team dyno"
                 "\n(production knob set unchanged; new opt-in capabilities shown for context)",
                 fontsize=11)
    fig.tight_layout()
    fig.savefig(out_path, dpi=150)
    plt.close(fig)


if __name__ == "__main__":
    plot_engine("sdm26", HERE / "fig_before_vs_after_REAL_sdm26.png")
    plot_engine("sdm25", HERE / "fig_before_vs_after_REAL_sdm25.png")
    print("Wrote:")
    print("  fig_before_vs_after_REAL_sdm26.png")
    print("  fig_before_vs_after_REAL_sdm25.png")
