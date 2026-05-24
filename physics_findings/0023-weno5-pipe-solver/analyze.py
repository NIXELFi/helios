"""WENO5 vs MUSCL (Option B baseline) on real team dyno."""
from __future__ import annotations
import csv, json, math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
ETA = 0.85
D26 = ROOT / "physics_findings/references/dyno/sdm26-team-dyno.csv"
D25 = ROOT / "physics_findings/references/dyno/sdm25-team-dyno.csv"


def loadndj(p):
    rows = {}
    for line in open(p):
        d = json.loads(line)
        if d.get("kind") == "trial":
            rows[int(d["rpm"])] = d
    return rows


def loaddyn(p):
    out = {}
    for r in csv.DictReader(open(p)):
        if r["brake_power_kW"]:
            out[int(float(r["rpm"]))] = float(r["brake_power_kW"])
    return out


def stat(simp, dynp, lo, hi):
    sim = loadndj(simp)
    dyno = loaddyn(dynp)
    errs = [(sim[r]["brake_power_kW"] * ETA - dyno[r])
            for r in dyno if r in sim and lo <= r <= hi]
    if not errs:
        return None
    n = len(errs)
    return math.sqrt(sum(e * e for e in errs) / n), sum(errs) / n


bar = "=" * 108
print(bar)
print("WENO5 vs Option B (MUSCL) on REAL team dyno — both engines, multiple RPM bands")
print(bar)
for label, lo, hi in [("All 4-13k", 4000, 13000),
                      ("WOT 6-13k", 6000, 13000),
                      ("Peak 7-11.5k", 7000, 11500),
                      ("High 10.5-13k", 10500, 13000)]:
    print(f"\n=== {label} ===")
    print(f"  {'variant':<26} {'SDM26 RMSE':>11} {'SDM26 bias':>11}  "
          f"{'SDM25 RMSE':>11} {'SDM25 bias':>11}")
    for name, p26, p25 in [
        ("Option B (MUSCL)",  HERE / "results_optionB_sdm26.ndjson", HERE / "results_optionB_sdm25.ndjson"),
        ("Option B + WENO5",  HERE / "results_weno5_sdm26.ndjson",   HERE / "results_weno5_sdm25.ndjson"),
    ]:
        s26 = stat(p26, D26, lo, hi)
        s25 = stat(p25, D25, lo, hi)
        if s26 and s25:
            print(f"  {name:<26} {s26[0]:11.2f} {s26[1]:+11.2f}  "
                  f"{s25[0]:11.2f} {s25[1]:+11.2f}")
