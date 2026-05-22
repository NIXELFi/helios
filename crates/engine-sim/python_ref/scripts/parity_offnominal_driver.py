"""Run the Python reference SDM26 at a single off-nominal scenario and
emit the final-cycle CycleStats as JSON on stdout.

Usage:
    python scripts/parity_offnominal_driver.py <scenario>

Or:
    python scripts/parity_offnominal_driver.py --json '{"cr":15.0, ...}'

Scenarios:
    baseline, cr_high, cr_low, runner_long, runner_short,
    restrictor_small, restrictor_large, ambient_hot, ambient_cold,
    afr_rich, afr_lean, spark_advance_high, spark_advance_low,
    wiebe_big, wiebe_tight

Each scenario runs at 8000 RPM, 5 cycles, junction_type='stagnation'.
Prints to stdout a single JSON object:
    {"scenario": ..., "rpm": 8000.0, "n_cycles": 5, "final": {<stats>}}
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

REF_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REF_ROOT))

# Suppress numba TBB / parallel runtime warnings on stderr (we want clean JSON
# on stdout only). Warnings still print to stderr; that's fine.
import warnings
warnings.filterwarnings("ignore")


SCENARIOS = {
    "baseline":            {},
    "cr_high":             {"CR": 15.0},
    "cr_low":              {"CR": 9.0},
    "runner_long":         {"runner_length": 0.40},
    "runner_short":        {"runner_length": 0.12},
    "restrictor_small":    {"restrictor_throat_diameter": 0.016},
    "restrictor_large":    {"restrictor_throat_diameter": 0.024},
    "ambient_hot":         {"T_ambient": 320.0},
    "ambient_cold":        {"T_ambient": 280.0},
    "afr_rich":            {"afr_target": 12.0},
    "afr_lean":            {"afr_target": 16.5},
    "spark_advance_high":  {"spark_advance": 35.0},
    "spark_advance_low":   {"spark_advance": 10.0},
    "wiebe_big":           {"combustion_duration": 70.0},
    "wiebe_tight":         {"combustion_duration": 25.0},
}


def run(scenario_name: str, overrides_json: str | None) -> dict:
    from models.sdm26 import SDM26Config, SDM26Engine

    if overrides_json is not None:
        overrides = json.loads(overrides_json)
    else:
        if scenario_name not in SCENARIOS:
            raise SystemExit(
                f"unknown scenario {scenario_name!r}; "
                f"valid: {sorted(SCENARIOS)}"
            )
        overrides = SCENARIOS[scenario_name]

    cfg = SDM26Config(**overrides)
    eng = SDM26Engine(cfg, junction_type="stagnation")
    t0 = time.time()
    result = eng.run_single_rpm(
        8000.0,
        n_cycles=5,
        stop_at_convergence=False,
        verbose=False,
    )
    wall = time.time() - t0

    cycles = result["cycle_stats"]
    if not cycles:
        raise SystemExit(f"{scenario_name}: no cycles completed!")
    final = cycles[-1]

    out = {
        "scenario": scenario_name,
        "overrides": overrides,
        "rpm": 8000.0,
        "n_cycles_run": result["n_cycles_run"],
        "step_count": result["step_count"],
        "wall_seconds": round(wall, 2),
        "final": dict(final),
        "all_cycles": [dict(c) for c in cycles],
    }
    return out


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("scenario", nargs="?", default="baseline")
    p.add_argument("--json", default=None,
                   help="JSON object of SDM26Config overrides")
    args = p.parse_args(argv)
    out = run(args.scenario, args.json)
    sys.stdout.write(json.dumps(out))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
