"""
Compare MAIN branch simulator vs CURRENT HEAD (with Option B production
knobs from finding 0021 + 0020 fmep_c fix) against the real team dyno.

Main = bare simulator, no production knob set (none of finding 0005-0021
work). All values via direct SDM26Engine::new() with default config.

HEAD = Option B production knob set (finding 0021):
  intake_junction_borda_carnot = 1
  restrictor_loss_from_diffuser_geometry = 1
  restrictor_cd_mach_k = 0.10
  spark_advance_rpm_slope_deg_per_krpm = 1.5
  duration_rpm_exp = 0.4
  fmep_c = 0.00075
"""
from __future__ import annotations
import csv, json, math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ETA = 0.85
D26 = ROOT / "physics_findings/references/dyno/sdm26-team-dyno.csv"
D25 = ROOT / "physics_findings/references/dyno/sdm25-team-dyno.csv"

MAIN_26 = Path("/tmp/main_sdm26.csv")
MAIN_25 = Path("/tmp/main_sdm25.csv")
HEAD_26 = ROOT / "physics_findings/0023-weno5-pipe-solver/results_optionB_sdm26.ndjson"
HEAD_25 = ROOT / "physics_findings/0023-weno5-pipe-solver/results_optionB_sdm25.ndjson"


def load_main_csv(p):
    out = {}
    with open(p) as f:
        for r in csv.DictReader(f):
            out[int(float(r["rpm"]))] = float(r["brake_power_kW"])
    return out


def load_ndjson(p):
    out = {}
    for line in open(p):
        d = json.loads(line)
        if d.get("kind") == "trial":
            out[int(d["rpm"])] = d["brake_power_kW"]
    return out


def load_dyno(p):
    out = {}
    for r in csv.DictReader(open(p)):
        if r["brake_power_kW"]:
            out[int(float(r["rpm"]))] = float(r["brake_power_kW"])
    return out


def stat(sim_brake, dyno_wheel, lo, hi):
    errs = []
    for r in sorted(set(sim_brake) & set(dyno_wheel)):
        if lo <= r <= hi:
            errs.append(sim_brake[r] * ETA - dyno_wheel[r])
    if not errs:
        return None
    n = len(errs)
    return math.sqrt(sum(e * e for e in errs) / n), sum(errs) / n, n


main26 = load_main_csv(MAIN_26)
main25 = load_main_csv(MAIN_25)
head26 = load_ndjson(HEAD_26)
head25 = load_ndjson(HEAD_25)
dyno26 = load_dyno(D26)
dyno25 = load_dyno(D25)

print("\n========================================================================")
print("ACCURACY COMPARISON: main branch vs current HEAD (Option B production set)")
print("Real team dyno reference (Dynojet wheel power, finding 0018).")
print("========================================================================")
for band, lo, hi in [
    ("All 4-13k",       4000, 13000),
    ("WOT 6-13k",       6000, 13000),
    ("Peak 7-11.5k",    7000, 11500),
    ("Low 4-7k",        4000, 7000),
    ("High 10.5-13k",  10500, 13000),
]:
    print(f"\n=== {band} ===")
    print(f"  {'engine':>6}  {'main RMSE':>10} {'main bias':>10}  "
          f"{'HEAD RMSE':>10} {'HEAD bias':>10}  {'ΔRMSE':>8} {'Δbias':>8}")
    for eng, ms, hs, dn in [
        ("SDM26", main26, head26, dyno26),
        ("SDM25", main25, head25, dyno25),
    ]:
        m = stat(ms, dn, lo, hi)
        h = stat(hs, dn, lo, hi)
        if m and h:
            d_rmse = h[0] - m[0]
            d_bias = h[1] - m[1]
            improvement = "IMPROVED" if abs(h[0]) < abs(m[0]) else ("WORSE" if abs(h[0]) > abs(m[0]) else "—")
            print(f"  {eng:>6}  {m[0]:10.2f} {m[1]:+10.2f}  "
                  f"{h[0]:10.2f} {h[1]:+10.2f}  {d_rmse:+8.2f} {d_bias:+8.2f}  {improvement}")

print("\n\nPer-RPM detail (SDM26, full WOT band):")
print(f"  {'RPM':>5}  {'dyno':>6}  {'main_w':>7}  {'main−d':>7}  {'HEAD_w':>7}  {'HEAD−d':>7}")
for r in sorted(set(main26) & set(head26) & set(dyno26)):
    m_w = main26[r] * ETA
    h_w = head26[r] * ETA
    d = dyno26[r]
    print(f"  {r:>5}  {d:6.2f}  {m_w:7.2f}  {m_w-d:+7.2f}  {h_w:7.2f}  {h_w-d:+7.2f}")
print("\nPer-RPM detail (SDM25, full WOT band):")
print(f"  {'RPM':>5}  {'dyno':>6}  {'main_w':>7}  {'main−d':>7}  {'HEAD_w':>7}  {'HEAD−d':>7}")
for r in sorted(set(main25) & set(head25) & set(dyno25)):
    m_w = main25[r] * ETA
    h_w = head25[r] * ETA
    d = dyno25[r]
    print(f"  {r:>5}  {d:6.2f}  {m_w:7.2f}  {m_w-d:+7.2f}  {h_w:7.2f}  {h_w-d:+7.2f}")
