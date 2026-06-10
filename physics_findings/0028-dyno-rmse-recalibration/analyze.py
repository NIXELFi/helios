"""
Score every 0028 variant against the real team dynos (banded RMSE/bias
on wheel power, drivetrain eta 0.85 — same methodology as finding 0021)
plus a torque-shape band. C10 guard: a variant only wins if it improves
the combined band score on BOTH engines.
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
BANDS = [
    ("all_4_13k5", 4500, 13500),
    ("wot_6_13k5", 6000, 13500),
    ("peak_7_11k5", 7000, 11500),
    ("high_10k5_13k5", 10500, 13500),
]


def load_ndjson(p: Path) -> dict[int, dict]:
    rows = {}
    for line in open(p):
        d = json.loads(line)
        if d.get("kind") == "trial":
            rows[int(d["rpm"])] = d
    return rows


def load_dyno(p: Path) -> dict[int, float]:
    out = {}
    for r in csv.DictReader(open(p)):
        if r["brake_power_kW"]:
            out[int(float(r["rpm"]))] = float(r["brake_power_kW"])
    return out


def band_metrics(sim, dyno, lo, hi):
    errs = [sim[r]["brake_power_kW"] * ETA - dyno[r]
            for r in sorted(set(sim) & set(dyno)) if lo <= r <= hi]
    if not errs:
        return float("nan"), float("nan")
    rmse = math.sqrt(sum(e * e for e in errs) / len(errs))
    return rmse, sum(errs) / len(errs)


def main() -> None:
    variants = sorted(
        {p.stem.removeprefix("results_").removesuffix("_sdm26")
         for p in HERE.glob("results_*_sdm26.ndjson")})
    table = []
    for v in variants:
        row = {"variant": v}
        for eng in ("sdm26", "sdm25"):
            p = HERE / f"results_{v}_{eng}.ndjson"
            if not p.exists():
                continue
            sim, dyno = load_ndjson(p), load_dyno(DYNO[eng])
            for name, lo, hi in BANDS:
                rmse, bias = band_metrics(sim, dyno, lo, hi)
                row[f"{eng}_{name}_rmse"] = round(rmse, 3)
                row[f"{eng}_{name}_bias"] = round(bias, 3)
        # combined score: mean of WOT-band RMSE across both engines
        try:
            row["score"] = round(
                (row["sdm26_wot_6_13k5_rmse"] + row["sdm25_wot_6_13k5_rmse"]) / 2, 3)
        except KeyError:
            row["score"] = float("nan")
        table.append(row)

    table.sort(key=lambda r: r["score"])
    cols = ["variant", "score"] + [
        f"{e}_{b}_{m}" for e in ("sdm26", "sdm25")
        for b, *_ in BANDS for m in ("rmse", "bias")]
    with open(HERE / "summary.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(table)

    print(f"{'variant':<10} {'score':>6}  "
          f"{'26 WOT rmse/bias':>17} {'26 peak':>13} {'26 high':>13}  "
          f"{'25 WOT rmse/bias':>17} {'25 peak':>13} {'25 high':>13}")
    for r in table:
        def cell(e, b):
            return (f"{r.get(f'{e}_{b}_rmse', float('nan')):6.2f}/"
                    f"{r.get(f'{e}_{b}_bias', float('nan')):+6.2f}")
        print(f"{r['variant']:<10} {r['score']:>6}  "
              f"{cell('sdm26','wot_6_13k5'):>17} {cell('sdm26','peak_7_11k5'):>13} "
              f"{cell('sdm26','high_10k5_13k5'):>13}  "
              f"{cell('sdm25','wot_6_13k5'):>17} {cell('sdm25','peak_7_11k5'):>13} "
              f"{cell('sdm25','high_10k5_13k5'):>13}")


if __name__ == "__main__":
    main()
