"""Parameter-sensitivity sweeps for the SDM26 model.

Each function sweeps one config parameter at a fixed RPM, runs the engine
to IMEP-convergence, and returns a list of dicts with the varied value
and the converged metrics. Cheap (~30 s for a 10-point sweep at one RPM
after Numba warmup).

Use these to answer design questions like "does my primary length matter"
or "does a collector taper improve VE" without editing the model code.
All sweeps respect SDM26Config.__post_init__ validation so a bad value
raises immediately instead of producing silent garbage.
"""

from __future__ import annotations

from dataclasses import replace
from typing import List, Sequence

from models.sdm26 import SDM26Config, SDM26Engine


def _run_one(cfg: SDM26Config, rpm: float, n_cycles_max: int = 25,
             tol_imep: float = 0.005, min_cycles: int = 8) -> dict:
    eng = SDM26Engine(cfg)
    r = eng.run_single_rpm(
        rpm, n_cycles=n_cycles_max, stop_at_convergence=True,
        convergence_tol_imep=tol_imep, convergence_min_cycles=min_cycles,
        verbose=False,
    )
    last = r["cycle_stats"][-1]
    return {
        "converged_cycle": r["converged_cycle"],
        "n_cycles_run": r["n_cycles_run"],
        "imep_bar": last["imep_bar"],
        "ve_atm": last["ve_atm"],
        "EGT_valve_K": last["EGT_mean"],
        "indicated_power_kW": last["indicated_power_kW"],
        "nonconservation_max": max(
            abs(s["nonconservation"]) for s in r["cycle_stats"]
        ),
    }


def sweep_parameter(
    base_cfg: SDM26Config,
    field_name: str,
    values: Sequence,
    rpm: float = 10500.0,
    verbose: bool = True,
    **kwargs,
) -> List[dict]:
    """Sweep a single SDM26Config field through `values` at one RPM.

    Args:
        base_cfg: reference config; all fields other than `field_name`
            are held at their base_cfg value.
        field_name: name of an SDM26Config field (e.g. "primary_length",
            "runner_diameter_out", "intake_valve_max_lift").
        values: sequence of values to substitute.
        rpm: operating point.
        **kwargs: forwarded to _run_one (n_cycles_max, tol_imep, …).

    Returns:
        List of dicts, one per value, each augmented with the varied
        field under "value".

    Validation: because each cfg is built via dataclasses.replace, any
    invalid value will raise at config-construction time via
    SDM26Config.__post_init__.
    """
    results = []
    for v in values:
        cfg = replace(base_cfg, **{field_name: v})
        row = _run_one(cfg, rpm, **kwargs)
        row["field"] = field_name
        row["value"] = v
        results.append(row)
        if verbose:
            print(
                f"  {field_name}={v}  →  IMEP={row['imep_bar']:5.2f}  "
                f"VE={row['ve_atm']*100:5.1f}%  EGT={row['EGT_valve_K']:5.0f}K  "
                f"P_ind={row['indicated_power_kW']:5.1f}kW  "
                f"conv@{row['converged_cycle']}  nc≤{row['nonconservation_max']:.1e}"
            )
    return results


def taper_primary(
    base_cfg: SDM26Config,
    d_out_values: Sequence[float],
    rpm: float = 10500.0,
    verbose: bool = True,
) -> List[dict]:
    """Sweep primary_diameter_out (straight → diverging cone) at one RPM."""
    return sweep_parameter(base_cfg, "primary_diameter_out", d_out_values, rpm, verbose)


def taper_collector(
    base_cfg: SDM26Config,
    d_out_values: Sequence[float],
    rpm: float = 10500.0,
    verbose: bool = True,
) -> List[dict]:
    """Sweep collector_diameter_out (e.g. for a diverging megaphone) at one RPM."""
    return sweep_parameter(base_cfg, "collector_diameter_out", d_out_values, rpm, verbose)


def primary_length(
    base_cfg: SDM26Config,
    L_values: Sequence[float],
    rpm: float = 10500.0,
    verbose: bool = True,
) -> List[dict]:
    """Sweep primary_length at one RPM — the classic tuned-length study."""
    return sweep_parameter(base_cfg, "primary_length", L_values, rpm, verbose)


def runner_length(
    base_cfg: SDM26Config,
    L_values: Sequence[float],
    rpm: float = 10500.0,
    verbose: bool = True,
) -> List[dict]:
    """Sweep runner_length at one RPM — intake tuning study."""
    return sweep_parameter(base_cfg, "runner_length", L_values, rpm, verbose)


if __name__ == "__main__":
    # Demo: primary-length sweep at 10500 RPM
    import time
    cfg = SDM26Config()
    lengths = [0.200, 0.250, 0.308, 0.350, 0.400]
    t0 = time.time()
    print(f"Primary-length sweep @ 10500 RPM, {len(lengths)} points:")
    primary_length(cfg, lengths, rpm=10500.0)
    print(f"  total wall: {time.time()-t0:.1f} s")
