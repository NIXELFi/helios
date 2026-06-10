"""
Finding 0028: dyno-RMSE recalibration of the Rust solver defaults.

Python parity is no longer a constraint (v4.3.3 mandate) — the goal is
minimum banded RMSE against the REAL team dynos (finding 0018 corpus)
on BOTH engines (C10 anti-overfit guard), by enabling the validated
opt-in physics and fixing numerics dissipation.

Stages:
  all_off   parity defaults (legacy baseline)
  prod      Option B production knob set (finding 0021)
  vl_cfl    prod + van Leer limiter + CFL 0.5      (numerics fidelity)
  sb_cfl    prod + Superbee limiter + CFL 0.5
  valve     vl_cfl + flat-top cam lift + low-Re Cd  (finding 0015)
  exh_r15   valve + collector reflection 0.15       (finding 0007)
  exh_r30   valve + collector reflection 0.30
  afr_eta   valve + AFR efficiency factor           (finding 0024)
  two_zone  valve + two-zone w/ cv-weighted gamma   (findings 0010/0016)

Runs helios-bench sweeps in parallel processes; skips existing outputs.
"""
from __future__ import annotations
import subprocess, sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
BENCH = ROOT / "target/release/helios-bench.exe"

RPMS = ", ".join(f"{r}.0" for r in range(4500, 14000, 500))

PROD = {
    "intake_junction_borda_carnot": 1.0,
    "intake_junction_loss_coef": 1.0,
    "restrictor_loss_from_diffuser_geometry": 1.0,
    "restrictor_cd_mach_k": 0.10,
    "spark_advance_rpm_slope_deg_per_krpm": 1.5,
    "duration_rpm_exp": 0.4,
    "fmep_c": 0.00075,
}
NUM_VL = {**PROD, "limiter": 1.0, "cfl": 0.5}
VALVE = {
    **NUM_VL,
    "intake_lift_flat_top_ramp": 0.25,
    "exhaust_lift_flat_top_ramp": 0.25,
    "intake_valve_re_correction_enabled": 1.0,
}

VARIANTS: dict[str, dict[str, float]] = {
    "all_off": {},
    "prod": PROD,
    "vl_cfl": NUM_VL,
    "sb_cfl": {**PROD, "limiter": 2.0, "cfl": 0.5},
    "valve": VALVE,
    "exh_r15": {**VALVE, "exhaust_collector_reflection_coef": 0.15},
    "exh_r30": {**VALVE, "exhaust_collector_reflection_coef": 0.30},
    "afr_eta": {**VALVE, "afr_eta_enabled": 1.0},
    "two_zone": {**VALVE, "two_zone_enabled": 1.0,
                 "two_zone_gamma_cv_weighted": 1.0},
}

# Refinement grid around the round-1 winner (exh_r15)
for ramp in (0.15, 0.20, 0.25):
    for refl in (0.10, 0.15, 0.20):
        VARIANTS[f"g_rm{int(ramp*100)}_rf{int(refl*100)}"] = {
            **NUM_VL,
            "intake_lift_flat_top_ramp": ramp,
            "exhaust_lift_flat_top_ramp": ramp,
            "intake_valve_re_correction_enabled": 1.0,
            "exhaust_collector_reflection_coef": refl,
        }
# bias trims on the round-1 winner
for eta in (0.92, 0.94):
    VARIANTS[f"t_eta{int(eta*100)}"] = {
        **VARIANTS["exh_r15"], "eta_comb": eta}
VARIANTS["t_afr"] = {**VARIANTS["exh_r15"], "afr_eta_enabled": 1.0}
VARIANTS["t_machk20"] = {**VARIANTS["exh_r15"], "restrictor_cd_mach_k": 0.20}

# Final combo round: balance per-engine bias without overfitting
_RM15 = {**NUM_VL,
         "intake_lift_flat_top_ramp": 0.15,
         "exhaust_lift_flat_top_ramp": 0.15,
         "intake_valve_re_correction_enabled": 1.0,
         "exhaust_collector_reflection_coef": 0.10}
VARIANTS["c_rm15_eta94"] = {**_RM15, "eta_comb": 0.94}
VARIANTS["c_rm15_eta95"] = {**_RM15, "eta_comb": 0.95}
VARIANTS["c_r15_eta94_mk15"] = {
    **VARIANTS["exh_r15"], "eta_comb": 0.94, "restrictor_cd_mach_k": 0.15}
VARIANTS["c_r15_eta95_mk20"] = {
    **VARIANTS["exh_r15"], "eta_comb": 0.95, "restrictor_cd_mach_k": 0.20}

STUDY = """[run]
config = "crates/engine-sim/python_ref/configs/{engine}.json"
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
        engine=engine, rpms=RPMS,
        params=fmt_params(VARIANTS[variant])))
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
