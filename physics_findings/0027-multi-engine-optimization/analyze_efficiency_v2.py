"""
v2 efficiency analysis — uses the v2 optimization data (per-engine FMEP +
cam timing optimized) and an autocross-realistic RPM time histogram
instead of power-weighted uniform-over-WOT.

The RPM time distribution we use: a typical FSAE autocross spends most of
its time in the 50-80% engine speed range (driver is short-shifting or
modulating throttle for grip). Specifically, the histogram below is a
gaussian centered at 60% of the engine's WOT band, σ = 15%.

For each engine:
  1. From v2 LHS trials, find the trial that minimizes autocross-weighted
     BSFC at the engine's preferred AFR (sweep AFR ∈ {12.5..16.5}).
  2. Report avg BSFC, peak power, and CO2/kWh under autocross weighting.

Lower CO2/kWh = better FSAE Efficiency score.
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
SUMMARY = ROOT / "physics_findings/0026-multi-engine-sweep/configs/summary.json"

ETA_DRIVETRAIN = 0.85
CO2_PER_KG_FUEL = 3.18
KW_TO_HP = 1.34102
H_TO_S = 3600.0
AFR_TARGET_INITIAL = 13.1   # AFR used in the v2 sims; we re-scale fuel below

ENGINE_META = {
    "SDM26_baseline":                      ("SDM26 baseline  (599cc 4)",     "#000000",  4),
    "SDM26_Honda_CRF450R_2020":            ("Honda CRF450R '20  (449cc 1)",  "#E63946",  1),
    "SDM26_KTM_690_Duke_2018":             ("KTM 690 Duke '18  (693cc 1)",   "#FFC627",  1),
    "SDM26_Yamaha_YZ450F_2024":            ("Yamaha YZ450F '24  (449cc 1)",  "#F4A261",  1),
    "SDM26_Triumph_Daytona_675R_2011":     ("Triumph Daytona 675R '11  (675cc 3)", "#9D4EDD", 3),
    "SDM26_Kawasaki_ZX-6R_636_2003-2004":  ("Kawasaki ZX-6R 636 '03-'04  (636cc 4)", "#06D6A0", 4),
    "SDM26_Suzuki_GSX-R600_2006":          ("Suzuki GSX-R600 '06  (599cc 4)", "#118AB2", 4),
    "SDM26_Yamaha_YZF-R6_2009":            ("Yamaha YZF-R6 '09  (599cc 4)",   "#073B4C", 4),
}


def autocross_weights(rpms: np.ndarray, rpm_lo: int, rpm_hi: int) -> np.ndarray:
    """Gaussian centered at 60% of the WOT band, σ = 15% of band width.
    Represents the time a driver spends at each engine RPM in autocross —
    mostly mid-rev, never sustained redline, never sustained idle.
    """
    band = rpm_hi - rpm_lo
    center = rpm_lo + 0.60 * band
    sigma = 0.15 * band
    w = np.exp(-0.5 * ((rpms - center) / sigma) ** 2)
    return w / w.sum()


def load_trials(path: Path):
    by_trial = defaultdict(lambda: {"rpms": [], "bp_kw": [], "intake_g": [], "overrides": {}})
    with open(path) as f:
        for line in f:
            d = json.loads(line)
            if d.get("kind") != "trial":
                continue
            tid = d["trial_id"]
            by_trial[tid]["rpms"].append(d["rpm"])
            by_trial[tid]["bp_kw"].append(d["brake_power_kW"])
            by_trial[tid]["intake_g"].append(d["intake_mass_per_cycle_g"])
            if not by_trial[tid]["overrides"]:
                by_trial[tid]["overrides"] = d.get("overrides", {})
    out = {}
    for tid, t in by_trial.items():
        rpms = np.array(t["rpms"])
        order = np.argsort(rpms)
        out[tid] = {
            "rpms": rpms[order],
            "bp_kw": np.array(t["bp_kw"])[order],
            "intake_g": np.array(t["intake_g"])[order],
            "overrides": t["overrides"],
        }
    return out


def bsfc_at_afr(trial, afr):
    """For a given trial and afr, compute BSFC at each RPM. The simulator
    was run at AFR=13.1; here we re-scale fuel mass and assume η_thermal
    increases slightly with leaner mixture (approx Otto cycle with γ from
    mixture composition — linear approximation valid for AFR ∈ [12, 17]).

    Combustion-efficiency correction (Heywood Tab 4.1 / finding 0009):
       φ = afr_stoich / afr ; afr_stoich ≈ 14.7
       η_comb_corr(φ):
         φ > 1.0 (rich): 1.0
         0.85 < φ ≤ 1.0: linearly to 1.0 → 1.0
         0.7 ≤ φ ≤ 0.85: 0.85 → 1.0  (lean, mild loss)
         0.6 ≤ φ < 0.7: 0.30 → 0.85  (steep misfire cliff)
         φ < 0.6: 0.30 (hard misfire)
    Plus a small +η_thermal benefit at lean: ~1.5%/AFR-unit-above-stoich
    until misfire bites.
    """
    afr_stoich = 14.7
    phi = afr_stoich / afr
    # Combustion efficiency factor (approximate)
    if phi > 1.0:
        eta_comb = 1.0
    elif phi > 0.85:
        eta_comb = 1.0
    elif phi > 0.7:
        eta_comb = 0.85 + (phi - 0.7) * (1.0 - 0.85) / 0.15
    elif phi > 0.6:
        eta_comb = 0.30 + (phi - 0.6) * (0.85 - 0.30) / 0.1
    else:
        eta_comb = 0.30
    # Otto cycle thermal-efficiency factor with γ from mixture
    # γ_mixture ≈ 1.30 + 0.005·(afr - 13)
    # η_otto = 1 - 1/CR^(γ-1)
    # CR ≈ 13 here; for AFR shift from 13 → 14.7, η_otto increases ~2-3%
    # We approximate by a smooth multiplier:
    eta_lean_bonus = 1.0 + max(0.0, min(0.025, 0.014 * (afr - 13.1)))

    # BP scales with eta_comb × eta_lean_bonus × (fuel_at_this_afr / fuel_at_sim_afr).
    # fuel = air / afr ; air stays the same (engine breathing unchanged).
    fuel_ratio = AFR_TARGET_INITIAL / afr   # less fuel for leaner (afr higher)
    bp_kw_scaled = trial["bp_kw"] * fuel_ratio * eta_comb * eta_lean_bonus
    fuel_g_per_cycle = trial["intake_g"] / afr
    fuel_g_per_sec = fuel_g_per_cycle * (trial["rpms"] / 120.0)
    bsfc = np.where(bp_kw_scaled > 0.1,
                    fuel_g_per_sec * H_TO_S / bp_kw_scaled,
                    np.nan)
    return bsfc, bp_kw_scaled


def main():
    eng_info = {e["name"]: e for e in json.loads(SUMMARY.read_text())}
    afrs = [12.5, 13.1, 13.5, 14.0, 14.7, 15.5, 16.5]

    engines_out = {}
    for stem, (label, colour, n_cyl) in ENGINE_META.items():
        v2_path = HERE / "results_v2" / f"{stem}.ndjson"
        if not v2_path.exists():
            continue
        info = eng_info[stem]
        trials = load_trials(v2_path)
        if not trials:
            continue

        weights = autocross_weights(np.array(info["rpms"]), info["rpm_lo"], info["rpm_hi"])
        # rpm-list in trial may not match exactly; recompute weights per-trial
        best_combo = None  # (trial_id, afr, bsfc_autocross, peak_hp_kw)
        for tid, trial in trials.items():
            w = autocross_weights(trial["rpms"], info["rpm_lo"], info["rpm_hi"])
            for afr in afrs:
                bsfc, bp_kw_scaled = bsfc_at_afr(trial, afr)
                # autocross-weighted average BSFC (∑ w × bsfc) / ∑ w
                valid = ~np.isnan(bsfc)
                if not valid.any():
                    continue
                avg_bsfc = np.average(bsfc[valid], weights=w[valid])
                peak_hp = float(bp_kw_scaled.max() * ETA_DRIVETRAIN)
                # Penalize if peak HP drops too much (drivability) — keep
                # peak ≥ 80% of best-AFR peak. Simpler: just track and
                # report.
                if (best_combo is None) or (avg_bsfc < best_combo[2]):
                    best_combo = (tid, afr, avg_bsfc, peak_hp,
                                  bp_kw_scaled.copy(), bsfc.copy(),
                                  trial["rpms"].copy(), trial["overrides"])
        if best_combo is None:
            continue
        tid, afr, avg_bsfc, peak_hp, bp, bsfc, rpms, overrides = best_combo
        engines_out[stem] = {
            "label": label, "colour": colour, "n_cyl": n_cyl,
            "best_trial": tid, "best_afr": afr,
            "avg_bsfc": avg_bsfc, "co2": avg_bsfc * CO2_PER_KG_FUEL,
            "peak_hp_kw": peak_hp,
            "rpms": rpms, "bp_kw": bp, "bsfc_curve": bsfc,
            "overrides": overrides,
            "rpm_lo": info["rpm_lo"], "rpm_hi": info["rpm_hi"],
        }

    if not engines_out:
        print("No v2 data yet.")
        return

    # ------ plot ------
    fig, axes = plt.subplots(2, 2, figsize=(18, 12))
    ax_bsfc = axes[0][0]
    ax_w = axes[0][1]
    ax_bar = axes[1][0]
    ax_tab = axes[1][1]
    ax_tab.axis("off")

    # BSFC curves (best AFR per engine)
    for stem, e in engines_out.items():
        ax_bsfc.plot(e["rpms"], e["bsfc_curve"], "-", color=e["colour"], lw=2,
                     label=f"{e['label']}  (AFR {e['best_afr']})")
    ax_bsfc.set_xlabel("Engine RPM")
    ax_bsfc.set_ylabel("BSFC [g / kWh]")
    ax_bsfc.set_title("BSFC vs RPM at each engine's most-efficient AFR (v2)",
                      fontsize=11)
    ax_bsfc.grid(True, alpha=0.3)
    ax_bsfc.legend(loc="upper right", fontsize=8)
    ax_bsfc.set_ylim(150, 600)

    # Autocross weight histogram per engine (shows where weight is concentrated)
    for stem, e in engines_out.items():
        rpms = e["rpms"]
        w = autocross_weights(rpms, e["rpm_lo"], e["rpm_hi"])
        ax_w.fill_between(rpms, w, alpha=0.25, color=e["colour"])
        ax_w.plot(rpms, w, color=e["colour"], lw=1.5, label=e["label"])
    ax_w.set_xlabel("Engine RPM")
    ax_w.set_ylabel("Time-share weight (autocross histogram)")
    ax_w.set_title("Per-engine autocross RPM weighting\n"
                   "(gaussian centered at 60% of WOT band, σ=15%)",
                   fontsize=10)
    ax_w.grid(True, alpha=0.3)
    ax_w.legend(loc="upper right", fontsize=7)

    # CO2/kWh bar chart
    sorted_engines = sorted(engines_out.values(), key=lambda e: e["co2"])
    bars = ax_bar.barh(range(len(sorted_engines)),
                       [e["co2"] for e in sorted_engines],
                       color=[e["colour"] for e in sorted_engines])
    ax_bar.set_yticks(range(len(sorted_engines)))
    ax_bar.set_yticklabels([e["label"] for e in sorted_engines], fontsize=8)
    ax_bar.invert_yaxis()
    ax_bar.set_xlabel("Autocross-weighted CO₂ [g/kWh] at engine's best AFR")
    ax_bar.set_title("v2 FSAE efficiency ranking  (lower = better)", fontsize=11)
    ax_bar.grid(True, axis="x", alpha=0.3)
    for i, e in enumerate(sorted_engines):
        ax_bar.text(e["co2"] + 5, i, f"{e['co2']:.0f}  (AFR {e['best_afr']})",
                    va="center", fontsize=9)

    # Table
    headers = ["Engine", "Best AFR", "Peak HP (kW)", "Avg BSFC", "CO₂/kWh"]
    rows = []
    for e in sorted_engines:
        rows.append([e["label"], f"{e['best_afr']}",
                     f"{e['peak_hp_kw']:.1f}",
                     f"{e['avg_bsfc']:.0f}",
                     f"{e['co2']:.0f}"])
    tab = ax_tab.table(cellText=rows, colLabels=headers,
                       cellLoc="center", loc="center",
                       colWidths=[0.45, 0.12, 0.15, 0.13, 0.13])
    tab.auto_set_font_size(False)
    tab.set_fontsize(9)
    tab.scale(1, 1.7)
    for i in range(len(headers)):
        c = tab[(0, i)]; c.set_facecolor("#16171B"); c.set_text_props(color="#FFC627", weight="bold")
    for r in range(1, len(rows) + 1):
        bg = "#FAFAFA" if r % 2 else "#EEEEEE"
        for ci in range(len(headers)):
            tab[(r, ci)].set_facecolor(bg)
            if ci == 0:
                for e in engines_out.values():
                    if e["label"] == rows[r-1][0]:
                        tab[(r, ci)].set_text_props(color=e["colour"], weight="bold")
                        break

    fig.suptitle("v2 multi-engine efficiency — per-engine FMEP + cam optimization + "
                 "autocross RPM weighting + per-engine AFR optimization",
                 fontsize=11, weight="bold")
    fig.tight_layout()
    out = HERE / "fig_efficiency_v2.png"
    fig.savefig(out, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"Wrote {out}")

    csv = HERE / "efficiency_v2.csv"
    with open(csv, "w") as f:
        f.write("engine,n_cyl,best_afr,peak_hp_kw,avg_bsfc,co2_per_kwh\n")
        for e in sorted_engines:
            f.write(f"{e['label']},{e['n_cyl']},{e['best_afr']},"
                    f"{e['peak_hp_kw']:.2f},{e['avg_bsfc']:.2f},{e['co2']:.2f}\n")
    print(f"Wrote {csv}")
    print()
    print("v2 ranking:")
    for e in sorted_engines:
        print(f"  {e['label']:42s}  AFR={e['best_afr']:4.1f}  "
              f"CO2={e['co2']:.0f}  peakHP={e['peak_hp_kw']:.1f} kW")


if __name__ == "__main__":
    main()
