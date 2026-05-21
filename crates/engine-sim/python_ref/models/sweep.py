"""Full RPM sweep driver for the SDM26 model.

Runs each point with IMEP-based convergence (V1-style 0.5 % cycle-to-cycle
tolerance, minimum 3 cycles), capped at 40 cycles per point per the Phase 3
plan. Returns and can persist a list of per-RPM results suitable for
feeding into the V2-vs-V1 comparison report.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import List

from models.sdm26 import SDM26Engine, SDM26Config


def run_sweep(
    rpm_list: List[float],
    n_cycles_max: int = 40,
    convergence_tol_imep: float = 0.005,
    convergence_min_cycles: int = 3,
    verbose: bool = True,
    out_path: str | None = None,
) -> list:
    cfg = SDM26Config()
    results = []
    t_all = time.time()
    for rpm in rpm_list:
        eng = SDM26Engine(cfg)
        t0 = time.time()
        result = eng.run_single_rpm(
            rpm, n_cycles=n_cycles_max,
            stop_at_convergence=True,
            convergence_tol_imep=convergence_tol_imep,
            convergence_min_cycles=convergence_min_cycles,
            verbose=False,
        )
        wall = time.time() - t0
        # Converged metrics: use the LAST cycle's stats
        last = result["cycle_stats"][-1]
        conv_cycle = result["converged_cycle"]
        summary = {
            "rpm": rpm,
            "converged_cycle": conv_cycle,
            "n_cycles_run": result["n_cycles_run"],
            "imep_bar": last["imep_bar"],
            "ve_atm": last["ve_atm"],
            "EGT_valve_K": last["EGT_mean"],
            "indicated_power_kW": last["indicated_power_kW"],
            "mass_drift_last": last["mass_drift"],
            "nonconservation_last": last["nonconservation"],
            "nonconservation_max": max(abs(s["nonconservation"]) for s in result["cycle_stats"]),
            "wall_time_s": wall,
            "step_count": result["step_count"],
        }
        results.append(summary)
        if verbose:
            tag = f"(converged @ cycle {conv_cycle})" if conv_cycle > 0 else "(did NOT converge)"
            print(
                f"{rpm:6.0f} RPM  cycles={result['n_cycles_run']:2d} {tag:30s}  "
                f"IMEP={last['imep_bar']:5.2f}  VE={last['ve_atm']*100:5.1f}%  "
                f"EGT={last['EGT_mean']:5.0f}K  "
                f"P_ind={last['indicated_power_kW']:5.1f}kW  "
                f"nc_max={summary['nonconservation_max']:.1e}  "
                f"wall={wall:5.1f}s"
            )
    t_total = time.time() - t_all
    if verbose:
        print(f"\n  Sweep total wall time: {t_total:.1f} s")
    if out_path:
        Path(out_path).write_text(json.dumps(results, indent=2, default=float))
    return results


if __name__ == "__main__":
    rpms = [6000.0 + 500.0 * i for i in range(16)]  # 6000..13500
    import sys
    out = sys.argv[1] if len(sys.argv) > 1 else None
    run_sweep(rpms, out_path=out)
