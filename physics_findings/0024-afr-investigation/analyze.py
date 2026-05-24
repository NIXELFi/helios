"""AFR sensitivity analysis on real team dyno."""
from __future__ import annotations
import csv, json, math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
ETA = 0.85
D26 = ROOT / "physics_findings/references/dyno/sdm26-team-dyno.csv"
D25 = ROOT / "physics_findings/references/dyno/sdm25-team-dyno.csv"
AFRS = ["12.0", "12.5", "13.0", "13.1", "13.5"]


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


for label, lo, hi in [("WOT 6-13k", 6000, 13000),
                      ("Peak 7-11.5k", 7000, 11500),
                      ("High 10.5-13k", 10500, 13000),
                      ("Low 4-7k", 4000, 7000)]:
    print(f"\n=== {label} ===")
    print(f"  {'AFR':>5}  "
          f"{'SDM26 RMSE':>11} {'SDM26 bias':>11}  "
          f"{'SDM25 RMSE':>11} {'SDM25 bias':>11}  {'sum bias²':>10}")
    for afr in AFRS:
        s26 = stat(HERE / f"results_afr_{afr.replace('.','_')}_sdm26.ndjson", D26, lo, hi)
        s25 = stat(HERE / f"results_afr_{afr.replace('.','_')}_sdm25.ndjson", D25, lo, hi)
        if s26 and s25:
            score = s26[1] ** 2 + s25[1] ** 2
            mark = "  ← CURRENT" if afr == "13.1" else ""
            print(f"  {afr:>5}  {s26[0]:11.2f} {s26[1]:+11.2f}  "
                  f"{s25[0]:11.2f} {s25[1]:+11.2f}  {score:10.2f}{mark}")
