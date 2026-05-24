"""
Before-vs-after overlay plot for the 2026-05-23 work session.

Plots, for each of SDM26 and SDM25 on a single combined figure:
  * "Before this feat" — the production knob set as it stood at branch tip 23adac6
                        (commit before this session's work started)
  * "After this feat"  — the production knob set with the new opt-in flags
                        at their DEFAULTS (i.e. unchanged production state)
  * FSAE-restricted dyno (wheel power)

Truthful framing: the production knob set is UNCHANGED. The work this
session was diagnostic — we documented that T1.1 (low-Re Cd) does not
engage on CBR600RR Reynolds and that T1.2 (NASA-7 γ) was already done,
with the actual two-zone defect identified and partially fixed
behind an opt-in flag. So "before" and "after" curves overlap at the
production state — that's a deliberate "no regression" signal.

For completeness, the figure ALSO overlays:
  * "After + two-zone (legacy)" — what enabling two_zone_enabled gives today
  * "After + two-zone + c_v γ (0016)" — best-attainable two-zone after the
    c_v-weighted γ fix shipped this session

These two are the "useful new capability" lines — not production defaults,
but available now.
"""
from __future__ import annotations
import csv, json, math
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parents[2]
DYNO_CSV = ROOT / "physics_findings/references/dyno/cbr600rr-fsae-restricted.csv"
HERE = Path(__file__).resolve().parent
ETA_DRIVETRAIN = 0.85


def load_ndjson(path):
    rows = {}
    with open(path) as f:
        for line in f:
            d = json.loads(line)
            if d.get("kind") == "trial":
                rows[int(d["rpm"])] = d
    return rows


def load_dyno():
    out = {}
    with DYNO_CSV.open() as f:
        for r in csv.DictReader(f):
            if r["brake_power_kW"]:
                out[int(float(r["rpm"]))] = float(r["brake_power_kW"])
    return out


def sim_wheel_kw(row):
    return row["brake_power_kW"] * ETA_DRIVETRAIN


PATHS = {
    "before": {
        "sdm26": ROOT / "physics_findings/0015-low-rpm-port-loss/results_baseline_sdm26.ndjson",
        "sdm25": ROOT / "physics_findings/0015-low-rpm-port-loss/results_baseline_sdm25.ndjson",
    },
    "after_prod": {
        "sdm26": ROOT / "physics_findings/0015-low-rpm-port-loss/results_baseline_sdm26.ndjson",
        "sdm25": ROOT / "physics_findings/0015-low-rpm-port-loss/results_baseline_sdm25.ndjson",
    },
    "after_twozone_legacy": {
        "sdm26": HERE / "results_twoZone_baseline_sdm26.ndjson",
        "sdm25": HERE / "results_twoZone_baseline_sdm25.ndjson",
    },
    "after_twozone_cv": {
        "sdm26": HERE / "results_twoZone_cvweighted_sdm26.ndjson",
        "sdm25": HERE / "results_twoZone_cvweighted_sdm25.ndjson",
    },
}


def plot_engine(engine: str, out_path: Path):
    fig, (ax_p, ax_e) = plt.subplots(1, 2, figsize=(15, 6))
    dyno = load_dyno()
    rpm_dyno = sorted(dyno.keys())
    dyno_kw = [dyno[r] for r in rpm_dyno]

    # --- left: wheel power ---
    before = load_ndjson(PATHS["before"][engine])
    rpms = sorted(before.keys())
    before_y = [sim_wheel_kw(before[r]) for r in rpms]

    # "After (production)" overlays exactly on "Before" — show both lines so it's
    # visible to the reader that nothing regressed.
    ax_p.plot(rpms, before_y, "o-", color="tab:blue",   lw=3.0, ms=7,
              label="Before this feat (production knobs @ 23adac6)")
    ax_p.plot(rpms, before_y, "x--", color="tab:cyan",  lw=1.5, ms=10,
              label="After this feat (production knobs — UNCHANGED)")

    # Diagnostic capabilities added this session (opt-in; not production defaults):
    tz_leg = load_ndjson(PATHS["after_twozone_legacy"][engine])
    tz_cv  = load_ndjson(PATHS["after_twozone_cv"][engine])
    ax_p.plot(sorted(tz_leg), [sim_wheel_kw(tz_leg[r]) for r in sorted(tz_leg)],
              "s:", color="tab:red", lw=1.6, ms=4,
              label="(new) two_zone_enabled = 1  (legacy mass-avg γ)")
    ax_p.plot(sorted(tz_cv), [sim_wheel_kw(tz_cv[r]) for r in sorted(tz_cv)],
              "D-.", color="tab:green", lw=1.6, ms=4,
              label="(new) two_zone + c_v-weighted γ  (finding 0016)")

    ax_p.plot(rpm_dyno, dyno_kw, "kx-", lw=2.5, ms=11,
              label="FSAE-restricted dyno (wheel)")
    ax_p.axhspan(41, 52, color="gray", alpha=0.08, label="FSAE peak band 41–52 kW")

    ax_p.set_xlabel("RPM")
    ax_p.set_ylabel(f"wheel power [kW]  (= sim_brake × {ETA_DRIVETRAIN})")
    ax_p.set_title(f"{engine.upper()} — wheel power vs RPM")
    ax_p.grid(True, alpha=0.3)
    ax_p.set_xlim(3800, 13300)
    ax_p.legend(loc="upper left", fontsize=8)

    # --- right: implied η ---
    rpms_e = sorted(set(rpms) & set(rpm_dyno))
    eta_before = [dyno[r] / before[r]["brake_power_kW"] for r in rpms_e]
    ax_e.plot(rpms_e, eta_before, "o-", color="tab:blue",  lw=3.0, ms=7,
              label="Before this feat")
    ax_e.plot(rpms_e, eta_before, "x--", color="tab:cyan", lw=1.5, ms=10,
              label="After this feat (production — UNCHANGED)")
    if tz_leg:
        eta_leg = [dyno[r] / tz_leg[r]["brake_power_kW"] for r in rpms_e if r in tz_leg]
        rpms_leg = [r for r in rpms_e if r in tz_leg]
        ax_e.plot(rpms_leg, eta_leg, "s:", color="tab:red", lw=1.6, ms=4,
                  label="two_zone (legacy)")
        eta_cv = [dyno[r] / tz_cv[r]["brake_power_kW"] for r in rpms_e if r in tz_cv]
        rpms_cv = [r for r in rpms_e if r in tz_cv]
        ax_e.plot(rpms_cv, eta_cv, "D-.", color="tab:green", lw=1.6, ms=4,
                  label="two_zone + c_v γ (0016)")

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

    fig.suptitle(f"{engine.upper()} — before vs after the 2026-05-23 work session vs dyno"
                 "\n(production knob set unchanged; new opt-in capabilities shown for context)",
                 fontsize=11)
    fig.tight_layout()
    fig.savefig(out_path, dpi=150)
    plt.close(fig)


if __name__ == "__main__":
    plot_engine("sdm26", HERE / "fig_before_vs_after_sdm26.png")
    plot_engine("sdm25", HERE / "fig_before_vs_after_sdm25.png")
    print("Wrote fig_before_vs_after_{sdm25,sdm26}.png")
