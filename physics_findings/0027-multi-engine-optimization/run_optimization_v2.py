"""
v2 optimization — addresses the 3 model gaps flagged after v1:

(1) Per-engine FMEP scaling (n_cyl-aware). Heywood Ch 13's
    Patton-Nitschke-Heywood decomposition shows piston/ring + valvetrain
    + bearing friction scales with cylinder count. A single's mechanical
    FMEP is ~70% of a 4-cyl's at matched displacement, primarily from
    valvetrain (1× vs 4× sets of cams/lifters) and crankshaft seal/bearing
    counts.

    Scale factors applied to fmep_a and fmep_b (the constant + linear-in-
    piston-speed terms):
       n_cyl=1 → 0.70
       n_cyl=2 → 0.78
       n_cyl=3 → 0.85
       n_cyl=4 → 1.00
    fmep_c (high-rpm windage) stays uniform at Heywood Tab 13.3 midpoint
    0.00075 — quadratic-in-speed term scales with bearing surface but
    matters most at high RPM where singles aren't operating anyway.

(2) Per-engine cam timing as opt variables. The SDM26 cam (350° / 585°
    intake) is a 4-cyl race profile. Singles + triples have different
    optimum cam timing for their breathing regime. We let the optimizer
    pick within reasonable physical ranges.

(3) Better RPM weighting in the post-hoc analysis (autocross-style,
    not power-weighted across full WOT band). Handled in the analysis
    script, not here — this script just runs the sims.

50 LHS trials × 14 vars (4-cyl) or 12 vars (1/3-cyl), 4-way parallel.
~2 hours wallclock.
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
(HERE / "studies_v2").mkdir(parents=True, exist_ok=True)
(HERE / "results_v2").mkdir(parents=True, exist_ok=True)
BENCH = ROOT / "target/release/helios-bench"

N_TRIALS = 60
SEED = 42
PARALLEL = 4

# FMEP scaling factors (Heywood-class Patton-Nitschke-Heywood approx).
# Applied to fmep_a (constant) and fmep_b (linear-in-piston-speed).
# fmep_c (quadratic) unchanged at Heywood Tab 13.3 motorcycle midpoint.
FMEP_SCALE = {1: 0.70, 2: 0.78, 3: 0.85, 4: 1.00}
FMEP_A_BASE = 0.5     # SDM26 default — represents "4-cyl 600cc baseline"
FMEP_B_BASE = 0.1     # ditto
FMEP_C_VAL  = 0.00075 # Heywood motorcycle midpoint (Option B, finding 0020)

# Option B production knob set — applied to every trial
def option_b_fixed():
    return [
        ("intake_junction_borda_carnot", 1.0, 1.0),
        ("intake_junction_loss_coef", 1.0, 1.0),
        ("restrictor_loss_from_diffuser_geometry", 1.0, 1.0),
        ("restrictor_cd_mach_k", 0.10, 0.10),
        ("spark_advance_rpm_slope_deg_per_krpm", 1.5, 1.5),
        ("duration_rpm_exp", 0.4, 0.4),
        ("fmep_c", FMEP_C_VAL, FMEP_C_VAL),
    ]

# Geometry optimization variables — intake + exhaust peripherals
INTAKE_VARS = [
    ("runner_length",       0.10,   0.40),
    ("runner_diameter_in",  0.028,  0.045),
    ("plenum_volume",       0.0005, 0.005),
    ("plenum_length",       0.10,   0.40),
]

EXHAUST_COMMON_VARS = [
    ("primary_length",        0.20,  0.80),
    ("primary_diameter_in",   0.025, 0.055),
    ("collector_length",      0.05,  0.40),
    ("collector_diameter_in", 0.030, 0.080),
]

EXHAUST_FOUR_TWO_ONE_VARS = [
    ("secondary_length",      0.15, 0.80),
    ("secondary_diameter_in", 0.030, 0.070),
]

# NEW v2: cam-timing variables (intake open/close, exhaust open/close)
# Ranges centered on SDM26 defaults (350/585, 140/365) with ±25° each.
CAM_VARS = [
    ("intake_valve_open_angle",   325.0, 360.0),
    ("intake_valve_close_angle",  565.0, 615.0),
    ("exhaust_valve_open_angle",  120.0, 155.0),
    ("exhaust_valve_close_angle", 345.0, 390.0),
]


def build_toml(engine: dict) -> str:
    n_cyl = engine["n_cyl"]
    rpms_str = ", ".join(f"{r}.0" for r in engine["rpms"])
    fmep_scale = FMEP_SCALE.get(n_cyl, 1.0)
    fmep_a = FMEP_A_BASE * fmep_scale
    fmep_b = FMEP_B_BASE * fmep_scale
    # Per-engine FMEP applied as FIXED overrides
    fmep_fixed = [
        ("fmep_a", fmep_a, fmep_a),
        ("fmep_b", fmep_b, fmep_b),
    ]
    fixed = option_b_fixed() + fmep_fixed
    var_set = fixed + INTAKE_VARS + EXHAUST_COMMON_VARS + CAM_VARS
    if n_cyl == 4:
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
        n = sum(1 for line in f if '"kind":"trial"' in line)
    return (name, "OK", dt, f"{n} records")


def main():
    engines = json.loads((SWEEP_DIR / "configs/summary.json").read_text())
    jobs = []
    for eng in engines:
        toml = build_toml(eng)
        study_path = HERE / "studies_v2" / f"{eng['name']}.toml"
        result_path = HERE / "results_v2" / f"{eng['name']}.ndjson"
        study_path.write_text(toml)
        if result_path.exists() and result_path.stat().st_size > 10000:
            print(f"  SKIP {eng['name']}")
            continue
        n_var = (len(INTAKE_VARS) + len(EXHAUST_COMMON_VARS) + len(CAM_VARS)
                 + (len(EXHAUST_FOUR_TWO_ONE_VARS) if eng["n_cyl"] == 4 else 0))
        fmep_a = FMEP_A_BASE * FMEP_SCALE.get(eng["n_cyl"], 1.0)
        print(f"  QUEUE {eng['name']}: n_cyl={eng['n_cyl']}, FMEP_a={fmep_a:.3f}, "
              f"{n_var} opt vars × {N_TRIALS} trials × {eng['n_rpms']} RPMs")
        jobs.append((eng["name"], study_path, result_path))

    if not jobs:
        print("Nothing to run.")
        return

    print(f"\nRunning {len(jobs)} engine sweeps × {PARALLEL}-way parallel ...")
    t0 = time.time()
    with ProcessPoolExecutor(max_workers=PARALLEL) as ex:
        futures = {ex.submit(run_one, j): j for j in jobs}
        done = 0
        for fut in as_completed(futures):
            name, status, dt, msg = fut.result()
            done += 1
            mark = "✓" if status == "OK" else "✗"
            print(f"  {mark} {name}  ({dt/60:.1f} min)  [{done}/{len(jobs)}]  {msg}",
                  flush=True)
    print(f"\nAll done in {(time.time()-t0)/60:.1f} min")


if __name__ == "__main__":
    main()
