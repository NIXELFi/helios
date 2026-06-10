"""
Analyze the per-engine LHS optimization sweep and rank trials by
several objectives. For each engine and each objective, identify the
"best" trial and plot its torque/HP curve, plus a summary table.

Objectives (computed from each trial's full RPM curve):
  - peak_tq        — max wheel torque (primary)
  - auc_tq         — area under wheel-torque-vs-rpm (primary)
  - peak_hp        — max wheel hp (bonus)
  - auc_hp         — area under wheel-hp-vs-rpm (bonus)

For each (engine, objective) winner:
  - print parameter values
  - plot the resulting curve
  - compute % improvement vs Option B baseline (from 0026 sweep)
"""
from __future__ import annotations
import json
import math
from collections import defaultdict
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

ROOT = Path("/Users/nmurray/Developer/helios")
HERE = ROOT / "physics_findings/0027-multi-engine-optimization"
SWEEP_DIR = ROOT / "physics_findings/0026-multi-engine-sweep"

ETA_DRIVETRAIN = 0.85
KW_TO_HP = 1.34102

OBJECTIVES = ["peak_tq", "auc_tq", "peak_hp", "auc_hp"]

# Display names + colours
ENGINE_META = {
    "SDM26_baseline":                      ("SDM26 baseline  (599cc 4)",     "#000000",   "quad"),
    "SDM26_Honda_CRF450R_2020":            ("Honda CRF450R '20  (449cc 1)",  "#E63946",   "single"),
    "SDM26_KTM_690_Duke_2018":             ("KTM 690 Duke '18  (693cc 1)",   "#FFC627",   "single"),
    "SDM26_Yamaha_YZ450F_2024":            ("Yamaha YZ450F '24  (449cc 1)",  "#F4A261",   "single"),
    "SDM26_Triumph_Daytona_675R_2011":     ("Triumph Daytona 675R '11  (675cc 3)", "#9D4EDD", "triple"),
    "SDM26_Kawasaki_ZX-6R_636_2003-2004":  ("Kawasaki ZX-6R 636 '03-'04  (636cc 4)", "#06D6A0", "quad"),
    "SDM26_Suzuki_GSX-R600_2006":          ("Suzuki GSX-R600 '06  (599cc 4)", "#118AB2",   "quad"),
    "SDM26_Yamaha_YZF-R6_2009":            ("Yamaha YZF-R6 '09  (599cc 4)",   "#073B4C",   "quad"),
}

OPT_PARAMS = [
    "runner_length", "runner_diameter_in", "plenum_volume", "plenum_length",
    "primary_length", "primary_diameter_in", "collector_length", "collector_diameter_in",
    "secondary_length", "secondary_diameter_in",
]


def auc_trapz(xs, ys):
    a = 0.0
    for i in range(1, len(xs)):
        a += 0.5 * (ys[i] + ys[i-1]) * (xs[i] - xs[i-1])
    return a


def load_trials(path: Path):
    """Group ndjson trial-RPM records by trial_id. Returns dict
    {trial_id: {"rpms": [...], "wp_hp": [...], "wt_nm": [...], "overrides": {...}}}."""
    by_trial = defaultdict(lambda: {"rpms": [], "bp_kw": [], "overrides": {}})
    with open(path) as f:
        for line in f:
            d = json.loads(line)
            if d.get("kind") != "trial":
                continue
            tid = d["trial_id"]
            by_trial[tid]["rpms"].append(d["rpm"])
            by_trial[tid]["bp_kw"].append(d["brake_power_kW"])
            if not by_trial[tid]["overrides"]:
                by_trial[tid]["overrides"] = d.get("overrides", {})
    out = {}
    for tid, t in by_trial.items():
        rpms = np.array(t["rpms"])
        order = np.argsort(rpms)
        rpms = rpms[order]
        bp_kw = np.array(t["bp_kw"])[order]
        wp_kw = bp_kw * ETA_DRIVETRAIN
        wp_hp = wp_kw * KW_TO_HP
        omega = 2 * math.pi * rpms / 60.0
        wt_nm = (wp_kw * 1000.0) / omega
        out[tid] = {
            "rpms": rpms,
            "bp_kw": bp_kw,
            "wp_kw": wp_kw,
            "wp_hp": wp_hp,
            "wt_nm": wt_nm,
            "overrides": t["overrides"],
            "peak_hp": float(wp_hp.max()),
            "peak_hp_rpm": int(rpms[int(np.argmax(wp_hp))]),
            "peak_tq": float(wt_nm.max()),
            "peak_tq_rpm": int(rpms[int(np.argmax(wt_nm))]),
            "auc_hp": auc_trapz(rpms, wp_hp),
            "auc_tq": auc_trapz(rpms, wt_nm),
        }
    return out


def load_baseline_curves():
    """Load the Option B baseline curves from finding 0026 for comparison."""
    out = {}
    for stem in ENGINE_META:
        path = SWEEP_DIR / "results" / f"{stem}.ndjson"
        if not path.exists():
            continue
        rows = []
        with open(path) as f:
            for line in f:
                d = json.loads(line)
                if d.get("kind") == "trial":
                    rows.append(d)
        rows.sort(key=lambda r: r["rpm"])
        rpms = np.array([r["rpm"] for r in rows])
        bp_kw = np.array([r["brake_power_kW"] for r in rows])
        wp_kw = bp_kw * ETA_DRIVETRAIN
        wp_hp = wp_kw * KW_TO_HP
        omega = 2 * math.pi * rpms / 60.0
        wt_nm = (wp_kw * 1000.0) / omega
        out[stem] = {
            "rpms": rpms,
            "wp_hp": wp_hp,
            "wt_nm": wt_nm,
            "peak_hp": float(wp_hp.max()),
            "peak_tq": float(wt_nm.max()),
            "auc_hp": auc_trapz(rpms, wp_hp),
            "auc_tq": auc_trapz(rpms, wt_nm),
        }
    return out


def main():
    baselines = load_baseline_curves()

    # Collect per-engine optimization results
    per_engine = {}
    for stem in ENGINE_META:
        path = HERE / "results" / f"{stem}.ndjson"
        if not path.exists():
            print(f"missing: {path}")
            continue
        trials = load_trials(path)
        if not trials:
            continue
        winners = {}
        for obj in OBJECTIVES:
            best_tid = max(trials, key=lambda t: trials[t][obj])
            winners[obj] = (best_tid, trials[best_tid])
        per_engine[stem] = {"trials": trials, "winners": winners}
        print(f"{stem}: {len(trials)} trials")

    if not per_engine:
        print("no data yet")
        return

    # === Plot 1: 4 panels (one per objective), all engines' best-curves overlaid ===
    fig, axes = plt.subplots(2, 2, figsize=(18, 12))
    obj_layout = [
        ("peak_tq",  "Best peak torque",            "Wheel torque [N·m]",   "wt_nm",     axes[0][0]),
        ("auc_tq",   "Best AUC torque (broadest)",  "Wheel torque [N·m]",   "wt_nm",     axes[0][1]),
        ("peak_hp",  "Best peak HP",                "Wheel HP",             "wp_hp",     axes[1][0]),
        ("auc_hp",   "Best AUC HP (broadest)",      "Wheel HP",             "wp_hp",     axes[1][1]),
    ]
    for obj, title, ylab, curve_key, ax in obj_layout:
        for stem, (label, colour, _) in ENGINE_META.items():
            if stem not in per_engine:
                continue
            tr = per_engine[stem]["winners"][obj][1]
            ax.plot(tr["rpms"], tr[curve_key], "-", color=colour, lw=2.0, label=label)
            # baseline
            if stem in baselines:
                ax.plot(baselines[stem]["rpms"], baselines[stem][curve_key],
                        ":", color=colour, lw=1.0, alpha=0.5)
        ax.set_xlabel("Engine RPM")
        ax.set_ylabel(ylab)
        ax.set_title(f"{title}  (solid = optimized, dotted = Option B baseline)", fontsize=11)
        ax.grid(True, alpha=0.3)
        if obj == "peak_tq":
            ax.legend(loc="upper right", fontsize=7, framealpha=0.92)
    fig.suptitle("Multi-engine optimization — best trial per objective",
                 fontsize=13, weight="bold")
    fig.tight_layout()
    out1 = HERE / "fig_optimization_by_objective.png"
    fig.savefig(out1, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"Wrote {out1}")

    # === Plot 2: per-engine improvement table ===
    fig, ax = plt.subplots(figsize=(20, 6))
    ax.axis("off")
    headers = ["Engine", "Obj-B peak Tq", "Opt peak Tq", "Δ%",
               "Obj-B AUC Tq", "Opt AUC Tq", "Δ%",
               "Obj-B peak HP", "Opt peak HP", "Δ%"]
    rows = []
    # Sort by AUC-Tq winner (treating that as the "main" objective)
    for stem in sorted(per_engine, key=lambda s: -per_engine[s]["winners"]["auc_tq"][1]["auc_tq"]):
        base = baselines.get(stem)
        if not base:
            continue
        win = per_engine[stem]["winners"]
        rows.append([
            ENGINE_META[stem][0],
            f"{base['peak_tq']:.1f}",
            f"{win['peak_tq'][1]['peak_tq']:.1f}",
            f"{100*(win['peak_tq'][1]['peak_tq']/base['peak_tq']-1):+.1f}%",
            f"{base['auc_tq']/1000:.1f}k",
            f"{win['auc_tq'][1]['auc_tq']/1000:.1f}k",
            f"{100*(win['auc_tq'][1]['auc_tq']/base['auc_tq']-1):+.1f}%",
            f"{base['peak_hp']:.1f}",
            f"{win['peak_hp'][1]['peak_hp']:.1f}",
            f"{100*(win['peak_hp'][1]['peak_hp']/base['peak_hp']-1):+.1f}%",
        ])
    table = ax.table(cellText=rows, colLabels=headers,
                     cellLoc="center", loc="center",
                     colWidths=[0.32] + [0.075]*9)
    table.auto_set_font_size(False)
    table.set_fontsize(9)
    table.scale(1, 1.8)
    for i in range(len(headers)):
        c = table[(0, i)]
        c.set_facecolor("#16171B")
        c.set_text_props(color="#FFC627", weight="bold")
    for r in range(1, len(rows) + 1):
        bg = "#FAFAFA" if r % 2 else "#EEEEEE"
        for ci in range(len(headers)):
            cell = table[(r, ci)]
            cell.set_facecolor(bg)
            if ci == 0:
                for stem, (lbl, colour, _) in ENGINE_META.items():
                    if lbl == rows[r-1][0]:
                        cell.set_text_props(color=colour, weight="bold")
                        break
            # Highlight % improvement cells green/red
            if ci in (3, 6, 9):
                val = rows[r-1][ci]
                if val.startswith("+"):
                    cell.set_text_props(color="#1B7E2A", weight="bold")
                elif val.startswith("-"):
                    cell.set_text_props(color="#A8201A", weight="bold")
    fig.suptitle("Optimization improvements vs Option B baseline", fontsize=12, weight="bold")
    out2 = HERE / "fig_improvement_table.png"
    fig.savefig(out2, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"Wrote {out2}")

    # === Plot 3: parameter winners — print as text for each engine + objective ===
    txt_path = HERE / "winners_parameters.md"
    with open(txt_path, "w") as f:
        f.write("# Best trial parameters per engine per objective\n\n")
        for stem in ENGINE_META:
            if stem not in per_engine:
                continue
            label = ENGINE_META[stem][0]
            f.write(f"## {label}\n\n")
            for obj in OBJECTIVES:
                tid, tr = per_engine[stem]["winners"][obj]
                f.write(f"### {obj} winner — trial {tid}\n")
                f.write(f"- peak HP = {tr['peak_hp']:.1f} hp @ {tr['peak_hp_rpm']} RPM\n")
                f.write(f"- peak torque = {tr['peak_tq']:.1f} N·m @ {tr['peak_tq_rpm']} RPM\n")
                f.write(f"- AUC HP = {tr['auc_hp']/1000:.1f}k hp·RPM\n")
                f.write(f"- AUC torque = {tr['auc_tq']/1000:.1f}k N·m·RPM\n")
                f.write("\n**parameters:**\n")
                ov = tr["overrides"]
                for p in OPT_PARAMS:
                    if p in ov:
                        v = ov[p]
                        if "length" in p:
                            f.write(f"  - {p}: {v*1000:.1f} mm\n")
                        elif "diameter" in p:
                            f.write(f"  - {p}: {v*1000:.2f} mm\n")
                        elif "volume" in p:
                            f.write(f"  - {p}: {v*1000:.2f} L\n")
                        else:
                            f.write(f"  - {p}: {v}\n")
                f.write("\n")
    print(f"Wrote {txt_path}")

    # === CSV with everything ===
    csv_path = HERE / "optimization_summary.csv"
    with open(csv_path, "w") as f:
        f.write("engine,objective,trial_id,peak_hp,peak_hp_rpm,peak_tq,peak_tq_rpm,auc_hp,auc_tq\n")
        for stem in ENGINE_META:
            if stem not in per_engine:
                continue
            for obj in OBJECTIVES:
                tid, tr = per_engine[stem]["winners"][obj]
                f.write(f"{ENGINE_META[stem][0]},{obj},{tid},{tr['peak_hp']:.2f},{tr['peak_hp_rpm']},"
                        f"{tr['peak_tq']:.2f},{tr['peak_tq_rpm']},{tr['auc_hp']:.1f},{tr['auc_tq']:.1f}\n")
    print(f"Wrote {csv_path}")


if __name__ == "__main__":
    main()
