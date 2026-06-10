"""
Finding 0029: exhaust wall-temperature + Woschni joint calibration on top of
the 0028 shipped calibration (base = the actual app configs, no other
overrides). Targets from the 0028 shape review:
  (1) SDM26 10.5-12k over-prediction (+3-4 kW local sag the model misses)
  (2) SDM26 6-8k torque-hump phasing (wave timing)
  (3) SDM25 peak-torque (10.5-11k) under-prediction (~3-4 Nm)

Exhaust pipe wall temperature sets exhaust gas temperature -> sound speed ->
header tuning RPM (the app configs carry 650 K primaries / 500 K collector,
cold for a header at WOT: real outer-wall temps run 800-1000 K). Woschni
scales in-cylinder heat loss. Every round MUST be reviewed as a graph
(plot_overlay.py), not just RMSE — shape regressions are a fail.
"""
from __future__ import annotations
import subprocess, sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
BENCH = ROOT / "target/release/helios-bench.exe"

RPMS = ", ".join(f"{r}.0" for r in range(4500, 14000, 500))

VARIANTS: dict[str, dict[str, float]] = {
    "base": {},  # app config as shipped (0028 calibration)
    # exhaust thermal state (gas temp -> wave speed -> tuning rpm)
    "ewt850": {"primary_wall_t": 850.0, "secondary_wall_t": 750.0,
               "collector_wall_t": 650.0},
    "ewt1000": {"primary_wall_t": 1000.0, "secondary_wall_t": 880.0,
                "collector_wall_t": 760.0},
    # in-cylinder heat loss
    "wosc1_32": {"woschni_c1_combustion": 3.2},
    "wosc2_50": {"woschni_c2_combustion": 0.005},
    "twall500": {"t_wall_cylinder": 500.0},
    # round 2: ECU-style closed-loop knock control (KI-driven spark retard).
    # Hypothesis from round 1: the SDM26 10.5-12k dyno sag is the real ECU
    # pulling timing where the model's KI crosses 1.0; SDM25 (KI < 1 there)
    # should be untouched — a shape feature, not a global offset.
    "kc": {"knock_control_enabled": 1.0},
    "kc_oct93": {"knock_control_enabled": 1.0, "octane_number": 93.0},
    "kc_lim09": {"knock_control_enabled": 1.0, "knock_integral_limit": 0.9},
}

# Round 3: KI field calibration. Anchor (Nick 2026-06-10): NO team build has
# ever knocked, so worst-case KI across both engine sweeps must be < 1.0.
# octane 98 = RON of the team's Sunoco 93-AKI pump fuel (Douaud-Eyzat wants
# RON); tau_scale rescales the CFR-calibrated pre-exponential.
for ts in (1.5, 2.0, 2.5):
    VARIANTS[f"ki_ts{int(ts*10)}"] = {
        "octane_number": 98.0, "knock_tau_scale": ts}

STUDY = """[run]
config = "apps/desktop/src-tauri/resources/cfd/configs/{engine}.json"
rpm = [{rpms}]
cycles = 30
recorded = true
seed = 8000
junction = "characteristic"

[environment]
target_triple = "x86_64-pc-windows-msvc"
rustc_version = "rustc"
rayon_threads = 1
libm_source = "system"

[sweep]
sampler = "lhs"
n_trials = 1
parameters = [
{params}
]
"""


def fmt_params(overrides: dict[str, float]) -> str:
    return "\n".join(
        f'  {{ name = "{k}", min = {v}, max = {v} }},'
        for k, v in overrides.items()
    )


def job(variant: str, engine: str) -> str:
    out = HERE / f"results_{variant}_{engine}.ndjson"
    if out.exists():
        return f"skip {variant}/{engine}"
    study = HERE / f"study_{variant}_{engine}.toml"
    study.write_text(STUDY.format(
        engine=engine, rpms=RPMS, params=fmt_params(VARIANTS[variant])))
    r = subprocess.run(
        [str(BENCH), "sweep", str(study), "--out", str(out)],
        cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0:
        out.unlink(missing_ok=True)
        return f"FAIL {variant}/{engine}: {r.stderr[-400:]}"
    return f"ok {variant}/{engine}"


def main() -> None:
    only = sys.argv[1:] or list(VARIANTS)
    jobs = [(v, e) for v in only for e in ("sdm26", "sdm25")]
    with ThreadPoolExecutor(max_workers=10) as pool:
        for msg in pool.map(lambda a: job(*a), jobs):
            print(msg, flush=True)


if __name__ == "__main__":
    main()
