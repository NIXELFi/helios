"""
Re-rank engines by efficiency using each engine's BEST AFR for fuel
economy (instead of forcing AFR=13.1 on all of them).

For each engine, sweeps AFR ∈ {12.5, 13.1, 13.5, 14.0, 14.7, 15.5, 16.5}
at the best-AUC-Tq geometry, with afr_eta_enabled=1 (lean misfire
penalty). For each AFR we compute the avg BSFC across the WOT band;
the engine's "efficiency score" is its minimum CO2/kWh across the
AFR sweep — i.e. assuming the team tunes for efficiency.
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

KW_TO_HP = 1.34102
CO2_PER_KG_FUEL = 3.18
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

AFRS = [12.5, 13.1, 13.5, 14.0, 14.7, 15.5, 16.5]


def load_run(path: Path):
    rows = []
    with open(path) as f:
        for line in f:
            d = json.loads(line)
            if d.get("kind") == "trial":
                rows.append(d)
    if not rows:
        return None
    rows.sort(key=lambda r: r["rpm"])
    rpms = np.array([r["rpm"] for r in rows])
    bp_kw = np.array([r["brake_power_kW"] for r in rows])
    intake_g_per_cycle = np.array([r["intake_mass_per_cycle_g"] for r in rows])
    afr = rows[0]["overrides"]["afr_target"]
    return {"rpms": rpms, "bp_kw": bp_kw, "intake_g": intake_g_per_cycle, "afr": afr}


def compute_metrics(run, n_cyl):
    """For one (engine, AFR) run, compute average BSFC over the WOT band."""
    rpms = run["rpms"]
    bp_kw = run["bp_kw"]
    intake_g = run["intake_g"]
    afr = run["afr"]
    fuel_g_per_cycle = intake_g / afr
    fuel_g_per_sec = fuel_g_per_cycle * (rpms / 120.0)
    # Power-weighted average BSFC: ∑ fuel × dt / ∑ power × dt — with dt = 1
    # (uniform time at each RPM point):
    if bp_kw.sum() < 1e-6:
        return float("nan"), float("nan"), float("nan")
    bsfc_band = (fuel_g_per_sec * H_TO_S).sum() / bp_kw.sum()
    # Peak BP (might be different RPM for each AFR run)
    peak_idx = int(np.argmax(bp_kw))
    peak_bp = float(bp_kw[peak_idx])
    bsfc_at_peak = float(fuel_g_per_sec[peak_idx] * H_TO_S / max(bp_kw[peak_idx], 1e-6))
    return bsfc_band, bsfc_at_peak, peak_bp


def main():
    engines = {}
    for stem, (label, colour, n_cyl) in ENGINE_META.items():
        best_bsfc = float("inf")
        best_afr = None
        best_peak_bp = None
        all_afr_data = []
        for afr in AFRS:
            path = HERE / "afr_results" / f"{stem}__afr{afr}.ndjson"
            if not path.exists():
                continue
            run = load_run(path)
            if not run:
                continue
            bsfc, bsfc_peak, peak_bp = compute_metrics(run, n_cyl)
            all_afr_data.append((afr, bsfc, bsfc_peak, peak_bp))
            if bsfc < best_bsfc:
                best_bsfc = bsfc
                best_afr = afr
                best_peak_bp = peak_bp
        engines[stem] = {
            "label": label, "colour": colour, "n_cyl": n_cyl,
            "afr_data": all_afr_data,
            "best_afr": best_afr,
            "best_bsfc": best_bsfc,
            "best_co2": best_bsfc * CO2_PER_KG_FUEL,
            "peak_bp_kw": best_peak_bp,
        }

    # --- Plot ---
    fig, axes = plt.subplots(2, 2, figsize=(18, 12))
    ax_curves = axes[0][0]
    ax_min = axes[0][1]
    ax_bar = axes[1][0]
    ax_tab = axes[1][1]
    ax_tab.axis("off")

    # Top-left: BSFC vs AFR per engine (lines)
    for stem, e in engines.items():
        afrs_ = [d[0] for d in e["afr_data"]]
        bsfc_ = [d[1] for d in e["afr_data"]]
        ax_curves.plot(afrs_, bsfc_, "o-", color=e["colour"], lw=2, ms=6, label=e["label"])
        # Mark the minimum
        if e["best_afr"] is not None:
            ax_curves.plot(e["best_afr"], e["best_bsfc"], "*", color=e["colour"],
                           ms=18, mec="black", mew=1)
    ax_curves.set_xlabel("AFR target")
    ax_curves.set_ylabel("Avg BSFC over WOT band [g / kWh]")
    ax_curves.set_title("BSFC vs AFR — ★ = each engine's most-efficient AFR",
                        fontsize=11)
    ax_curves.grid(True, alpha=0.3)
    ax_curves.legend(loc="upper right", fontsize=8)
    ax_curves.set_xticks(AFRS)
    ax_curves.axvline(14.7, color="gray", ls="--", lw=0.8, alpha=0.5)
    ax_curves.text(14.7, ax_curves.get_ylim()[1], "  stoich", fontsize=9, color="gray", va="top")

    # Top-right: scatter — best AFR each engine wants
    afrs_won = [e["best_afr"] for e in engines.values() if e["best_afr"]]
    n_cyls   = [e["n_cyl"]   for e in engines.values() if e["best_afr"]]
    labels   = [e["label"]   for e in engines.values() if e["best_afr"]]
    cols     = [e["colour"]  for e in engines.values() if e["best_afr"]]
    for n, a, l, c in zip(n_cyls, afrs_won, labels, cols):
        ax_min.scatter(n, a, color=c, s=240, edgecolors="black")
        ax_min.text(n + 0.08, a, l, fontsize=8, va="center")
    ax_min.set_xlabel("Number of cylinders")
    ax_min.set_ylabel("Most-efficient AFR")
    ax_min.set_title("Each engine's lean limit (most-efficient AFR)", fontsize=11)
    ax_min.set_xticks([1, 2, 3, 4])
    ax_min.grid(True, alpha=0.3)
    ax_min.axhline(14.7, color="gray", ls="--", lw=0.8, alpha=0.5, label="stoich")
    ax_min.legend(loc="lower right", fontsize=8)

    # Bottom-left: re-ranked CO2/kWh bar chart
    sorted_engines = sorted(engines.values(), key=lambda e: e["best_co2"])
    names = [e["label"] for e in sorted_engines]
    co2s = [e["best_co2"] for e in sorted_engines]
    colours = [e["colour"] for e in sorted_engines]
    bars = ax_bar.barh(range(len(names)), co2s, color=colours)
    ax_bar.set_yticks(range(len(names)))
    ax_bar.set_yticklabels(names, fontsize=8)
    ax_bar.invert_yaxis()
    ax_bar.set_xlabel("Avg CO₂ [g / kWh] at each engine's most-efficient AFR")
    ax_bar.set_title("FSAE efficiency ranking — best-case (per-engine-AFR-optimized)", fontsize=11)
    ax_bar.grid(True, axis="x", alpha=0.3)
    for i, (b, v, e) in enumerate(zip(bars, co2s, sorted_engines)):
        ax_bar.text(v + 5, i, f"{v:.0f}  (AFR {e['best_afr']})", va="center", fontsize=9)

    # Bottom-right: table
    headers = ["Engine", "Best AFR", "Min CO₂/kWh", "Peak HP (kW)", "% better vs forced-AFR=13.1"]
    rows = []
    for e in sorted_engines:
        # Find AFR=13.1 BSFC for comparison
        bsfc_at_131 = next((d[1] for d in e["afr_data"] if abs(d[0] - 13.1) < 0.01), None)
        if bsfc_at_131:
            improve = 100 * (1 - e["best_bsfc"] / bsfc_at_131)
        else:
            improve = float("nan")
        rows.append([
            e["label"],
            f"{e['best_afr']}",
            f"{e['best_co2']:.0f}",
            f"{e['peak_bp_kw']:.1f}",
            f"{improve:+.1f}%" if not math.isnan(improve) else "—",
        ])
    tab = ax_tab.table(cellText=rows, colLabels=headers,
                       cellLoc="center", colLoc="center", loc="center",
                       colWidths=[0.42, 0.12, 0.15, 0.13, 0.18])
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
                for e in engines.values():
                    if e["label"] == rows[r-1][0]:
                        tab[(r, ci)].set_text_props(color=e["colour"], weight="bold")
                        break
            if ci == 4 and rows[r-1][ci].startswith("-"):  # improvement is negative-good in % sense
                tab[(r, ci)].set_text_props(color="#1B7E2A", weight="bold")

    fig.suptitle("Engine efficiency comparison with per-engine AFR optimization\n"
                 "(afr_eta_enabled=1 — lean misfire penalty active)",
                 fontsize=12, weight="bold")
    fig.tight_layout()
    out = HERE / "fig_efficiency_per_engine_afr.png"
    fig.savefig(out, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"Wrote {out}")

    csv = HERE / "efficiency_per_engine_afr.csv"
    with open(csv, "w") as f:
        f.write("engine,best_afr,best_bsfc_g_per_kwh,best_co2_g_per_kwh,peak_hp_kw\n")
        for e in sorted_engines:
            f.write(f"{e['label']},{e['best_afr']},{e['best_bsfc']:.1f},"
                    f"{e['best_co2']:.1f},{e['peak_bp_kw']:.2f}\n")
    print(f"Wrote {csv}")
    print()
    print("Per-engine AFR ranking (most efficient first):")
    for e in sorted_engines:
        print(f"  {e['label']:42s}  AFR {e['best_afr']:4.1f}  -> CO2 {e['best_co2']:.0f} g/kWh")


if __name__ == "__main__":
    main()
