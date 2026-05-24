"""
Test whether a physically-derived drivetrain η(P, ω) map fits both
SDM25 and SDM26 dynos better than the constant η = 0.85 default.

Model (Cameron/Heywood chain+gear motorcycle drivetrain physics):
    η(P_brake, ω) = η_max · P_brake / (P_brake + base_drag + windage · (ω/ω_max)²)

Where:
    η_max     = 0.92    # peak chain+gear mechanical efficiency at high load
                       # (Cameron "Sportbike Performance Handbook", upper bound
                       #  for well-maintained chain + gearbox in top gear)
    base_drag = 2.5 kW # idle drag (chain pitch friction, gear oil churn at
                       #  zero load) — Cameron Tab 7.2 / Heywood §13.7
    windage   = 1.5 kW # RPM-quadratic viscous loss at ω_max (gear churn,
                       #  bearing friction)
    ω_max     = 14000 RPM  # redline reference

These constants are NOT tuned to our dyno data. They are literature midpoints
for a 600cc-class chain-drive motorcycle. The model is symmetric: applied
identically to SDM25 and SDM26.

Anti-overfit guard (C10): an honest physics fix moves both engines toward
better fit. If only one engine improves, the model is absorbing simulator
defects rather than capturing real drivetrain physics.
"""
from __future__ import annotations
import csv, json, math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DYNO = {
    "sdm26": ROOT / "physics_findings/references/dyno/sdm26-team-dyno.csv",
    "sdm25": ROOT / "physics_findings/references/dyno/sdm25-team-dyno.csv",
}
SIM = {
    "sdm26": ROOT / "physics_findings/0015-low-rpm-port-loss/results_baseline_sdm26.ndjson",
    "sdm25": ROOT / "physics_findings/0015-low-rpm-port-loss/results_baseline_sdm25.ndjson",
}

# Literature constants (Cameron + Heywood). NOT fitted.
ETA_MAX = 0.92
BASE_DRAG_KW = 2.5
WINDAGE_KW_AT_MAX = 1.5
OMEGA_MAX_RPM = 14000.0


def eta_drivetrain(p_brake_kw: float, rpm: float) -> float:
    """Physically-derived motorcycle drivetrain η(P, ω). Literature-only."""
    windage = WINDAGE_KW_AT_MAX * (rpm / OMEGA_MAX_RPM) ** 2
    p_loss = BASE_DRAG_KW + windage
    if p_brake_kw + p_loss <= 0:
        return ETA_MAX
    return ETA_MAX * p_brake_kw / (p_brake_kw + p_loss)


def load_ndjson(path):
    rows = {}
    with open(path) as f:
        for line in f:
            d = json.loads(line)
            if d.get("kind") == "trial":
                rows[int(d["rpm"])] = d
    return rows


def load_dyno(path):
    out = {}
    with open(path) as f:
        for r in csv.DictReader(f):
            if r["brake_power_kW"]:
                out[int(float(r["rpm"]))] = float(r["brake_power_kW"])
    return out


def stats(errs):
    n = len(errs)
    if n == 0:
        return None
    rmse = math.sqrt(sum(e * e for e in errs) / n)
    bias = sum(errs) / n
    return rmse, bias, n


def report(name, sim, dyno, lo, hi):
    """Compare constant η = 0.85 vs the η(P, ω) map for one engine + band."""
    common = sorted(set(sim.keys()) & set(dyno.keys()))
    common = [r for r in common if lo <= r <= hi]
    errs_const, errs_map = [], []
    eta_map_vals = []
    for r in common:
        pb = sim[r]["brake_power_kW"]
        sim_w_const = pb * 0.85
        eta_m = eta_drivetrain(pb, r)
        sim_w_map = pb * eta_m
        eta_map_vals.append(eta_m)
        errs_const.append(sim_w_const - dyno[r])
        errs_map.append(sim_w_map - dyno[r])
    sc = stats(errs_const)
    sm = stats(errs_map)
    if sc and sm:
        print(f"  {name:50s}  RMSE: const={sc[0]:5.2f}  map={sm[0]:5.2f}   "
              f"bias: const={sc[1]:+5.2f}  map={sm[1]:+5.2f}   "
              f"η_map range [{min(eta_map_vals):.3f}, {max(eta_map_vals):.3f}]")


def print_eta_curve():
    """Show η(P, ω) at representative operating points."""
    print("Literature η(P, ω) at representative engine operating points:")
    print(f"  {'RPM':>5}  {'P_brake':>8}  {'P_loss':>7}  {'η_map':>6}")
    for rpm in [4000, 6000, 8000, 9500, 10000, 11000, 12000, 13000, 13500]:
        for p in [10, 30, 50]:
            pl = BASE_DRAG_KW + WINDAGE_KW_AT_MAX * (rpm / OMEGA_MAX_RPM) ** 2
            e = eta_drivetrain(p, rpm)
            print(f"  {rpm:5d}  {p:7.1f}   {pl:5.2f}    {e:.3f}")
        print()


def main():
    print_eta_curve()
    print()
    print("Production-knob-set sim vs real dyno: constant η=0.85 vs literature η(P,ω):")
    print()
    for eng in ["sdm26", "sdm25"]:
        sim = load_ndjson(SIM[eng])
        dyno = load_dyno(DYNO[eng])
        print(f"=== {eng.upper()} ===")
        report("All RPMs", sim, dyno, 4000, 13500)
        report("6-13k (excl. part-throttle)", sim, dyno, 6000, 13000)
        report("7-11.5k (high-confidence WOT)", sim, dyno, 7000, 11500)
        report("4-7k (low RPM)", sim, dyno, 4000, 7000)
        report("10.5-13k (high RPM)", sim, dyno, 10500, 13000)
        print()


if __name__ == "__main__":
    main()
