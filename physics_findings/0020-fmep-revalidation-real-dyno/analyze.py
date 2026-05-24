"""
Compare 7 FMEP variants against the real team dyno on both engines.
Goal: find a literature-defensible FMEP set that fits both engines well.
"""
from __future__ import annotations
import csv, json, math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
DYNO = {
    "sdm26": ROOT / "physics_findings/references/dyno/sdm26-team-dyno.csv",
    "sdm25": ROOT / "physics_findings/references/dyno/sdm25-team-dyno.csv",
}
ETA = 0.85

VARIANTS = [
    # (label, fmep_a, fmep_b, fmep_c, description)
    ("current",     0.50, 0.100, 0.003,   "Sim defaults (ABOVE Heywood)"),
    ("heywood_mid", 0.40, 0.045, 0.00075, "Heywood Tab 13.3 motorcycle midpoint"),
    ("heywood_hi",  0.50, 0.050, 0.001,   "Heywood motorcycle ceiling"),
    ("heywood_lo",  0.30, 0.040, 0.0005,  "Heywood motorcycle floor"),
    ("midway",      0.45, 0.070, 0.002,   "Halfway current→Heywood mid"),
    ("only_c_lit",  0.50, 0.100, 0.001,   "Only fmep_c → Heywood ceiling"),
    ("only_b_lit",  0.50, 0.050, 0.003,   "Only fmep_b → Heywood ceiling"),
]


def load_ndjson(p):
    rows = {}
    for line in open(p):
        d = json.loads(line)
        if d.get("kind") == "trial":
            rows[int(d["rpm"])] = d
    return rows


def load_dyno(p):
    out = {}
    for r in csv.DictReader(open(p)):
        if r["brake_power_kW"]:
            out[int(float(r["rpm"]))] = float(r["brake_power_kW"])
    return out


def stats(errs):
    if not errs:
        return None
    n = len(errs)
    rmse = math.sqrt(sum(e * e for e in errs) / n)
    bias = sum(errs) / n
    return rmse, bias, n


def metric(sim, dyno, lo, hi):
    errs = [(sim[r]["brake_power_kW"] * ETA - dyno[r])
            for r in sorted(set(sim) & set(dyno)) if lo <= r <= hi]
    return stats(errs)


def fmep_at(fa, fb, fc, rpm, stroke=0.0425):
    sp = 2 * stroke * rpm / 60
    return fa + fb * sp + fc * sp * sp


def print_fmep_curve():
    print("FMEP[bar] at representative RPM for each variant (stroke=0.0425 m):")
    print(f"  {'variant':<14} {'4k':>6} {'6k':>6} {'8k':>6} {'10k':>6} {'12k':>6} {'13.5k':>6}")
    for label, fa, fb, fc, _ in VARIANTS:
        vals = [f"{fmep_at(fa, fb, fc, r):6.2f}" for r in [4000, 6000, 8000, 10000, 12000, 13500]]
        print(f"  {label:<14} {' '.join(vals)}")
    print()


def evaluate():
    bands = [
        ("4-13k all",     4000, 13000),
        ("6-13k WOT",     6000, 13000),
        ("7-11.5k peak",  7000, 11500),
        ("4-7k low",      4000, 7000),
        ("10.5-13k high", 10500, 13000),
    ]
    print(f"\n{'='*98}")
    print(f"{'Engine':>6}  {'Band':<14}  " + "  ".join(f"{l:>14}" for l, *_ in VARIANTS))
    print(f"{'-'*98}")
    for eng in ["sdm25", "sdm26"]:
        dyno = load_dyno(DYNO[eng])
        for band, lo, hi in bands:
            rmse_row = [f"{eng:>6}  {band:<14}"]
            bias_row = [f"{'':>6}  {'':<14}"]
            for label, *_ in VARIANTS:
                sim = load_ndjson(HERE / f"results_{label}_{eng}.ndjson")
                m = metric(sim, dyno, lo, hi)
                if m:
                    rmse_row.append(f"  R={m[0]:5.2f} b={m[1]:+5.2f}")
                else:
                    rmse_row.append("       -")
            print("  ".join(rmse_row))
        print()


def best_overall():
    """Score: sum of squared bias across both engines, on the high-confidence WOT band."""
    print("Combined-engine score on the high-confidence WOT band (7-11.5k):")
    print("(lower is better; bias² summed across both engines)")
    print(f"  {'variant':<14}  {'SDM26 RMSE':>11} {'SDM26 bias':>11}  {'SDM25 RMSE':>11} {'SDM25 bias':>11}  {'combined score':>16}")
    for label, fa, fb, fc, desc in VARIANTS:
        scores = []
        for eng in ["sdm26", "sdm25"]:
            sim = load_ndjson(HERE / f"results_{label}_{eng}.ndjson")
            dyno = load_dyno(DYNO[eng])
            m = metric(sim, dyno, 7000, 11500)
            scores.append(m)
        if all(scores):
            combined = scores[0][1] ** 2 + scores[1][1] ** 2  # bias² sum
            print(f"  {label:<14}  "
                  f"     {scores[0][0]:5.2f}      {scores[0][1]:+5.2f}  "
                  f"     {scores[1][0]:5.2f}      {scores[1][1]:+5.2f}        {combined:7.2f}")
    print()


def best_per_band_all():
    """For each band+engine, mark the best (lowest RMSE) variant."""
    print("RMSE-leader per band (best variant per engine × band):")
    bands = [("All 4-13k", 4000, 13000),
             ("WOT 6-13k", 6000, 13000),
             ("Peak 7-11.5k", 7000, 11500),
             ("Low 4-7k", 4000, 7000),
             ("High 10.5-13k", 10500, 13000)]
    for eng in ["sdm26", "sdm25"]:
        print(f"\n  {eng.upper()}:")
        for band, lo, hi in bands:
            dyno = load_dyno(DYNO[eng])
            best = None
            for label, *_ in VARIANTS:
                sim = load_ndjson(HERE / f"results_{label}_{eng}.ndjson")
                m = metric(sim, dyno, lo, hi)
                if m and (best is None or m[0] < best[1]):
                    best = (label, m[0], m[1])
            if best:
                print(f"    {band:<14}  best={best[0]:<14}  RMSE={best[1]:5.2f}  bias={best[2]:+5.2f}")


if __name__ == "__main__":
    print_fmep_curve()
    evaluate()
    best_overall()
    best_per_band_all()
