#!/usr/bin/env python3
"""Plots for finding 0006 — RPM-resolved physics improvements.

Generates 6 figures showing:
 - fig01: BP-vs-RPM curves for all variants vs dyno (SDM26 + SDM25)
 - fig02: cumulative RMSE/bias bar chart
 - fig03: per-knob sensitivity scans (10-knob × 5-RPM heatmap)
 - fig04: sanity sweep (plenum, bore, stroke, runner_length)
 - fig05: ALL 5 fixes vs baseline gap closure per RPM
 - fig06: residual gap remaining at each RPM after all fixes
"""
import csv
import glob
import json
import math
import os
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
D = ROOT / "physics_findings/0006-rpm-resolved-physics"
DYNO = ROOT / "physics_findings/references/dyno"


def load_trials(p):
    out = {}
    with open(p) as f:
        for line in f:
            d = json.loads(line)
            if d.get("kind") == "trial":
                out[int(d["rpm"])] = d
    return out


def load_dyno(name):
    out = {}
    with open(DYNO / f"cbr600rr-{name}.csv") as f:
        for r in csv.DictReader(f):
            out[int(float(r["rpm"]))] = float(r["brake_power_kW"])
    return out


def main():
    # ---------- Comparative variants ----------
    VARIANTS = [
        ("v0_baseline",  "K=0 baseline (no fixes)",        "tab:red",    "o", "-"),
        ("v1_intakeBC",  "+intake Borda-Carnot (0005)",    "tab:orange", "s", "-"),
        ("v2_restrictor","+restrictor diffuser geom",      "tab:olive",  "^", "-"),
        ("v3_mbtmap",    "+MBT map (1.5°/krpm)",           "tab:cyan",   "v", "--"),
        ("v4_wiebe_rpm", "+Wiebe RPM (exp 0.4)",           "tab:purple", "D", "--"),
        ("v6_machcd",    "+Mach-Cd (NASA k=0.3)",          "tab:blue",   "P", "-"),
        ("v7_all_full",  "ALL 5 fixes stacked",            "tab:green",  "*", "-"),
    ]
    ENGINES = ["sdm26", "sdm25"]
    data = {}
    for v, *_ in VARIANTS:
        for e in ENGINES:
            p = D / f"results_{v}_{e}.ndjson"
            if p.exists():
                data[(v, e)] = load_trials(p)
    dyno_r = load_dyno("fsae-restricted")
    dyno_u = load_dyno("stock-unrestricted")
    rpms = sorted(data[("v0_baseline", "sdm26")].keys())

    # ---------- Figure 1: BP curves overlay ----------
    fig, axes = plt.subplots(1, 2, figsize=(15, 6.5), sharey=True)
    for ax, e in zip(axes, ENGINES):
        for v, label, color, marker, ls in VARIANTS:
            d = data.get((e, v)) or data.get((v, e))
            if not d:
                continue
            ys = [d.get(r, {}).get("brake_power_kW", np.nan) for r in rpms]
            ax.plot(rpms, ys, color=color, marker=marker, linestyle=ls, label=label,
                    lw=1.6, ms=7, alpha=0.85)
        ax.plot(rpms, [dyno_r.get(r, np.nan) for r in rpms],
                "k-x", lw=2.4, ms=10, label="FSAE-restricted dyno")
        ax.plot(rpms, [dyno_u.get(r, np.nan) for r in rpms],
                color="gray", marker="*", lw=1.4, ms=10, ls=":", alpha=0.7,
                label="stock-unrestricted dyno")
        ax.set_xlabel("Engine RPM")
        ax.set_title(f"{e.upper()} — brake_power(RPM) for each opt-in physics fix")
        ax.grid(True, alpha=0.3)
        ax.axhspan(41, 52, color="black", alpha=0.06, label="FSAE band 41-52 kW")
        if e == ENGINES[0]:
            ax.set_ylabel("brake_power [kW] (cycle 30)")
    axes[1].legend(loc="upper left", fontsize=7.5, framealpha=0.9)
    fig.suptitle("0006 — cumulative effect of each opt-in physics fix vs CBR600 dyno",
                 fontsize=14, fontweight="bold")
    fig.tight_layout()
    fig.savefig(D / "fig01_bp_curves_all_variants.png", dpi=140, bbox_inches="tight")
    plt.close(fig)

    # ---------- Figure 2: RMSE / bias bar chart ----------
    fig, axes = plt.subplots(1, 2, figsize=(14, 6.5))
    x = np.arange(len(VARIANTS))
    w = 0.36
    for ax, metric_name, ylabel in [(axes[0], "rmse", "RMSE vs FSAE-restricted [kW]"),
                                     (axes[1], "bias", "bias (sim − dyno) [kW]")]:
        rs = {e: [] for e in ENGINES}
        for e in ENGINES:
            for v, *_ in VARIANTS:
                errs = []
                d = data.get((v, e), {})
                for r in rpms:
                    row = d.get(r)
                    if row and r in dyno_r:
                        errs.append(row["brake_power_kW"] - dyno_r[r])
                if errs:
                    if metric_name == "rmse":
                        rs[e].append(math.sqrt(sum(x*x for x in errs)/len(errs)))
                    else:
                        rs[e].append(sum(errs)/len(errs))
                else:
                    rs[e].append(np.nan)
        ax.bar(x - w/2, rs["sdm26"], w, color="tab:orange", label="SDM26", alpha=0.85)
        ax.bar(x + w/2, rs["sdm25"], w, color="tab:olive", label="SDM25", alpha=0.85)
        ax.set_xticks(x)
        ax.set_xticklabels([v[1] for v in VARIANTS], rotation=22, ha="right", fontsize=8.5)
        ax.set_ylabel(ylabel)
        ax.grid(True, alpha=0.3, axis="y")
        ax.legend()
        if metric_name == "bias":
            ax.axhline(0, color="black", lw=1)
    fig.suptitle("0006 — aggregate fit quality: RMSE (lower better) + bias (closer to 0 better)",
                 fontsize=13, fontweight="bold")
    fig.tight_layout()
    fig.savefig(D / "fig02_rmse_bias_summary.png", dpi=140, bbox_inches="tight")
    plt.close(fig)

    # ---------- Figure 3: per-knob × per-RPM heatmaps (sensitivity scan) ----------
    SCAN_DIR = D / "sweeps"
    KNOBS = {}
    for fp in sorted(SCAN_DIR.glob("*.ndjson")):
        base = fp.stem.replace("study_", "")
        knob, val_s = base.rsplit("_", 1)
        if not val_s.replace("p", "").replace("n", "").replace("0","").replace("1","").replace("2","").replace("3","").replace("4","").replace("5","").replace("6","").replace("7","").replace("8","").replace("9","").replace(".",""):
            val = float(val_s.replace("p", ".").replace("n", "-"))
        else:
            continue
        rows = {}
        with open(fp) as f:
            for line in f:
                d = json.loads(line)
                if d.get("kind") == "trial":
                    rows[int(d["rpm"])] = d["brake_power_kW"]
        KNOBS.setdefault(knob, {})[val] = rows

    rpm_scan = sorted({r for v in KNOBS.values() for d in v.values() for r in d})
    plot_knobs = [k for k in KNOBS if len(KNOBS[k]) >= 5]
    n_knobs = len(plot_knobs)
    n_cols = 5
    n_rows = (n_knobs + n_cols - 1) // n_cols
    fig, axes = plt.subplots(n_rows, n_cols, figsize=(4.2*n_cols, 3.5*n_rows))
    axes = np.atleast_2d(axes)
    for i, knob in enumerate(plot_knobs):
        r, c = divmod(i, n_cols)
        ax = axes[r, c]
        vals = sorted(KNOBS[knob].keys())
        matrix = np.array([[KNOBS[knob][v].get(rpm, np.nan) for rpm in rpm_scan] for v in vals])
        im = ax.imshow(matrix, aspect="auto", cmap="RdYlGn_r", vmin=15, vmax=60)
        ax.set_xticks(range(len(rpm_scan)))
        ax.set_xticklabels([f"{r/1000:.0f}k" for r in rpm_scan], fontsize=8)
        ax.set_yticks(range(len(vals)))
        ax.set_yticklabels([f"{v:.3g}" for v in vals], fontsize=7.5)
        ax.set_title(knob, fontsize=10)
        for ii in range(len(vals)):
            for jj in range(len(rpm_scan)):
                val = matrix[ii, jj]
                if not np.isnan(val):
                    ax.text(jj, ii, f"{val:.0f}", ha="center", va="center", fontsize=7,
                            color="black" if 30<val<55 else "white")
    # Hide unused
    for i in range(n_knobs, n_rows * n_cols):
        r, c = divmod(i, n_cols)
        axes[r, c].axis("off")
    fig.suptitle("0006 — RPM-resolved BP [kW] for each knob value (sensitivity scan)",
                 fontsize=13, fontweight="bold")
    fig.tight_layout()
    fig.savefig(D / "fig03_sensitivity_heatmap.png", dpi=140, bbox_inches="tight")
    plt.close(fig)

    # ---------- Figure 4: sanity sweeps (plenum, bore, stroke, runner_length) ----------
    SANITY = ["plenum_volume", "bore", "stroke", "runner_length"]
    fig, axes = plt.subplots(2, 2, figsize=(13, 9))
    axes = axes.flatten()
    for ax, knob in zip(axes, SANITY):
        if knob not in KNOBS:
            ax.axis("off"); continue
        vals = sorted(KNOBS[knob].keys())
        cmap = plt.cm.viridis(np.linspace(0, 1, len(vals)))
        for v, c in zip(vals, cmap):
            ys = [KNOBS[knob][v].get(r, np.nan) for r in rpm_scan]
            unit = {"plenum_volume":" m³","bore":" m","stroke":" m","runner_length":" m"}[knob]
            ax.plot(rpm_scan, ys, color=c, marker="o", lw=1.5, ms=5,
                    label=f"{v:.4g}{unit}")
        ax.plot(rpm_scan, [dyno_r.get(r, np.nan) for r in rpm_scan],
                "k-x", lw=2, ms=8, label="FSAE dyno")
        ax.set_xlabel("RPM")
        ax.set_ylabel("brake_power [kW]")
        ax.set_title(f"{knob} sanity sweep")
        ax.grid(True, alpha=0.3)
        ax.legend(loc="best", fontsize=8)
    fig.suptitle("0006 — sanity sweeps: do models respond physically to design knobs?",
                 fontsize=13, fontweight="bold")
    fig.tight_layout()
    fig.savefig(D / "fig04_sanity_sweeps.png", dpi=140, bbox_inches="tight")
    plt.close(fig)

    # ---------- Figure 5: per-RPM gap closure ----------
    fig, axes = plt.subplots(1, 2, figsize=(14, 6))
    for ax, e in zip(axes, ENGINES):
        d_base = data.get(("v0_baseline", e), {})
        d_v7 = data.get(("v7_all_full", e), {})
        gaps_base = [d_base.get(r, {}).get("brake_power_kW", 0) - dyno_r.get(r, 0) for r in rpms]
        gaps_v7 = [d_v7.get(r, {}).get("brake_power_kW", 0) - dyno_r.get(r, 0) for r in rpms]
        width = 350
        ax.bar([r - width for r in rpms], gaps_base, width*2, color="tab:red",
               label="baseline gap (sim − dyno)", alpha=0.65)
        ax.bar([r + width for r in rpms], gaps_v7, width*2, color="tab:green",
               label="ALL 5 fixes gap", alpha=0.65)
        ax.axhline(0, color="black", lw=1.2)
        ax.set_xlabel("RPM")
        ax.set_ylabel("BP gap to FSAE-restricted dyno [kW]   (positive = over-predicting)")
        ax.set_title(f"{e.upper()} — gap closure per RPM")
        ax.grid(True, alpha=0.3, axis="y")
        ax.legend(fontsize=10)
        for i, (g_b, g_v) in enumerate(zip(gaps_base, gaps_v7)):
            ax.text(rpms[i] - width, g_b + (0.5 if g_b > 0 else -1.5),
                    f"{g_b:+.1f}", ha="center", fontsize=7)
            ax.text(rpms[i] + width, g_v + (0.5 if g_v > 0 else -1.5),
                    f"{g_v:+.1f}", ha="center", fontsize=7, color="darkgreen")
    fig.suptitle("0006 — per-RPM gap closure: where the fixes work and where they don't",
                 fontsize=13, fontweight="bold")
    fig.tight_layout()
    fig.savefig(D / "fig05_gap_closure_per_rpm.png", dpi=140, bbox_inches="tight")
    plt.close(fig)

    # ---------- Figure 6: residual gap remaining ----------
    fig, ax = plt.subplots(figsize=(11, 6))
    width = 0.35
    x = np.arange(len(rpms))
    for ei, (e, color) in enumerate([("sdm26", "tab:orange"), ("sdm25", "tab:olive")]):
        d_v7 = data.get(("v7_all_full", e), {})
        gaps = [d_v7.get(r, {}).get("brake_power_kW", 0) - dyno_r.get(r, 0) for r in rpms]
        ax.bar(x + (ei - 0.5)*width, gaps, width, color=color, label=f"{e.upper()}")
        for i, g in enumerate(gaps):
            ax.text(x[i] + (ei - 0.5)*width, g + (0.5 if g > 0 else -1.5),
                    f"{g:+.1f}", ha="center", fontsize=8)
    ax.set_xticks(x)
    ax.set_xticklabels([f"{r}" for r in rpms])
    ax.set_xlabel("RPM")
    ax.set_ylabel("residual BP gap [kW]   (positive = over, negative = under)")
    ax.axhline(0, color="black", lw=1.2)
    ax.axhspan(-5, 5, color="green", alpha=0.07, label="±5 kW dyno spread")
    ax.set_title("0006 — residual gap after ALL 5 fixes (sim − FSAE-restricted dyno)")
    ax.grid(True, alpha=0.3, axis="y")
    ax.legend()
    fig.tight_layout()
    fig.savefig(D / "fig06_residual_gap.png", dpi=140, bbox_inches="tight")
    plt.close(fig)

    print("Wrote 6 figures to", D)


if __name__ == "__main__":
    main()
