"""
Add FSAE-style efficiency (CO2/kWh, BSFC, fuel-per-lap proxy) to the
multi-engine optimization comparison.

Each engine's "best AUC torque" trial (the user's chosen objective) gets:
  - BSFC vs RPM curve (g fuel per kWh produced)
  - CO2 emission rate vs RPM (g CO2 per kWh produced) = BSFC × 3.18
  - Avg BSFC over WOT operating band (RPM > 6000 for quads/triple, > 4000 for singles)
  - Peak-power BSFC (the operating point when the car is on a straight)
  - "CO2 per FSAE lap proxy" — assumes a uniform autocross-time distribution
    across the operating band, weighted by power (since faster sections at
    higher RPM dominate distance covered and thus fuel)

Lower CO2/kWh = more efficient = more FSAE points.
"""
from __future__ import annotations
import json
import math
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

ROOT = Path("/Users/nmurray/Developer/helios")
HERE = ROOT / "physics_findings/0027-multi-engine-optimization"

ETA_DRIVETRAIN = 0.85
KW_TO_HP = 1.34102
AFR_TARGET = 13.1                   # Option B production setting
CO2_PER_KG_FUEL = 3.18              # kg CO2 per kg gasoline (stoich combustion)
KG_TO_G = 1000.0
H_TO_S = 3600.0

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


def auc_trapz(xs, ys):
    return sum(0.5 * (ys[i] + ys[i-1]) * (xs[i] - xs[i-1]) for i in range(1, len(xs)))


def load_best_auc_tq(stem: str):
    """Find the best-AUC-torque trial for an engine; return its full curve."""
    path = HERE / "results" / f"{stem}.ndjson"
    if not path.exists():
        return None
    by_trial = {}
    with open(path) as f:
        for line in f:
            d = json.loads(line)
            if d.get("kind") != "trial":
                continue
            tid = d["trial_id"]
            if tid not in by_trial:
                by_trial[tid] = {"rpms": [], "bp_kw": [], "intake_g": [], "overrides": d.get("overrides", {})}
            by_trial[tid]["rpms"].append(d["rpm"])
            by_trial[tid]["bp_kw"].append(d["brake_power_kW"])
            by_trial[tid]["intake_g"].append(d["intake_mass_per_cycle_g"])

    best_tid = None
    best_auc = -1
    for tid, t in by_trial.items():
        rpms = np.array(t["rpms"])
        order = np.argsort(rpms)
        rpms = rpms[order]
        bp = np.array(t["bp_kw"])[order]
        wp = bp * ETA_DRIVETRAIN
        omega = 2 * math.pi * rpms / 60.0
        wt = (wp * 1000.0) / omega
        auc = auc_trapz(rpms, wt)
        if auc > best_auc:
            best_auc = auc
            best_tid = tid

    t = by_trial[best_tid]
    rpms = np.array(t["rpms"])
    order = np.argsort(rpms)
    return {
        "trial_id": best_tid,
        "rpms": rpms[order],
        "bp_kw": np.array(t["bp_kw"])[order],
        "intake_g_per_cycle": np.array(t["intake_g"])[order],
        "overrides": t["overrides"],
    }


def compute_efficiency(curve, n_cyl: int):
    """Per-RPM BSFC + CO2/kWh from intake_mass and brake_power."""
    rpms = curve["rpms"]
    bp_kw = curve["bp_kw"]
    intake_g_per_cycle = curve["intake_g_per_cycle"]
    # Fuel = air / AFR (stoich-target ratio). intake_mass is air for our model.
    fuel_g_per_cycle = intake_g_per_cycle / AFR_TARGET
    # 4-stroke: cycles/sec = RPM/120
    fuel_g_per_sec = fuel_g_per_cycle * (rpms / 120.0)
    # BSFC = fuel rate / brake power, units g / kWh
    bsfc = np.where(bp_kw > 0.1, fuel_g_per_sec * H_TO_S / bp_kw, np.nan)
    co2_per_kwh = bsfc * CO2_PER_KG_FUEL  # g CO2 per kWh
    return {
        "rpms": rpms,
        "bp_kw": bp_kw,
        "fuel_g_per_sec": fuel_g_per_sec,
        "bsfc_g_per_kwh": bsfc,
        "co2_g_per_kwh": co2_per_kwh,
    }


def power_weighted_avg_bsfc(eff, rpm_lo: int):
    """Power-weighted BSFC: ∫ fuel_rate / ∫ power. Represents 'fuel per
    work done', integrated over the operating band starting at rpm_lo.
    """
    mask = eff["rpms"] >= rpm_lo
    fuel_rate = eff["fuel_g_per_sec"][mask]
    power = eff["bp_kw"][mask]
    if power.sum() < 1e-6:
        return float("nan")
    # power-weighted ∫ fuel = total fuel, ∫ power × dt = total work; we
    # approximate dt = 1 at each RPM (uniform-time assumption — see
    # docstring of this script).
    return (fuel_rate * H_TO_S).sum() / power.sum()


def main():
    engines = {}
    for stem, (label, colour, n_cyl) in ENGINE_META.items():
        curve = load_best_auc_tq(stem)
        if not curve:
            print(f"missing: {stem}")
            continue
        eff = compute_efficiency(curve, n_cyl)
        # WOT operating band: above 6k for quads/triple, 4k for singles
        rpm_lo = 4000 if n_cyl == 1 else 6000
        bsfc_band_avg = power_weighted_avg_bsfc(eff, rpm_lo)
        # BSFC at peak HP
        peak_hp_idx = int(np.argmax(eff["bp_kw"]))
        bsfc_at_peak = float(eff["bsfc_g_per_kwh"][peak_hp_idx])
        # CO2 per kWh equivalents
        co2_band_avg = bsfc_band_avg * CO2_PER_KG_FUEL
        co2_at_peak = bsfc_at_peak * CO2_PER_KG_FUEL
        engines[stem] = {
            "label": label, "colour": colour, "n_cyl": n_cyl,
            "eff": eff,
            "rpm_lo": rpm_lo,
            "bsfc_band_avg": bsfc_band_avg,
            "bsfc_at_peak": bsfc_at_peak,
            "co2_band_avg": co2_band_avg,
            "co2_at_peak": co2_at_peak,
            "peak_hp_kw": float(eff["bp_kw"][peak_hp_idx] * ETA_DRIVETRAIN),
            "peak_hp_rpm": int(eff["rpms"][peak_hp_idx]),
        }

    # --- Plot ---
    fig, axes = plt.subplots(2, 2, figsize=(18, 11))
    ax_bsfc = axes[0][0]
    ax_co2  = axes[0][1]
    ax_bar_band = axes[1][0]
    ax_tab = axes[1][1]
    ax_tab.axis("off")

    for stem, e in engines.items():
        ax_bsfc.plot(e["eff"]["rpms"], e["eff"]["bsfc_g_per_kwh"],
                     "-", color=e["colour"], lw=2.0, label=e["label"])
        ax_co2.plot(e["eff"]["rpms"], e["eff"]["co2_g_per_kwh"],
                    "-", color=e["colour"], lw=2.0, label=e["label"])
    ax_bsfc.set_xlabel("Engine RPM")
    ax_bsfc.set_ylabel("BSFC [g fuel / kWh]")
    ax_bsfc.set_title("Brake-specific fuel consumption (best-AUC-Tq trial per engine)",
                      fontsize=11)
    ax_bsfc.grid(True, alpha=0.3)
    ax_bsfc.legend(loc="upper right", fontsize=8)
    ax_bsfc.set_ylim(150, 500)

    ax_co2.set_xlabel("Engine RPM")
    ax_co2.set_ylabel("CO₂ [g / kWh produced]")
    ax_co2.set_title("CO₂ emission rate per kWh (BSFC × 3.18)", fontsize=11)
    ax_co2.grid(True, alpha=0.3)
    ax_co2.legend(loc="upper right", fontsize=8)
    ax_co2.set_ylim(500, 1500)

    # Bar chart: average CO2/kWh over WOT band (lower = better)
    names = [e["label"] for e in engines.values()]
    co2_band = [e["co2_band_avg"] for e in engines.values()]
    colours = [e["colour"] for e in engines.values()]
    sort_idx = sorted(range(len(co2_band)), key=lambda i: co2_band[i])
    sorted_names = [names[i] for i in sort_idx]
    sorted_co2 = [co2_band[i] for i in sort_idx]
    sorted_colours = [colours[i] for i in sort_idx]
    bars = ax_bar_band.barh(range(len(sorted_names)), sorted_co2, color=sorted_colours)
    ax_bar_band.set_yticks(range(len(sorted_names)))
    ax_bar_band.set_yticklabels(sorted_names, fontsize=8)
    ax_bar_band.invert_yaxis()
    ax_bar_band.set_xlabel("Average CO₂ [g / kWh] over WOT operating band")
    ax_bar_band.set_title("FSAE efficiency proxy — lower CO₂/kWh = more efficient",
                          fontsize=11)
    ax_bar_band.grid(True, axis="x", alpha=0.3)
    # Annotate values
    for i, (bar, v) in enumerate(zip(bars, sorted_co2)):
        ax_bar_band.text(v + 5, i, f"{v:.0f}", va="center", fontsize=9)

    # Table
    headers = ["Engine", "Peak HP (kW)", "@ RPM", "BSFC @ peak", "BSFC avg (band)", "CO₂/kWh avg"]
    rows = []
    # Sort by CO2/kWh asc (most efficient first)
    for stem in sorted(engines, key=lambda s: engines[s]["co2_band_avg"]):
        e = engines[stem]
        rows.append([
            e["label"],
            f"{e['peak_hp_kw']:.1f}",
            f"{e['peak_hp_rpm']}",
            f"{e['bsfc_at_peak']:.0f}",
            f"{e['bsfc_band_avg']:.0f}",
            f"{e['co2_band_avg']:.0f}",
        ])
    tab = ax_tab.table(cellText=rows, colLabels=headers,
                       cellLoc="center", colLoc="center", loc="center",
                       colWidths=[0.42, 0.12, 0.09, 0.13, 0.14, 0.14])
    tab.auto_set_font_size(False)
    tab.set_fontsize(9)
    tab.scale(1, 1.7)
    for i in range(len(headers)):
        c = tab[(0, i)]
        c.set_facecolor("#16171B")
        c.set_text_props(color="#FFC627", weight="bold")
    for r in range(1, len(rows) + 1):
        bg = "#FAFAFA" if r % 2 else "#EEEEEE"
        for ci in range(len(headers)):
            tab[(r, ci)].set_facecolor(bg)
            if ci == 0:
                for stem, e in engines.items():
                    if e["label"] == rows[r-1][0]:
                        tab[(r, ci)].set_text_props(color=e["colour"], weight="bold")
                        break

    fig.suptitle("Multi-engine efficiency comparison (best-AUC-Tq optimized trial per engine)\n"
                 f"AFR = {AFR_TARGET}, CO₂ factor = {CO2_PER_KG_FUEL} kg/kg gasoline",
                 fontsize=12, weight="bold")
    fig.tight_layout()
    out = HERE / "fig_efficiency_comparison.png"
    fig.savefig(out, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"Wrote {out}")

    # CSV
    csv = HERE / "efficiency_summary.csv"
    with open(csv, "w") as f:
        f.write("engine,n_cyl,peak_hp_kw,peak_hp_rpm,bsfc_at_peak_g_per_kwh,bsfc_band_avg_g_per_kwh,co2_band_avg_g_per_kwh\n")
        for stem in sorted(engines, key=lambda s: engines[s]["co2_band_avg"]):
            e = engines[stem]
            f.write(f"{e['label']},{e['n_cyl']},{e['peak_hp_kw']:.2f},{e['peak_hp_rpm']},"
                    f"{e['bsfc_at_peak']:.1f},{e['bsfc_band_avg']:.1f},{e['co2_band_avg']:.1f}\n")
    print(f"Wrote {csv}")


if __name__ == "__main__":
    main()
