"""
For each engine in ~/Downloads/CFD-Configs/, build a temp config that
takes SDM26 as the base and overrides ONLY engine-specific fields:
  n_cylinders, firing_order, firing_interval
  cylinder.{bore, stroke, con_rod_length, compression_ratio}
  intake_valve.diameter / exhaust_valve.diameter (when set in source)
  intake_pipes / exhaust_primaries / exhaust_secondaries arrays truncated
    to match n_cylinders

Everything else (valve lift, cam timing, restrictor, plenum geometry,
runner geometry, combustion model coefficients, etc.) uses SDM26 defaults.
This is for an apples-to-apples comparison of bore/stroke/cyl-count
architecture rather than engine-specific tune.
"""
from __future__ import annotations
import copy, json, math
from pathlib import Path

ROOT = Path("/Users/nmurray/Developer/helios")
BASE = ROOT / "crates/engine-sim/python_ref/configs/sdm26.json"
SRC_DIR = Path.home() / "Downloads/CFD-Configs"
OUT_DIR = ROOT / "physics_findings/0026-multi-engine-sweep/configs"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Per-engine RPM ranges (idle to redline) — manufacturer specs / common knowledge.
RPM_RANGES = {
    "SDM26_Honda_CRF450R_2020":          (2000, 11000),
    "SDM26_KTM_690_Duke_2018":           (2000,  9000),
    "SDM26_Yamaha_YZ450F_2024":          (2000, 12000),
    "SDM26_Triumph_Daytona_675R_2011":   (2000, 14000),
    "SDM26_Kawasaki_ZX-6R_636_2003-2004":(2000, 16000),
    "SDM26_Suzuki_GSX-R600_2006":        (2000, 15500),
    "SDM26_Yamaha_YZF-R6_2009":          (2000, 16000),
}

RPM_STEP = 250


def truncate_per_cyl(arr, n_cyl):
    """Truncate or replicate a per-cylinder pipe array to length n_cyl."""
    if len(arr) >= n_cyl:
        return arr[:n_cyl]
    # Replicate the first entry to reach n_cyl (shouldn't happen with our inputs).
    return arr + [arr[0]] * (n_cyl - len(arr))


def secondary_count(n_cyl: int, topology: str) -> int:
    """How many secondaries a given topology needs."""
    if topology == "4-1":
        return 0
    if topology == "4-2-1":
        # Standard: 2 secondaries (pairs merge). For n_cyl < 4 we still need at
        # least 1 secondary; the simulator's secondary indexing uses
        # min(2, n_cyl//2 or 1).
        return max(1, n_cyl // 2)
    return 0


def build_one(src: Path) -> dict:
    base = json.loads(BASE.read_text())
    src_cfg = json.loads(src.read_text())

    # 1. Engine-specific scalars
    base["n_cylinders"] = src_cfg["n_cylinders"]
    base["firing_order"] = src_cfg["firing_order"]
    base["firing_interval"] = src_cfg["firing_interval"]
    n_cyl = base["n_cylinders"]

    # Update name / id-ish field if present
    if "name" in src_cfg:
        base["name"] = src_cfg["name"]

    # 2. Cylinder dimensions — only override if the source has a non-null value
    for k in ("bore", "stroke", "con_rod_length", "compression_ratio"):
        v = src_cfg.get("cylinder", {}).get(k)
        if v is not None:
            base["cylinder"][k] = v

    # 3. Valve diameter (use source if set; otherwise SDM26 default).
    for vk in ("intake_valve", "exhaust_valve"):
        if src_cfg.get(vk, {}).get("diameter") is not None:
            base[vk]["diameter"] = src_cfg[vk]["diameter"]
        # max_lift, open_angle, close_angle, seat_angle: keep SDM26 defaults
        # (per user instruction — non-engine-specific stuff uses SDM26).

    # 4. Per-cylinder pipe arrays — truncate to n_cyl
    base["intake_pipes"] = truncate_per_cyl(base["intake_pipes"], n_cyl)
    base["exhaust_primaries"] = truncate_per_cyl(base["exhaust_primaries"], n_cyl)

    # 5. Exhaust topology: SDM26 uses 4-2-1. For singles & triples this is
    #    awkward; downgrade to 4-1 (single collector, no secondaries) for
    #    n_cyl != 4.
    if n_cyl == 4:
        # Keep 4-2-1 (SDM26 baseline). Secondaries stay as-is.
        pass
    else:
        # 4-1: empty secondaries array
        base["exhaust_secondaries"] = []

    return base


def main():
    summary = []
    for src in sorted(SRC_DIR.glob("*.json")):
        name = src.stem.replace("_SOURCE_VERIFIED", "")
        cfg = build_one(src)
        out_path = OUT_DIR / f"{name}.json"
        out_path.write_text(json.dumps(cfg, indent=2))

        # RPM range for this engine
        rpm_lo, rpm_hi = RPM_RANGES.get(name, (2000, 14000))
        rpms = list(range(rpm_lo, rpm_hi + 1, RPM_STEP))

        summary.append({
            "name": name,
            "config": str(out_path),
            "n_cyl": cfg["n_cylinders"],
            "bore_mm": cfg["cylinder"]["bore"] * 1000,
            "stroke_mm": cfg["cylinder"]["stroke"] * 1000,
            "cr": cfg["cylinder"]["compression_ratio"],
            "fi_deg": cfg["firing_interval"],
            "firing_order": cfg["firing_order"],
            "rpm_lo": rpm_lo,
            "rpm_hi": rpm_hi,
            "n_rpms": len(rpms),
            "rpms": rpms,
        })
        disp_cc = math.pi * (cfg["cylinder"]["bore"] / 2) ** 2 * cfg["cylinder"]["stroke"] * cfg["n_cylinders"] * 1e6
        print(f"  {name}: n_cyl={cfg['n_cylinders']}  bore={cfg['cylinder']['bore']*1000:.1f}mm  "
              f"stroke={cfg['cylinder']['stroke']*1000:.1f}mm  CR={cfg['cylinder']['compression_ratio']}  "
              f"disp={disp_cc:.0f}cc  rpm=[{rpm_lo}..{rpm_hi}] ({len(rpms)} pts)")

    (OUT_DIR / "summary.json").write_text(json.dumps(summary, indent=2))
    print(f"\nWrote {len(summary)} configs to {OUT_DIR}")
    print(f"Summary index at {OUT_DIR}/summary.json")


if __name__ == "__main__":
    main()
