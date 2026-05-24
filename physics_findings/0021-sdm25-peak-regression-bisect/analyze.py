"""
Bisect the production knob set to find which fix introduced (or
worsened) the SDM25 peak under-prediction. Compare each "minus-one-knob"
variant against full production on the high-confidence WOT band.
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
VARIANTS = ["all_off", "prod", "no_borda", "no_restrictor_geom",
            "no_mach_cd", "no_mbt_map", "no_wiebe_rpm"]


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


def metric(sim, dyno, lo, hi):
    errs = [(sim[r]["brake_power_kW"] * ETA - dyno[r])
            for r in sorted(set(sim) & set(dyno)) if lo <= r <= hi]
    if not errs:
        return None
    n = len(errs)
    return math.sqrt(sum(e * e for e in errs) / n), sum(errs) / n


def main():
    bands = [
        ("All 4-13k",      4000, 13000),
        ("WOT 6-13k",      6000, 13000),
        ("Peak 7-11.5k",   7000, 11500),
        ("High 10.5-13k", 10500, 13000),
    ]
    for eng in ["sdm25", "sdm26"]:
        dyno = load_dyno(DYNO[eng])
        print(f"=== {eng.upper()} ===")
        print(f"  {'variant':<22}  " + "  ".join(f"{b:^16}" for b, *_ in bands))
        for v in VARIANTS:
            sim = load_ndjson(HERE / f"results_{v}_{eng}.ndjson")
            cells = []
            for _, lo, hi in bands:
                m = metric(sim, dyno, lo, hi)
                cells.append(f"R={m[0]:5.2f} b={m[1]:+5.2f}" if m else "       -        ")
            mark = ""
            if v == "prod":
                mark = "  ← current production"
            if v == "all_off":
                mark = "  ← legacy (no production knobs)"
            print(f"  {v:<22}  " + "  ".join(cells) + mark)
        print()

    print()
    print("Δ(no_<knob> minus full-production) — positive Δbias means that knob LOWERS sim BP "
          "(removing it raises sim BP). On SDM25 we expect to find the knob whose removal "
          "raises sim BP toward the dyno peak.")
    print()
    for eng in ["sdm25", "sdm26"]:
        dyno = load_dyno(DYNO[eng])
        prod_sim = load_ndjson(HERE / f"results_prod_{eng}.ndjson")
        m_prod = metric(prod_sim, dyno, 7000, 11500)
        print(f"=== {eng.upper()} — peak 7-11.5k band ===  prod baseline: RMSE={m_prod[0]:.2f}  bias={m_prod[1]:+.2f}")
        for v in VARIANTS:
            if v == "prod" or v == "all_off":
                continue
            sim = load_ndjson(HERE / f"results_{v}_{eng}.ndjson")
            m = metric(sim, dyno, 7000, 11500)
            d_rmse = m[0] - m_prod[0]
            d_bias = m[1] - m_prod[1]
            print(f"  removing {v[3:]:<18}  Δbias={d_bias:+5.2f}  Δrmse={d_rmse:+5.2f}  ({m[0]:.2f}/{m[1]:+.2f})")
        print()


if __name__ == "__main__":
    main()
