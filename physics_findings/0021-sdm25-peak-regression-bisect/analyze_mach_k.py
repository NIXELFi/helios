"""
Analyze Mach-Cd k sweep × FMEP variant. Find the production-knob-set
configuration that fits BOTH engines best on the real dyno WOT band.
"""
from __future__ import annotations
import csv, json, math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
DYNO = {
    "sdm26": ROOT / "physics_findings/references/dyno/sdm26-team-dyno.csv",
    "sdm25": ROOT / "physics_findings/references/dyno/sdm25-team-dyno.csv",
}
ETA = 0.85
KS = ["0.00", "0.10", "0.15", "0.20", "0.25", "0.30", "0.40"]
FC_VARIANTS = [("fmep_curr_0.003", 0.003), ("fmep_fix_0.00075", 0.00075)]


def load_ndjson(p):
    rows = {}
    for line in open(p):
        d = json.loads(line)
        if d.get("kind") == "trial":
            rows[int(d["rpm"])] = d
    return rows


def load_dyno(p):
    out = {}
    for r in csv.DictReader(open(p)):
        if r["brake_power_kW"]:
            out[int(float(r["rpm"]))] = float(r["brake_power_kW"])
    return out


def metric(sim, dyno, lo, hi):
    errs = [(sim[r]["brake_power_kW"] * ETA - dyno[r])
            for r in sorted(set(sim) & set(dyno)) if lo <= r <= hi]
    if not errs:
        return None
    n = len(errs)
    return math.sqrt(sum(e * e for e in errs) / n), sum(errs) / n


def main():
    dyno_sdm26 = load_dyno(DYNO["sdm26"])
    dyno_sdm25 = load_dyno(DYNO["sdm25"])

    for band_name, lo, hi in [("WOT 6-13k", 6000, 13000),
                              ("Peak 7-11.5k", 7000, 11500),
                              ("High 10.5-13k", 10500, 13000)]:
        print(f"\n=== {band_name} ===")
        print(f"  {'mach_k':>7}  {'fmep_c':>7}    "
              f"{'SDM26 RMSE':>11} {'SDM26 bias':>11}   "
              f"{'SDM25 RMSE':>11} {'SDM25 bias':>11}   "
              f"{'comb score':>11}")
        best = (1e9, None)
        for k in KS:
            for fc_label, fc_val in FC_VARIANTS:
                s26 = load_ndjson(HERE / f"results_k{k.replace('.','_')}_{fc_label}_sdm26.ndjson")
                s25 = load_ndjson(HERE / f"results_k{k.replace('.','_')}_{fc_label}_sdm25.ndjson")
                m26 = metric(s26, dyno_sdm26, lo, hi)
                m25 = metric(s25, dyno_sdm25, lo, hi)
                if not m26 or not m25:
                    continue
                # Combined score = sum of squared bias on both engines
                score = m26[1]**2 + m25[1]**2
                if score < best[0]:
                    best = (score, (k, fc_label, m26, m25))
                mark = ""
                if k == "0.30" and fc_label == "fmep_curr_0.003":
                    mark = "  ← CURRENT PRODUCTION"
                if k == "0.30" and fc_label == "fmep_fix_0.00075":
                    mark = "  ← finding 0020"
                print(f"  {k:>7}  {fc_val:>7.5f}    "
                      f"{m26[0]:11.2f} {m26[1]:+11.2f}   "
                      f"{m25[0]:11.2f} {m25[1]:+11.2f}   "
                      f"{score:11.2f}{mark}")
        if best[1]:
            k, fc, m26, m25 = best[1]
            print(f"\n  → BEST on {band_name}: mach_k={k}, fmep_c={dict(FC_VARIANTS)[fc]}")
            print(f"      SDM26 RMSE={m26[0]:.2f} bias={m26[1]:+.2f}; SDM25 RMSE={m25[0]:.2f} bias={m25[1]:+.2f}")


if __name__ == "__main__":
    main()
