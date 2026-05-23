#!/usr/bin/env python3
"""Generate before/after plots for finding 0005.

Run from repo root:
    python3 physics_findings/0005-junction-loss-in-residual/plot_results.py
"""
import csv
import json
import math
import os
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
D = ROOT / "physics_findings/0005-junction-loss-in-residual"
DYNO = ROOT / "physics_findings/references/dyno"

VARIANTS = [
    ("baseline",       "K=0 (current)",          "tab:red",    "o", "-"),
    ("intake_bc",      "+intake K_BC (geom)",    "tab:blue",   "s", "-"),
    ("intake_exh_bc",  "+intake+exhaust K_BC",   "tab:green",  "^", "-"),
    ("bc_half",        "K_BC × 0.5 (sens.)",     "tab:cyan",   "v", "--"),
    ("bc_double",      "K_BC × 2.0 (sens.)",     "tab:purple", "D", "--"),
]
ENGINES = ["sdm26", "sdm25"]


def load_trials(path):
    out = {}
    with open(path) as f:
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
    data = {}
    for e in ENGINES:
        for v, *_ in VARIANTS:
            p = D / f"results_{e}_{v}.ndjson"
            if p.exists():
                data[(e, v)] = load_trials(p)
    dyno_r = load_dyno("fsae-restricted")
    dyno_u = load_dyno("stock-unrestricted")
    rpms = sorted(data[("sdm26", "baseline")].keys())

    # ---------- Figure 1: Brake-power curves (SDM26 + SDM25) ----------
    fig, axes = plt.subplots(1, 2, figsize=(14, 6), sharey=True)
    for ax, e in zip(axes, ENGINES):
        for v, label, color, marker, ls in VARIANTS:
            ys = [data[(e, v)].get(r, {}).get("brake_power_kW", np.nan) for r in rpms]
            ax.plot(rpms, ys, color=color, marker=marker, linestyle=ls, label=label, lw=1.6, ms=6)
        d_r = [dyno_r.get(r, np.nan) for r in rpms]
        d_u = [dyno_u.get(r, np.nan) for r in rpms]
        ax.plot(rpms, d_r, color="black", marker="x", lw=2.2, ms=8, label="FSAE-restricted (dyno)")
        ax.plot(rpms, d_u, color="gray", marker="*", lw=1.5, ms=10, label="stock-unrestricted (dyno)", alpha=0.7)
        ax.set_xlabel("Engine RPM")
        ax.set_title(f"{e.upper()} — brake_power vs RPM")
        ax.grid(True, alpha=0.3)
        ax.axhspan(41, 52, color="black", alpha=0.06, label="FSAE band 41-52 kW")
        if e == ENGINES[0]:
            ax.set_ylabel("brake_power [kW] (cycle 30)")
    axes[0].legend(loc="upper left", fontsize=8)
    fig.suptitle("0005 — junction-loss-in-residual: brake power vs CBR600 dyno", fontsize=14, fontweight="bold")
    fig.tight_layout()
    fig.savefig(D / "fig01_brake_power_curves.png", dpi=140, bbox_inches="tight")
    plt.close(fig)

    # ---------- Figure 2: VE curves ----------
    fig, axes = plt.subplots(1, 2, figsize=(14, 6), sharey=True)
    for ax, e in zip(axes, ENGINES):
        for v, label, color, marker, ls in VARIANTS:
            ys = [data[(e, v)].get(r, {}).get("ve_atm", np.nan) for r in rpms]
            ax.plot(rpms, ys, color=color, marker=marker, linestyle=ls, label=label, lw=1.6, ms=6)
        ax.axhline(1.0, color="black", lw=0.8, ls=":", label="VE = 1.0 (perfectly filled)")
        ax.axhspan(0.95, 1.05, color="green", alpha=0.07, label="literature tuned-peak band")
        ax.set_xlabel("Engine RPM")
        ax.set_title(f"{e.upper()} — VE vs RPM")
        ax.grid(True, alpha=0.3)
        if e == ENGINES[0]:
            ax.set_ylabel("VE (intake mass / atm-displaced)")
    axes[0].legend(loc="lower left", fontsize=8)
    fig.suptitle("0005 — volumetric efficiency: VE > 1 collapses to literature-plausible band", fontsize=13, fontweight="bold")
    fig.tight_layout()
    fig.savefig(D / "fig02_ve_curves.png", dpi=140, bbox_inches="tight")
    plt.close(fig)

    # ---------- Figure 3: mass-conservation residual ----------
    fig, axes = plt.subplots(1, 2, figsize=(14, 6), sharey=True)
    for ax, e in zip(axes, ENGINES):
        for v, label, color, marker, ls in VARIANTS:
            ys = []
            for r in rpms:
                d = data[(e, v)].get(r, {})
                if not d:
                    ys.append(np.nan); continue
                mt = d.get("mass_total_kg", 1) or 1
                ys.append(abs(d["nonconservation"] / mt))
            ax.semilogy(rpms, ys, color=color, marker=marker, linestyle=ls, label=label, lw=1.6, ms=6)
        ax.axhline(5e-4, color="red", lw=1.6, ls="--", label="C9 char band (5e-4)")
        ax.axhline(1e-10, color="darkred", lw=1, ls=":", label="C9 CV band (1e-10)")
        ax.set_xlabel("Engine RPM")
        ax.set_title(f"{e.upper()} — |nonconservation_rel|")
        ax.grid(True, alpha=0.3, which="both")
        if e == ENGINES[0]:
            ax.set_ylabel("|nc| / mass_total (relative)")
    axes[0].legend(loc="lower left", fontsize=8)
    fig.suptitle("0005 — mass conservation: in-residual loss preserves the C9 band at all K", fontsize=13, fontweight="bold")
    fig.tight_layout()
    fig.savefig(D / "fig03_conservation_residual.png", dpi=140, bbox_inches="tight")
    plt.close(fig)

    # ---------- Figure 4: K-sweep BP vs nc_rel (before-after demo) ----------
    # Load the 0004 K-probe (old wiring) + the 0005 K-recheck on baseline-config
    fig, axes = plt.subplots(1, 2, figsize=(14, 6))
    # Old wiring (pre-0005): use 0004 sweeps where K was scalar
    OLD = ROOT / "physics_findings/0004-junction-kind-imep-sensitivity/sweeps"
    K_VALUES = [0.0, 0.1, 0.5, 1.0, 2.0, 5.0, 10.0]
    bp_old, bp_new = [], []
    nc_old, nc_new = [], []
    for k in K_VALUES:
        p_old = OLD / f"study_jloss_characteristic_{k}.ndjson"
        if p_old.exists():
            with open(p_old) as f:
                for line in f:
                    d = json.loads(line)
                    if d.get("kind") == "trial" and int(d["rpm"]) == 8000:
                        mt = d.get("mass_total_kg", 1) or 1
                        bp_old.append((k, d["brake_power_kW"]))
                        nc_old.append((k, abs(d["nonconservation"] / mt)))
                        break
        # New wiring (post-0005): regenerate inline (cheap)
    # Re-load the post-0005 study results we saved
    # We use the SDM26 baseline-config sweeps generated by this finding's earlier
    # quick check; if not present, fall back to recomputing on the fly.
    POST = D / "results_kpost_8000.json"
    if not POST.exists():
        import subprocess
        # Run an inline sweep at K = K_VALUES and capture (BP, nc) at 8000 RPM
        tmp = D / "tmp_kpost.toml"
        # use BC mode off + scalar K for direct comparison
        for k in K_VALUES:
            tmp.write_text(
                f"[run]\nconfig = \"crates/engine-sim/python_ref/configs/sdm26.json\"\nrpm = [8000.0]\ncycles = 30\nrecorded = true\nseed = 5050\njunction = \"characteristic\"\n[environment]\ntarget_triple = \"aarch64-apple-darwin\"\nrustc_version = \"rustc 1.95.0\"\nrayon_threads = 1\nlibm_source = \"system\"\n[sweep]\nsampler = \"lhs\"\nn_trials = 1\nparameters = [\n  {{ name = \"intake_junction_loss_coef\", min = {k}, max = {k} }},\n]\n[[acceptance]]\nmetric = \"brake_power_kW\"\ntarget = 30.5\ntolerance = \"±20%\"\ncitation = \"FSAE 8000 RPM\"\n"
            )
            out_p = D / f"results_kpost_{k}.ndjson"
            subprocess.run([str(ROOT / "target/release/helios-bench"), "sweep", "--out", str(out_p), str(tmp), "--commit", "0005-kpost"], check=True, capture_output=True)
            with open(out_p) as f:
                for line in f:
                    d = json.loads(line)
                    if d.get("kind") == "trial":
                        mt = d.get("mass_total_kg", 1) or 1
                        bp_new.append((k, d["brake_power_kW"]))
                        nc_new.append((k, abs(d["nonconservation"] / mt)))
                        break
            out_p.unlink(missing_ok=True)
        tmp.unlink(missing_ok=True)
        with open(POST, "w") as f:
            json.dump({"bp_new": bp_new, "nc_new": nc_new}, f)
    else:
        with open(POST) as f:
            payload = json.load(f)
        bp_new = [tuple(x) for x in payload["bp_new"]]
        nc_new = [tuple(x) for x in payload["nc_new"]]

    ax = axes[0]
    if bp_old:
        ks, bps = zip(*bp_old)
        ax.plot(ks, bps, "o-", color="tab:red", label="pre-0005 (ghost-write loss)", lw=2)
    if bp_new:
        ks, bps = zip(*bp_new)
        ax.plot(ks, bps, "s-", color="tab:green", label="post-0005 (in-residual loss)", lw=2)
    ax.axhline(30.5, color="black", lw=1.2, ls=":", label="FSAE dyno @ 8000 RPM (30.5 kW)")
    ax.set_xlabel("intake_junction_loss_coef (scalar K)")
    ax.set_ylabel("brake_power [kW] @ 8000 RPM, cycle 30")
    ax.set_title("Effect of K on BP — same direction, different magnitude")
    ax.grid(True, alpha=0.3)
    ax.legend(fontsize=9)

    ax = axes[1]
    if nc_old:
        ks, ncs = zip(*nc_old)
        ax.semilogy(ks, ncs, "o-", color="tab:red", label="pre-0005 (ghost-write loss)", lw=2)
    if nc_new:
        ks, ncs = zip(*nc_new)
        ax.semilogy(ks, ncs, "s-", color="tab:green", label="post-0005 (in-residual loss)", lw=2)
    ax.axhline(5e-4, color="red", lw=1.6, ls="--", label="C9 char band (5e-4)")
    ax.set_xlabel("intake_junction_loss_coef (scalar K)")
    ax.set_ylabel("|nonconservation_rel| @ 8000 RPM")
    ax.set_title("Mass conservation: in-residual stays in band at every K")
    ax.grid(True, alpha=0.3, which="both")
    ax.legend(fontsize=9)
    fig.suptitle("0005 — wiring fix: same physics knob, C9 conservation now preserved", fontsize=13, fontweight="bold")
    fig.tight_layout()
    fig.savefig(D / "fig04_wiring_fix_before_after.png", dpi=140, bbox_inches="tight")
    plt.close(fig)

    # ---------- Figure 5: SDM26 vs SDM25 RMSE summary bar chart ----------
    fig, ax = plt.subplots(figsize=(11, 6))
    x = np.arange(len(VARIANTS))
    w = 0.36
    rmses = {e: [] for e in ENGINES}
    biases = {e: [] for e in ENGINES}
    for e in ENGINES:
        for v, *_ in VARIANTS:
            errs = []
            for r in rpms:
                d = data.get((e, v), {}).get(r)
                if d and r in dyno_r:
                    errs.append(d["brake_power_kW"] - dyno_r[r])
            if errs:
                rmses[e].append(math.sqrt(sum(x*x for x in errs)/len(errs)))
                biases[e].append(sum(errs)/len(errs))
            else:
                rmses[e].append(np.nan)
                biases[e].append(np.nan)
    ax.bar(x - w/2, rmses["sdm26"], w, color="tab:orange", label="SDM26 RMSE")
    ax.bar(x + w/2, rmses["sdm25"], w, color="tab:olive", label="SDM25 RMSE")
    ax.set_xticks(x)
    ax.set_xticklabels([v[1] for v in VARIANTS], rotation=20, ha="right")
    ax.set_ylabel("RMSE vs FSAE-restricted dyno [kW]  (lower is better)")
    ax.set_title("0005 — aggregate fit quality across the 5 variants × 2 calibrations")
    ax.grid(True, alpha=0.3, axis="y")
    ax.legend()
    # Annotate bars with the bias (signed mean error)
    for i, (v, *_) in enumerate(VARIANTS):
        for j, e in enumerate(ENGINES):
            xpos = i - w/2 + j*w
            rmse = rmses[e][i]
            bias = biases[e][i]
            if not np.isnan(rmse):
                ax.text(xpos, rmse + 0.15, f"bias={bias:+.1f}", ha="center", va="bottom", fontsize=7.5)
    fig.tight_layout()
    fig.savefig(D / "fig05_rmse_summary.png", dpi=140, bbox_inches="tight")
    plt.close(fig)

    print("Wrote 5 figures to", D)


if __name__ == "__main__":
    main()
