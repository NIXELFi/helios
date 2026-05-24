"""
Analysis + plots for finding 0015 (low-Re intake Cd correction).

Compares baseline (production knob set) vs. T1.1 (production + Re correction)
on BOTH SDM25 and SDM26. Reports RMSE/bias vs FSAE-restricted dyno (wheel-power
framing), implied-eta diagnostic, and per-RPM gap closure.

The C10 calibration-over-fit guard: a real physics fix must move BOTH SDM25
and SDM26 toward the dyno envelope. Divergence between the two = overfit.
"""
from __future__ import annotations

import csv
import json
import math
import os
import sys
from pathlib import Path
from typing import Dict, List

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
DYNO_CSV = ROOT / "physics_findings/references/dyno/cbr600rr-fsae-restricted.csv"
HERE = Path(__file__).resolve().parent
BASELINE = ROOT / 'physics_findings/0015-low-rpm-port-loss'
ETA_DRIVETRAIN = 0.85  # from sdm26.json / sdm25.json (fixed Cameron-handbook value)


def load_ndjson(path: Path) -> Dict[int, dict]:
    rows = {}
    with path.open() as f:
        for line in f:
            d = json.loads(line)
            if d.get("kind") == "trial":
                rows[int(d["rpm"])] = d
    return rows


def load_dyno() -> Dict[int, float]:
    out = {}
    with DYNO_CSV.open() as f:
        for r in csv.DictReader(f):
            if r["brake_power_kW"]:
                out[int(float(r["rpm"]))] = float(r["brake_power_kW"])
    return out


def sim_wheel(row: dict) -> float:
    return row["brake_power_kW"] * ETA_DRIVETRAIN


def metrics(sim: Dict[int, dict], dyno: Dict[int, float]) -> dict:
    """Compute RMSE + bias vs dyno on intersecting RPMs."""
    errs = []
    rpms = sorted(set(sim.keys()) & set(dyno.keys()))
    for r in rpms:
        e = sim_wheel(sim[r]) - dyno[r]
        errs.append(e)
    if not errs:
        return {"rmse": float("nan"), "bias": float("nan"), "n": 0}
    rmse = math.sqrt(sum(e * e for e in errs) / len(errs))
    bias = sum(errs) / len(errs)
    return {"rmse": rmse, "bias": bias, "n": len(errs), "rpms": rpms, "errs": errs}


def metrics_band(sim, dyno, lo, hi) -> dict:
    """RMSE/bias on a sub-band of RPMs [lo, hi] inclusive."""
    errs = []
    for r in sorted(set(sim.keys()) & set(dyno.keys())):
        if lo <= r <= hi:
            errs.append(sim_wheel(sim[r]) - dyno[r])
    if not errs:
        return {"rmse": float("nan"), "bias": float("nan"), "n": 0}
    rmse = math.sqrt(sum(e * e for e in errs) / len(errs))
    bias = sum(errs) / len(errs)
    return {"rmse": rmse, "bias": bias, "n": len(errs)}


def implied_eta(sim, dyno) -> Dict[int, float]:
    out = {}
    for r in sorted(set(sim.keys()) & set(dyno.keys())):
        bp = sim[r]["brake_power_kW"]
        if bp > 1e-3:
            out[r] = dyno[r] / bp  # dyno is wheel; sim is brake; eta = wheel/brake
    return out


def report_one(name: str, path_baseline: Path, path_variant: Path | None = None) -> dict:
    dyno = load_dyno()
    base = load_ndjson(path_baseline)
    m_base = metrics(base, dyno)
    m_low = metrics_band(base, dyno, 4000, 7000)
    m_mid = metrics_band(base, dyno, 7500, 11000)
    m_hi = metrics_band(base, dyno, 11500, 13000)
    eta = implied_eta(base, dyno)

    print(f"\n=== {name} BASELINE ===")
    print(f"  RMSE all = {m_base['rmse']:.2f} kW   bias = {m_base['bias']:+.2f} kW   (n={m_base['n']})")
    print(f"  RMSE 4-7k  = {m_low['rmse']:.2f}   bias = {m_low['bias']:+.2f}   (n={m_low['n']})")
    print(f"  RMSE 7.5-11k = {m_mid['rmse']:.2f}   bias = {m_mid['bias']:+.2f}   (n={m_mid['n']})")
    print(f"  RMSE 11.5-13k = {m_hi['rmse']:.2f}   bias = {m_hi['bias']:+.2f}   (n={m_hi['n']})")
    print(f"  implied eta @ 6k = {eta.get(6000, float('nan')):.3f}   @ 10k = {eta.get(10000, float('nan')):.3f}   @ 13k = {eta.get(13000, float('nan')):.3f}")

    out = {"baseline": {"all": m_base, "low": m_low, "mid": m_mid, "hi": m_hi, "eta": eta, "sim": base}}

    if path_variant is not None and path_variant.exists():
        var = load_ndjson(path_variant)
        m_v_all = metrics(var, dyno)
        m_v_low = metrics_band(var, dyno, 4000, 7000)
        m_v_mid = metrics_band(var, dyno, 7500, 11000)
        m_v_hi = metrics_band(var, dyno, 11500, 13000)
        eta_v = implied_eta(var, dyno)
        print(f"\n=== {name} VARIANT ===")
        print(f"  RMSE all = {m_v_all['rmse']:.2f} kW   bias = {m_v_all['bias']:+.2f} kW")
        print(f"  RMSE 4-7k  = {m_v_low['rmse']:.2f}   bias = {m_v_low['bias']:+.2f}")
        print(f"  RMSE 7.5-11k = {m_v_mid['rmse']:.2f}   bias = {m_v_mid['bias']:+.2f}")
        print(f"  RMSE 11.5-13k = {m_v_hi['rmse']:.2f}   bias = {m_v_hi['bias']:+.2f}")
        print(f"  implied eta @ 6k = {eta_v.get(6000, float('nan')):.3f}   @ 10k = {eta_v.get(10000, float('nan')):.3f}   @ 13k = {eta_v.get(13000, float('nan')):.3f}")
        print(f"  Δ RMSE = {m_v_all['rmse'] - m_base['rmse']:+.2f}   Δ bias = {m_v_all['bias'] - m_base['bias']:+.2f}")
        out["variant"] = {"all": m_v_all, "low": m_v_low, "mid": m_v_mid, "hi": m_v_hi, "eta": eta_v, "sim": var}

    return out


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--baseline-sdm26", default=str(HERE / "results_baseline_sdm26.ndjson"))
    p.add_argument("--variant-sdm26",  default=None)
    p.add_argument("--baseline-sdm25", default=str(HERE / "results_baseline_sdm25.ndjson"))
    p.add_argument("--variant-sdm25",  default=None)
    args = p.parse_args()

    r26 = report_one("SDM26",
                     Path(args.baseline_sdm26),
                     Path(args.variant_sdm26) if args.variant_sdm26 else None)
    r25 = report_one("SDM25",
                     Path(args.baseline_sdm25),
                     Path(args.variant_sdm25) if args.variant_sdm25 else None)
