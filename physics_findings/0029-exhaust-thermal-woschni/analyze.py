"""Banded wheel-power RMSE/bias for 0029 variants vs the team dynos (same
methodology as 0028; sub-6.5k written off per references/dyno/README.md).
Adds a targeted SDM26 'sag' band (10.5-12k) and a torque-RMSE column since
this finding chases shape, not just power level."""
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
    ("wot", 6000, 13500),
    ("sag", 10500, 12000),
    ("high", 10500, 13500),
]


def load_sim(p: Path, field: str) -> dict[int, float]:
    rows = {}
    for line in open(p):
        d = json.loads(line)
        if d.get("kind") == "trial":
            rows[int(d["rpm"])] = d[field] * ETA
    return rows


def load_dyno(p: Path, col: str) -> dict[int, float]:
    out = {}
    for r in csv.DictReader(open(p)):
        if r[col]:
            out[int(float(r["rpm"]))] = float(r[col])
    return out


def band(sim, dyno, lo, hi):
    errs = [sim[r] - dyno[r] for r in sorted(set(sim) & set(dyno)) if lo <= r <= hi]
    if not errs:
        return float("nan"), float("nan")
    return math.sqrt(sum(e * e for e in errs) / len(errs)), sum(errs) / len(errs)


def main() -> None:
    variants = sorted(
        {p.stem.removeprefix("results_").removesuffix("_sdm26")
         for p in HERE.glob("results_*_sdm26.ndjson")})
    hdr = (f"{'variant':<10} "
           f"{'26 wot P':>13} {'26 sag P':>13} {'26 tq(wot)':>11}  "
           f"{'25 wot P':>13} {'25 high P':>13} {'25 tq(wot)':>11}")
    print(hdr)
    rows_out = []
    for v in variants:
        cells = {"variant": v}
        line = f"{v:<10} "
        for eng, shown in (("sdm26", ("wot", "sag")), ("sdm25", ("wot", "high"))):
            simP = load_sim(HERE / f"results_{v}_{eng}.ndjson", "brake_power_kW")
            simT = load_sim(HERE / f"results_{v}_{eng}.ndjson", "brake_torque_Nm")
            dynP = load_dyno(DYNO[eng], "brake_power_kW")
            dynT = load_dyno(DYNO[eng], "brake_torque_Nm")
            for b in shown:
                lo, hi = next((lo, hi) for n, lo, hi in BANDS if n == b)
                r, bias = band(simP, dynP, lo, hi)
                cells[f"{eng}_{b}_rmse"], cells[f"{eng}_{b}_bias"] = round(r, 3), round(bias, 3)
                line += f"{r:6.2f}/{bias:+6.2f} "
            rt, _ = band(simT, dynT, 6000, 13500)
            cells[f"{eng}_tq_rmse"] = round(rt, 3)
            line += f"{rt:10.2f}  "
        rows_out.append(cells)
        print(line)
    with open(HERE / "summary.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows_out[0].keys()))
        w.writeheader()
        w.writerows(rows_out)


if __name__ == "__main__":
    main()
