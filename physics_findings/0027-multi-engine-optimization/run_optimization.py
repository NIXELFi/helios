"""
Per-engine LHS optimization of intake + exhaust peripherals. For each
of the 8 engines (7 patched + SDM26 baseline) runs 50 LHS trials
varying:
  - intake: runner_length, runner_diameter_in, plenum_volume, plenum_length
  - exhaust: primary_length, primary_diameter_in, collector_length,
             collector_diameter_in
  - (4-cyl only) secondary_length, secondary_diameter_in

Internals (bore/stroke/CR/valves/combustion), drivetrain, restrictor,
FMEP, numerics, and wall T's are FIXED at Option B production values.

Diameters use only `*_diameter_in`; the loader uses diameter_in for both
ends when diameter_out is null in the config (which it is for all our
configs). This guarantees primary/secondary diameters are constant
(no taper), per the user spec.

Runs 4 engines in parallel via subprocess; each helios-bench is single-
threaded (recorded=true requires it). ~30 min wallclock total.
"""
from __future__ import annotations
import json
import subprocess
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

ROOT = Path("/Users/nmurray/Developer/helios")
SWEEP_DIR = ROOT / "physics_findings/0026-multi-engine-sweep"
HERE = ROOT / "physics_findings/0027-multi-engine-optimization"
HERE.mkdir(parents=True, exist_ok=True)
(HERE / "studies").mkdir(exist_ok=True)
(HERE / "results").mkdir(exist_ok=True)
BENCH = ROOT / "target/release/helios-bench"

N_TRIALS = 50
SEED = 42
PARALLEL = 4

# Option B production knob set + the optimization variables
# Format: (path, min, max) — if min==max, it's a fixed override; otherwise LHS.
FIXED = [
    # Option B production knob set
    ("intake_junction_borda_carnot", 1.0, 1.0),
    ("intake_junction_loss_coef", 1.0, 1.0),
    ("restrictor_loss_from_diffuser_geometry", 1.0, 1.0),
    ("restrictor_cd_mach_k", 0.10, 0.10),
    ("spark_advance_rpm_slope_deg_per_krpm", 1.5, 1.5),
    ("duration_rpm_exp", 0.4, 0.4),
    ("fmep_c", 0.00075, 0.00075),
]

# Intake variables (all engines)
INTAKE_VARS = [
    ("runner_length",       0.10,   0.40),
    ("runner_diameter_in",  0.028,  0.045),
    ("plenum_volume",       0.0005, 0.005),
    ("plenum_length",       0.10,   0.40),
]

# Exhaust variables common to all engines (n_cyl ≥ 1)
EXHAUST_COMMON_VARS = [
    ("primary_length",        0.20,  0.80),
    ("primary_diameter_in",   0.025, 0.055),
    ("collector_length",      0.05,  0.40),
    ("collector_diameter_in", 0.030, 0.080),
]

# Exhaust variables only for 4-cyl (4-2-1 topology with secondaries)
EXHAUST_FOUR_TWO_ONE_VARS = [
    ("secondary_length",      0.15, 0.80),
    ("secondary_diameter_in", 0.030, 0.070),
]


def build_toml(engine: dict) -> str:
    rpms_str = ", ".join(f"{r}.0" for r in engine["rpms"])
    var_set = FIXED + INTAKE_VARS + EXHAUST_COMMON_VARS
    if engine["n_cyl"] == 4:
        var_set = var_set + EXHAUST_FOUR_TWO_ONE_VARS
    params_lines = [
        f'  {{ name = "{p}", min = {lo}, max = {hi} }},' for p, lo, hi in var_set
    ]
    params_block = "\n".join(params_lines)
    return f"""[run]
config = "{engine['config']}"
rpm = [{rpms_str}]
cycles = 30
recorded = true
seed = {SEED}
junction = "characteristic"

[environment]
target_triple = "aarch64-apple-darwin"
rustc_version = "rustc 1.95.0"
rayon_threads = 1
libm_source = "system"

[sweep]
sampler = "lhs"
n_trials = {N_TRIALS}
parameters = [
{params_block}
]
"""


def run_one(args):
    name, study_path, result_path = args
    t0 = time.time()
    proc = subprocess.run(
        [str(BENCH), "sweep", str(study_path), "--out", str(result_path)],
        capture_output=True, text=True,
    )
    dt = time.time() - t0
    if proc.returncode != 0:
        return (name, "ERROR", dt, proc.stderr[:300])
    with open(result_path) as f:
        n_trials = sum(1 for line in f if '"kind":"trial"' in line)
    return (name, "OK", dt, f"{n_trials} trial-RPM rows")


def main():
    engines = json.loads((SWEEP_DIR / "configs/summary.json").read_text())
    jobs = []
    for eng in engines:
        toml = build_toml(eng)
        study_path = HERE / "studies" / f"{eng['name']}.toml"
        result_path = HERE / "results" / f"{eng['name']}.ndjson"
        study_path.write_text(toml)
        if result_path.exists() and result_path.stat().st_size > 10000:
            print(f"  SKIP {eng['name']} (result exists)")
            continue
        n_var = len(INTAKE_VARS) + len(EXHAUST_COMMON_VARS) + (
            len(EXHAUST_FOUR_TWO_ONE_VARS) if eng["n_cyl"] == 4 else 0
        )
        print(f"  QUEUE {eng['name']}: {n_var} vars × {N_TRIALS} trials × {eng['n_rpms']} RPMs")
        jobs.append((eng["name"], study_path, result_path))

    if not jobs:
        print("Nothing to run.")
        return

    print(f"\nRunning {len(jobs)} engine sweeps × {PARALLEL}-way parallel ...")
    t0 = time.time()
    with ProcessPoolExecutor(max_workers=PARALLEL) as ex:
        futures = {ex.submit(run_one, j): j for j in jobs}
        for fut in as_completed(futures):
            name, status, dt, msg = fut.result()
            mark = "✓" if status == "OK" else "✗"
            print(f"  {mark} {name}  ({dt/60:.1f} min)  {msg}")
    print(f"\nAll done in {(time.time()-t0)/60:.1f} min wallclock.")


if __name__ == "__main__":
    main()
