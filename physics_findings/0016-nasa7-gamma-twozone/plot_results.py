"""
Generate comparison plots for findings 0015 + 0016.

Plots:
  fig01_bp_sweep_both_engines.png — wheel power vs RPM, SDM25 + SDM26, all variants
  fig02_eta_implied.png            — implied drivetrain η vs RPM
  fig03_rmse_bias_summary.png      — RMSE + bias bar chart per variant
  fig04_delta_vs_baseline.png      — per-RPM Δ wheel power: variant − single-zone baseline
"""
from __future__ import annotations
import csv
import json
import math
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

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


# Variants
VARIANTS = [
    ("baseline",   "Single-zone (production knobs)", "tab:blue",   "o-"),
    ("twozone_legacy", "Two-zone (legacy mass-avg γ)", "tab:red",    "s--"),
    ("twozone_cvweighted", "Two-zone + c_v-weighted γ (0016)", "tab:green",  "D-."),
    ("t11", "Single-zone + low-Re Cd correction (0015)", "tab:orange", "^:"),
]

PATHS = {
    ("baseline", "sdm26"): ROOT / "physics_findings/0015-low-rpm-port-loss/results_baseline_sdm26.ndjson",
    ("baseline", "sdm25"): ROOT / "physics_findings/0015-low-rpm-port-loss/results_baseline_sdm25.ndjson",
    ("t11", "sdm26"): ROOT / "physics_findings/0015-low-rpm-port-loss/results_T11_sdm26.ndjson",
    ("t11", "sdm25"): ROOT / "physics_findings/0015-low-rpm-port-loss/results_T11_sdm25.ndjson",
    ("twozone_legacy", "sdm26"): HERE / "results_twoZone_baseline_sdm26.ndjson",
    ("twozone_legacy", "sdm25"): HERE / "results_twoZone_baseline_sdm25.ndjson",
    ("twozone_cvweighted", "sdm26"): HERE / "results_twoZone_cvweighted_sdm26.ndjson",
    ("twozone_cvweighted", "sdm25"): HERE / "results_twoZone_cvweighted_sdm25.ndjson",
}


def load_variant(name, engine):
    return load_ndjson(PATHS[(name, engine)])


def fig01_bp_sweep_both_engines():
    fig, axes = plt.subplots(1, 2, figsize=(15, 6), sharey=True)
    dyno = load_dyno()
    rpm_dyno = sorted(dyno.keys())
    dyno_kw = [dyno[r] for r in rpm_dyno]

    for ax, engine in zip(axes, ["sdm26", "sdm25"]):
        for key, label, color, style in VARIANTS:
            v = load_variant(key, engine)
            rpms = sorted(v.keys())
            wheel = [sim_wheel_kw(v[r]) for r in rpms]
            ax.plot(rpms, wheel, style, color=color, label=label, lw=1.8, ms=5)
        ax.plot(rpm_dyno, dyno_kw, "kx-", lw=2.5, ms=10, label="FSAE-restricted dyno (wheel)")
        ax.axhspan(41, 52, color="gray", alpha=0.08, label="FSAE wheel band 41–52 kW")
        ax.set_xlabel("RPM")
        ax.set_title(f"{engine.upper()} — wheel power vs RPM")
        ax.grid(True, alpha=0.3)
        ax.set_xlim(3800, 13300)
    axes[0].set_ylabel(f"wheel_power [kW]  (= sim_brake × {ETA_DRIVETRAIN})")
    axes[0].legend(loc="upper left", fontsize=8)
    fig.suptitle("0015+0016 — wheel power sweep for each tested physics variant")
    fig.tight_layout()
    fig.savefig(HERE / "fig01_bp_sweep_both_engines.png", dpi=140)
    plt.close(fig)


def fig02_eta_implied():
    fig, axes = plt.subplots(1, 2, figsize=(15, 6), sharey=True)
    dyno = load_dyno()
    for ax, engine in zip(axes, ["sdm26", "sdm25"]):
        for key, label, color, style in VARIANTS:
            v = load_variant(key, engine)
            rpms = sorted(set(v.keys()) & set(dyno.keys()))
            eta = [dyno[r] / v[r]["brake_power_kW"] for r in rpms]
            ax.plot(rpms, eta, style, color=color, label=label, lw=1.8, ms=5)
        ax.axhline(0.85, color="black", lw=1.2, ls="--", alpha=0.7, label="Cameron handbook η=0.85")
        ax.axhspan(0.80, 0.90, color="black", alpha=0.05, label="Literature drivetrain band")
        ax.set_xlabel("RPM")
        ax.set_title(f"{engine.upper()} — implied drivetrain η(RPM)")
        ax.grid(True, alpha=0.3)
        ax.set_ylim(0.40, 1.40)
    axes[0].set_ylabel("implied η = dyno_wheel / sim_brake")
    axes[0].legend(loc="upper left", fontsize=8)
    fig.suptitle("0015+0016 — implied drivetrain η: trust diagnostic per variant")
    fig.tight_layout()
    fig.savefig(HERE / "fig02_eta_implied.png", dpi=140)
    plt.close(fig)


def fig03_rmse_bias_summary():
    """Three-band RMSE/bias bar chart per variant per engine."""
    dyno = load_dyno()
    bands = [("4-7k", 4000, 7000), ("7.5-11k", 7500, 11000), ("11.5-13k", 11500, 13000)]
    fig, axes = plt.subplots(2, 2, figsize=(15, 9))
    width = 0.20
    x = np.arange(len(bands))
    for i_engine, engine in enumerate(["sdm26", "sdm25"]):
        ax_rmse = axes[0][i_engine]
        ax_bias = axes[1][i_engine]
        for i_var, (key, label, color, _) in enumerate(VARIANTS):
            v = load_variant(key, engine)
            rmses, biases = [], []
            for band_name, lo, hi in bands:
                errs = []
                for r in sorted(set(v.keys()) & set(dyno.keys())):
                    if lo <= r <= hi:
                        errs.append(sim_wheel_kw(v[r]) - dyno[r])
                if errs:
                    rmses.append(math.sqrt(sum(e * e for e in errs) / len(errs)))
                    biases.append(sum(errs) / len(errs))
                else:
                    rmses.append(0); biases.append(0)
            offset = (i_var - 1.5) * width
            ax_rmse.bar(x + offset, rmses, width, label=label, color=color)
            ax_bias.bar(x + offset, biases, width, label=label, color=color)
        for ax, ylabel, title in [
            (ax_rmse, "RMSE vs dyno wheel [kW]", f"{engine.upper()} — RMSE"),
            (ax_bias, "bias (sim_wheel − dyno) [kW]", f"{engine.upper()} — bias"),
        ]:
            ax.set_xticks(x)
            ax.set_xticklabels([b[0] for b in bands])
            ax.set_ylabel(ylabel)
            ax.set_title(title)
            ax.grid(True, axis="y", alpha=0.3)
            ax.axhline(0, color="black", lw=0.8)
    axes[0][0].legend(fontsize=8, loc="upper right")
    fig.suptitle("0015+0016 — RMSE + bias by RPM band, per physics variant")
    fig.tight_layout()
    fig.savefig(HERE / "fig03_rmse_bias_summary.png", dpi=140)
    plt.close(fig)


def fig04_delta_vs_baseline():
    """Per-RPM delta wheel power: each variant minus single-zone baseline."""
    fig, axes = plt.subplots(1, 2, figsize=(15, 6), sharey=True)
    for ax, engine in zip(axes, ["sdm26", "sdm25"]):
        base = load_variant("baseline", engine)
        rpms = sorted(base.keys())
        for key, label, color, style in VARIANTS:
            if key == "baseline":
                continue
            v = load_variant(key, engine)
            delta = [sim_wheel_kw(v[r]) - sim_wheel_kw(base[r]) for r in rpms]
            ax.plot(rpms, delta, style, color=color, label=label, lw=1.8, ms=5)
        ax.axhline(0, color="black", lw=1.2)
        ax.set_xlabel("RPM")
        ax.set_title(f"{engine.upper()} — Δ wheel power vs single-zone baseline")
        ax.grid(True, alpha=0.3)
    axes[0].set_ylabel("Δ wheel_power [kW]")
    axes[0].legend(loc="upper left", fontsize=8)
    fig.suptitle("0015+0016 — per-RPM change in wheel power vs single-zone baseline")
    fig.tight_layout()
    fig.savefig(HERE / "fig04_delta_vs_baseline.png", dpi=140)
    plt.close(fig)


if __name__ == "__main__":
    fig01_bp_sweep_both_engines()
    fig02_eta_implied()
    fig03_rmse_bias_summary()
    fig04_delta_vs_baseline()
    print("Wrote fig01..04 to", HERE)
