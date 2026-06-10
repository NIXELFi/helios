"""
For each engine config built by build_configs.py, run a helios-bench
sweep at 250-RPM steps from idle to redline with Option B production
knob set. Aggregates results into a single CSV for downstream plotting.
"""
from __future__ import annotations
import json
import subprocess
from pathlib import Path

ROOT = Path("/Users/nmurray/Developer/helios")
HERE = ROOT / "physics_findings/0026-multi-engine-sweep"
SUMMARY = HERE / "configs/summary.json"
BENCH = ROOT / "target/release/helios-bench"

# Option B production knob set (finding 0021)
OPTION_B_OVERRIDES = """
  { name = "intake_junction_borda_carnot", min = 1.0, max = 1.0 },
  { name = "intake_junction_loss_coef", min = 1.0, max = 1.0 },
  { name = "restrictor_loss_from_diffuser_geometry", min = 1.0, max = 1.0 },
  { name = "restrictor_cd_mach_k", min = 0.10, max = 0.10 },
  { name = "spark_advance_rpm_slope_deg_per_krpm", min = 1.5, max = 1.5 },
  { name = "duration_rpm_exp", min = 0.4, max = 0.4 },
  { name = "fmep_c", min = 0.00075, max = 0.00075 },
""".strip()

STUDY_TEMPLATE = """[run]
config = "{config}"
rpm = [{rpms}]
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
{overrides}
]
"""


def main():
    engines = json.loads(SUMMARY.read_text())
    studies_dir = HERE / "studies"
    results_dir = HERE / "results"
    studies_dir.mkdir(parents=True, exist_ok=True)
    results_dir.mkdir(parents=True, exist_ok=True)

    for eng in engines:
        name = eng["name"]
        rpms_str = ", ".join(f"{r}.0" for r in eng["rpms"])
        toml = STUDY_TEMPLATE.format(
            config=eng["config"],
            rpms=rpms_str,
            overrides=OPTION_B_OVERRIDES,
        )
        study_path = studies_dir / f"{name}.toml"
        result_path = results_dir / f"{name}.ndjson"
        study_path.write_text(toml)

        if result_path.exists() and result_path.stat().st_size > 1000:
            print(f"  {name}: ALREADY EXISTS, skipping (delete {result_path} to re-run)")
            continue

        print(f"  {name}: running {eng['n_rpms']} RPMs (Option B)...", flush=True)
        proc = subprocess.run(
            [str(BENCH), "sweep", str(study_path), "--out", str(result_path)],
            capture_output=True, text=True,
        )
        if proc.returncode != 0:
            print(f"    ❌ failed: {proc.stderr[:300]}")
            continue
        # Count trial lines (excluding env line 1)
        with open(result_path) as f:
            n_trials = sum(1 for line in f if '"kind":"trial"' in line)
        print(f"    ✓ {n_trials} RPM points")


if __name__ == "__main__":
    main()
