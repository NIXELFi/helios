"""
For each engine's best-AUC-Tq geometry trial, run an AFR sweep to find
the most-efficient AFR. afr_eta_enabled=1 so lean misfire is captured.

This corrects an obvious flaw in the earlier efficiency comparison:
forcing every engine to AFR=13.1 (the SDM26 power tune) misrepresents
engines that real teams run lean for efficiency points (KTM 690 Duke
being the user-flagged example).

For speed: only 5 RPM points per engine (covering the WOT band), 6 AFR
candidates, 4-way parallel. ~15 min wallclock.
"""
from __future__ import annotations
import json
import subprocess
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

ROOT = Path("/Users/nmurray/Developer/helios")
OPT_DIR = ROOT / "physics_findings/0027-multi-engine-optimization"
HERE = OPT_DIR  # write into the same finding dir
BENCH = ROOT / "target/release/helios-bench"

AFR_VALUES = [12.5, 13.1, 13.5, 14.0, 14.7, 15.5, 16.5]
N_RPM_POINTS = 7   # spread across the WOT operating band

# Pull engine info from the multi-engine sweep summary
SUMMARY = ROOT / "physics_findings/0026-multi-engine-sweep/configs/summary.json"


def best_geom_overrides(stem: str) -> dict:
    """For an engine, find the best-AUC-torque trial's parameter overrides
    from the existing optimization NDJSON."""
    path = OPT_DIR / "results" / f"{stem}.ndjson"
    if not path.exists():
        return {}
    import math
    by_trial = {}
    with open(path) as f:
        for line in f:
            d = json.loads(line)
            if d.get("kind") != "trial":
                continue
            tid = d["trial_id"]
            if tid not in by_trial:
                by_trial[tid] = {"rpms": [], "bp_kw": [], "overrides": d.get("overrides", {})}
            by_trial[tid]["rpms"].append(d["rpm"])
            by_trial[tid]["bp_kw"].append(d["brake_power_kW"])
    best_tid, best_auc = None, -1
    for tid, t in by_trial.items():
        # auc(torque) is monotone with auc(power)/rpm. Use AUC HP as proxy
        # for ranking (same trial wins both)
        order = sorted(range(len(t["rpms"])), key=lambda i: t["rpms"][i])
        rpms = [t["rpms"][i] for i in order]
        bp = [t["bp_kw"][i] for i in order]
        # wheel power × correction to torque
        wt_sum = 0.0
        for i in range(1, len(rpms)):
            wt_i  = (bp[i]   * 0.85 * 1000) / (2 * math.pi * rpms[i]   / 60)
            wt_im = (bp[i-1] * 0.85 * 1000) / (2 * math.pi * rpms[i-1] / 60)
            wt_sum += 0.5 * (wt_i + wt_im) * (rpms[i] - rpms[i-1])
        if wt_sum > best_auc:
            best_auc = wt_sum
            best_tid = tid
    return by_trial[best_tid]["overrides"]


def build_toml(engine: dict, geom_overrides: dict, rpms: list[float]) -> str:
    """Build a sweep TOML that LHS-samples AFR with geometry held fixed
    at the engine's best-AUC-Tq trial."""
    # Fixed overrides (Option B knob set + the geometry from the winning trial)
    fixed_overrides = []
    # First: all the geometry from the best trial
    for path, val in geom_overrides.items():
        fixed_overrides.append((path, val))
    # Enable afr_eta penalty so lean misfire is modeled
    fixed_overrides.append(("afr_eta_enabled", 1.0))

    rpms_str = ", ".join(f"{r}.0" for r in rpms)
    fixed_lines = [
        f'  {{ name = "{p}", min = {v}, max = {v} }},' for p, v in fixed_overrides
    ]
    # The AFR is the only varying parameter — one trial per AFR value via
    # an LHS sample over a discrete-snapping sweep is awkward; helios-bench
    # doesn't have an enumeration sampler. Workaround: run N_AFR separate
    # one-trial sweeps, each fixing the AFR at a different value.
    fixed_lines_str = "\n".join(fixed_lines)
    return fixed_lines_str, rpms_str


def make_single_afr_toml(engine_config: str, geom_overrides: dict, rpms: list[float], afr: float) -> str:
    fixed_lines_str, rpms_str = build_toml({}, geom_overrides, rpms)
    return f"""[run]
config = "{engine_config}"
rpm = [{rpms_str}]
cycles = 30
recorded = true
seed = 8000
junction = "characteristic"

[environment]
target_triple = "aarch64-apple-darwin"
rustc_version = "rustc 1.95.0"
rayon_threads = 1
libm_source = "system"

[sweep]
sampler = "lhs"
n_trials = 1
parameters = [
{fixed_lines_str}
  {{ name = "afr_target", min = {afr}, max = {afr} }},
]
"""


def run_one(args):
    (label, study_path, result_path) = args
    t0 = time.time()
    proc = subprocess.run(
        [str(BENCH), "sweep", str(study_path), "--out", str(result_path)],
        capture_output=True, text=True,
    )
    dt = time.time() - t0
    if proc.returncode != 0:
        return (label, "ERROR", dt, proc.stderr[:200])
    return (label, "OK", dt, "")


def main():
    engines = json.loads(SUMMARY.read_text())
    (HERE / "afr_studies").mkdir(parents=True, exist_ok=True)
    (HERE / "afr_results").mkdir(parents=True, exist_ok=True)

    jobs = []
    for eng in engines:
        name = eng["name"]
        ov = best_geom_overrides(name)
        if not ov:
            print(f"  SKIP {name}: no opt results")
            continue
        # Pick 7 RPMs spread across the WOT band (idle+30% .. redline)
        rpm_lo = eng["rpm_lo"]
        rpm_hi = eng["rpm_hi"]
        wot_lo = int(rpm_lo + 0.35 * (rpm_hi - rpm_lo))
        rpms = [wot_lo + int(i * (rpm_hi - wot_lo) / (N_RPM_POINTS - 1)) for i in range(N_RPM_POINTS)]
        # Round to nearest 250 RPM
        rpms = [int(round(r / 250)) * 250 for r in rpms]
        for afr in AFR_VALUES:
            label = f"{name}__afr{afr}"
            toml_text = make_single_afr_toml(eng["config"], ov, rpms, afr)
            study_path = HERE / "afr_studies" / f"{label}.toml"
            result_path = HERE / "afr_results" / f"{label}.ndjson"
            study_path.write_text(toml_text)
            if result_path.exists() and result_path.stat().st_size > 1000:
                continue
            jobs.append((label, study_path, result_path))

    if not jobs:
        print("Nothing to run.")
        return

    print(f"Running {len(jobs)} AFR sweeps × 4-way parallel ...")
    t0 = time.time()
    with ProcessPoolExecutor(max_workers=4) as ex:
        futures = {ex.submit(run_one, j): j for j in jobs}
        done = 0
        for fut in as_completed(futures):
            label, status, dt, msg = fut.result()
            done += 1
            mark = "✓" if status == "OK" else "✗"
            if status != "OK":
                print(f"  {mark} {label}  ({dt:.0f}s)  {msg}")
            else:
                print(f"  {mark} {label}  ({dt:.0f}s)  [{done}/{len(jobs)}]", flush=True)
    print(f"\nAll done in {(time.time()-t0)/60:.1f} min")


if __name__ == "__main__":
    main()
