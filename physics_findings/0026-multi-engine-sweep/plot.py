"""
Plot all 7 engines on one figure with HP, torque, and a summary table.
Power computed as wheel power (sim_brake × 0.85, Cameron handbook
drivetrain efficiency).
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
HERE = ROOT / "physics_findings/0026-multi-engine-sweep"
RESULTS = HERE / "results"

ETA_DRIVETRAIN = 0.85
KW_TO_HP = 1.34102

# Display-friendly names + colour ordering by class
ENGINE_META = {
    # name (file stem):                    short label                       colour       class
    "SDM26_baseline":                      ("SDM26 baseline  (599cc 4)",     "#000000",   "quad"),
    "SDM26_Honda_CRF450R_2020":            ("Honda CRF450R '20  (449cc 1)",  "#E63946",   "single"),
    "SDM26_KTM_690_Duke_2018":             ("KTM 690 Duke '18  (693cc 1)",   "#FFC627",   "single"),
    "SDM26_Yamaha_YZ450F_2024":            ("Yamaha YZ450F '24  (449cc 1)",  "#F4A261",   "single"),
    "SDM26_Triumph_Daytona_675R_2011":     ("Triumph Daytona 675R '11  (675cc 3)", "#9D4EDD", "triple"),
    "SDM26_Kawasaki_ZX-6R_636_2003-2004":  ("Kawasaki ZX-6R 636 '03-'04  (636cc 4)", "#06D6A0", "quad"),
    "SDM26_Suzuki_GSX-R600_2006":          ("Suzuki GSX-R600 '06  (599cc 4)", "#118AB2",   "quad"),
    "SDM26_Yamaha_YZF-R6_2009":            ("Yamaha YZF-R6 '09  (599cc 4)",   "#073B4C",   "quad"),
}


def load_ndjson(path: Path):
    rows = []
    with open(path) as f:
        for line in f:
            d = json.loads(line)
            if d.get("kind") == "trial":
                rows.append(d)
    rows.sort(key=lambda r: r["rpm"])
    return rows


def auc_trapz(xs, ys):
    """Trapezoidal AUC. xs/ys assumed sorted by xs."""
    a = 0.0
    for i in range(1, len(xs)):
        dx = xs[i] - xs[i-1]
        a += 0.5 * (ys[i] + ys[i-1]) * dx
    return a


def main():
    engines = []
    for stem, (label, colour, klass) in ENGINE_META.items():
        path = RESULTS / f"{stem}.ndjson"
        if not path.exists():
            print(f"missing: {path}")
            continue
        rows = load_ndjson(path)
        if not rows:
            print(f"empty: {path}")
            continue
        rpms = np.array([r["rpm"] for r in rows])
        bp_kw = np.array([r["brake_power_kW"] for r in rows])
        bt_nm = np.array([r["brake_torque_Nm"] for r in rows])
        wp_kw = bp_kw * ETA_DRIVETRAIN
        wp_hp = wp_kw * KW_TO_HP
        # Wheel torque = wheel_power / ω
        omega = 2 * math.pi * rpms / 60.0
        wt_nm = (wp_kw * 1000.0) / omega

        # Peak metrics
        peak_hp_idx = int(np.argmax(wp_hp))
        peak_tq_idx = int(np.argmax(wt_nm))
        engines.append({
            "stem": stem,
            "label": label,
            "colour": colour,
            "class": klass,
            "rpms": rpms,
            "wp_hp": wp_hp,
            "wt_nm": wt_nm,
            "wp_kw": wp_kw,
            "peak_hp": float(wp_hp[peak_hp_idx]),
            "peak_hp_rpm": int(rpms[peak_hp_idx]),
            "peak_tq": float(wt_nm[peak_tq_idx]),
            "peak_tq_rpm": int(rpms[peak_tq_idx]),
            # AUC computed on the wheel-HP curve (area under hp vs rpm)
            "auc_hp_rpm": auc_trapz(rpms, wp_hp),
        })

    if not engines:
        print("no engine data found")
        return

    # Best in each category
    best_hp = max(engines, key=lambda e: e["peak_hp"])
    best_tq = max(engines, key=lambda e: e["peak_tq"])
    best_auc = max(engines, key=lambda e: e["auc_hp_rpm"])

    # Tall figure so the table + footer can breathe.
    fig = plt.figure(figsize=(16, 13))
    gs = fig.add_gridspec(
        3, 2,
        height_ratios=[2.0, 1.0, 0.12],
        hspace=0.30, wspace=0.18,
    )
    ax_hp = fig.add_subplot(gs[0, 0])
    ax_tq = fig.add_subplot(gs[0, 1])
    ax_tab = fig.add_subplot(gs[1, :])
    ax_tab.axis("off")
    ax_foot = fig.add_subplot(gs[2, :])
    ax_foot.axis("off")

    for e in engines:
        # SDM26 baseline drawn as a thicker dashed reference line
        is_baseline = e["stem"] == "SDM26_baseline"
        style = "--" if is_baseline else "-"
        lw = 3.0 if is_baseline else 2.2
        ax_hp.plot(e["rpms"], e["wp_hp"], style, color=e["colour"], lw=lw, label=e["label"])
        ax_tq.plot(e["rpms"], e["wt_nm"], style, color=e["colour"], lw=lw, label=e["label"])
        # Mark peaks
        ax_hp.plot(e["peak_hp_rpm"], e["peak_hp"], "o", color=e["colour"], ms=8,
                   mec="white", mew=1.5)
        ax_tq.plot(e["peak_tq_rpm"], e["peak_tq"], "o", color=e["colour"], ms=8,
                   mec="white", mew=1.5)

    ax_hp.set_xlabel("Engine RPM")
    ax_hp.set_ylabel("Wheel HP  (= sim_brake_kW × 0.85 × 1.341)")
    ax_hp.set_title("Wheel HP vs RPM  (Option B production knob set, 20 mm restrictor)",
                    fontsize=11)
    ax_hp.grid(True, alpha=0.3)
    ax_hp.legend(loc="upper left", fontsize=8, framealpha=0.92)

    ax_tq.set_xlabel("Engine RPM")
    ax_tq.set_ylabel("Wheel torque [N·m]")
    ax_tq.set_title("Wheel torque vs RPM", fontsize=11)
    ax_tq.grid(True, alpha=0.3)
    ax_tq.legend(loc="upper right", fontsize=8, framealpha=0.92)

    # --- Summary table ---
    headers = ["Engine", "Peak HP", "@ RPM", "Peak Tq (N·m)", "@ RPM", "AUC (HP·RPM)"]
    rows = []
    # Sort table by peak HP descending
    for e in sorted(engines, key=lambda e: -e["peak_hp"]):
        marks = []
        if e is best_hp:  marks.append("🏆HP")
        if e is best_tq:  marks.append("🏆Tq")
        if e is best_auc: marks.append("🏆AUC")
        suffix = ("  " + " ".join(marks)) if marks else ""
        rows.append([
            e["label"] + suffix,
            f"{e['peak_hp']:.1f}",
            f"{e['peak_hp_rpm']}",
            f"{e['peak_tq']:.1f}",
            f"{e['peak_tq_rpm']}",
            f"{e['auc_hp_rpm']/1000:.1f}k",
        ])

    table = ax_tab.table(cellText=rows, colLabels=headers,
                        cellLoc="center", colLoc="center", loc="upper center",
                        colWidths=[0.36, 0.10, 0.10, 0.13, 0.10, 0.13])
    table.auto_set_font_size(False)
    table.set_fontsize(10)
    table.scale(1, 1.6)
    # Header style
    for i in range(len(headers)):
        c = table[(0, i)]
        c.set_facecolor("#16171B")
        c.set_text_props(color="#FFC627", weight="bold")
    # Row colour-coding (alternate)
    for r in range(1, len(rows) + 1):
        bg = "#FAFAFA" if r % 2 else "#EEEEEE"
        for ci in range(len(headers)):
            cell = table[(r, ci)]
            cell.set_facecolor(bg)
            # Highlight engine-name cell with the engine colour
            if ci == 0:
                engine_label_clean = rows[r-1][0].split("  🏆")[0].strip()
                for e in engines:
                    if e["label"] == engine_label_clean:
                        cell.set_text_props(color=e["colour"], weight="bold")
                        break

    # Footer note (its own axis so it can't be clipped by tight bbox).
    ax_foot.text(0.5, 0.5,
                 f"Best peak HP: {best_hp['label']}  ({best_hp['peak_hp']:.1f} hp)   |   "
                 f"Best peak Tq: {best_tq['label']}  ({best_tq['peak_tq']:.1f} N·m)   |   "
                 f"Best AUC: {best_auc['label']}  ({best_auc['auc_hp_rpm']/1000:.1f}k hp·RPM)",
                 ha="center", va="center", transform=ax_foot.transAxes,
                 fontsize=10, color="#073B4C", weight="bold")

    fig.suptitle("Multi-engine sweep — 7 FSAE-restricted (20 mm) configs, Helios v3.4.4 Option B",
                 fontsize=13, weight="bold")
    out = HERE / "fig_multi_engine_comparison.png"
    fig.savefig(out, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"Wrote {out}")

    # Also write a CSV summary
    csv_path = HERE / "summary.csv"
    with open(csv_path, "w") as f:
        f.write("engine,peak_hp,peak_hp_rpm,peak_tq_nm,peak_tq_rpm,auc_hp_rpm\n")
        for e in sorted(engines, key=lambda e: -e["peak_hp"]):
            f.write(f"{e['label']},{e['peak_hp']:.2f},{e['peak_hp_rpm']},"
                    f"{e['peak_tq']:.2f},{e['peak_tq_rpm']},{e['auc_hp_rpm']:.2f}\n")
    print(f"Wrote {csv_path}")


if __name__ == "__main__":
    main()
