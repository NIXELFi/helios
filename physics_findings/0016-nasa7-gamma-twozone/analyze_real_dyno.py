"""
Re-analyze the work this session against the REAL team-specific dyno data
(SDM (1).CSV for SDM26, RunFile_11.csv for SDM25), both 20mm-restricted,
wheel power from a Dynojet chassis dyno.

This replaces the prior `analyze.py` which used an old multi-source-aggregate
that mis-represented low-RPM behavior for the SDM-team-specific engines.
"""
from __future__ import annotations
import csv, json, math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
DYNO_SDM26 = ROOT / "physics_findings/references/dyno/sdm26-team-dyno.csv"
DYNO_SDM25 = ROOT / "physics_findings/references/dyno/sdm25-team-dyno.csv"
ETA_DRIVETRAIN = 0.85


def load_ndjson(path):
    rows = {}
    with open(path) as f:
        for line in f:
            d = json.loads(line)
            if d.get("kind") == "trial":
                rows[int(d["rpm"])] = d
    return rows


def load_dyno(path):
    out = {}
    with open(path) as f:
        for r in csv.DictReader(f):
            if r["brake_power_kW"]:
                out[int(float(r["rpm"]))] = float(r["brake_power_kW"])
    return out


def sim_wheel_kw(row):
    return row["brake_power_kW"] * ETA_DRIVETRAIN


def report(name: str, sim_path: Path, dyno_path: Path, bands):
    sim = load_ndjson(sim_path)
    dyno = load_dyno(dyno_path)
    common = sorted(set(sim.keys()) & set(dyno.keys()))
    print(f"\n=== {name}  ({sim_path.name} vs {dyno_path.name}) ===")
    print(f"  rpms in common: {len(common)}  range {common[0]}..{common[-1]}")
    # All-RPM
    errs = [(sim_wheel_kw(sim[r]) - dyno[r]) for r in common]
    if errs:
        rmse = math.sqrt(sum(e*e for e in errs)/len(errs))
        bias = sum(errs)/len(errs)
        print(f"  ALL  RMSE={rmse:5.2f} kW   bias={bias:+5.2f} kW")
    for band_name, lo, hi in bands:
        e = [(sim_wheel_kw(sim[r]) - dyno[r]) for r in common if lo <= r <= hi]
        if e:
            rmse = math.sqrt(sum(x*x for x in e)/len(e))
            bias = sum(e)/len(e)
            print(f"  {band_name:>9s}  RMSE={rmse:5.2f}   bias={bias:+5.2f}   (n={len(e)})")
    # implied η at key RPMs
    print("  implied η = dyno_wheel / sim_brake:")
    for r in [6000, 8000, 9000, 10000, 11000, 12000, 13000]:
        if r in sim and r in dyno:
            eta = dyno[r] / sim[r]["brake_power_kW"]
            sw = sim_wheel_kw(sim[r])
            print(f"    {r}  dyno={dyno[r]:5.2f}  sim_wheel={sw:5.2f}  sim_brake={sim[r]['brake_power_kW']:5.2f}  η={eta:.3f}")


BANDS = [("4-7k", 4000, 7000), ("7.5-10k", 7500, 10000), ("10.5-13k", 10500, 13000)]


if __name__ == "__main__":
    here = Path(__file__).resolve().parent
    base15 = ROOT / "physics_findings/0015-low-rpm-port-loss"

    report("SDM26 — production knob set (baseline)",
           base15 / "results_baseline_sdm26.ndjson", DYNO_SDM26, BANDS)
    report("SDM25 — production knob set (baseline)",
           base15 / "results_baseline_sdm25.ndjson", DYNO_SDM25, BANDS)
    report("SDM26 — two-zone, legacy mass-avg γ",
           here / "results_twoZone_baseline_sdm26.ndjson", DYNO_SDM26, BANDS)
    report("SDM26 — two-zone + c_v-weighted γ (0016)",
           here / "results_twoZone_cvweighted_sdm26.ndjson", DYNO_SDM26, BANDS)
    report("SDM25 — two-zone, legacy mass-avg γ",
           here / "results_twoZone_baseline_sdm25.ndjson", DYNO_SDM25, BANDS)
    report("SDM25 — two-zone + c_v-weighted γ (0016)",
           here / "results_twoZone_cvweighted_sdm25.ndjson", DYNO_SDM25, BANDS)
