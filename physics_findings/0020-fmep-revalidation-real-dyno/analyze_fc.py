"""
Fine-grained fmep_c sensitivity analysis vs real dyno.
Keeps fmep_a=0.5, fmep_b=0.1 (current sim defaults); varies only fmep_c.
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
FC_VALUES = ["0.00300", "0.00200", "0.00150", "0.00125", "0.00100", "0.00075", "0.00050"]


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
    rmse = math.sqrt(sum(e*e for e in errs) / n)
    bias = sum(errs) / n
    return rmse, bias


def ndjson_path(fc, eng):
    if fc == "0.00300":
        return HERE / f"results_current_{eng}.ndjson"
    label = f"fc_{fc.replace('.', '_')}"
    return HERE / f"results_{label}_{eng}.ndjson"


def main():
    bands = [
        ("4-13k all",     4000, 13000),
        ("6-13k WOT",     6000, 13000),
        ("7-11.5k peak",  7000, 11500),
        ("4-7k low",      4000, 7000),
        ("10.5-13k high", 10500, 13000),
    ]
    print(f"\nfmep_c sensitivity (fmep_a=0.5, fmep_b=0.1 held; Heywood Tab 13.3 range: 5e-4 to 1e-3)\n")
    for eng in ["sdm26", "sdm25"]:
        dyno = load_dyno(DYNO[eng])
        print(f"=== {eng.upper()} ===")
        print(f"  {'fmep_c':>8}  " + "   ".join(f"{b:>14}" for b, *_ in bands))
        for fc in FC_VALUES:
            sim = load_ndjson(ndjson_path(fc, eng))
            cells = []
            for _, lo, hi in bands:
                m = metric(sim, dyno, lo, hi)
                if m:
                    cells.append(f"R={m[0]:5.2f} b={m[1]:+5.2f}")
                else:
                    cells.append("       -      ")
            note = "  ← Heywood ceiling" if fc == "0.00100" else ("  ← Heywood floor" if fc == "0.00050" else
                   ("  ← Heywood midpoint" if fc == "0.00075" else ("  ← CURRENT DEFAULT" if fc == "0.00300" else "")))
            print(f"  {fc:>8}  " + "   ".join(cells) + note)
        print()

    # Joint score over both engines for WOT band
    print("Combined bias² score on 7-11.5k WOT band (lower = better fit on BOTH engines):")
    print(f"  {'fmep_c':>8}  {'SDM26 RMSE':>11}  {'SDM26 bias':>11}  {'SDM25 RMSE':>11}  {'SDM25 bias':>11}  {'score':>8}")
    for fc in FC_VALUES:
        sim26 = load_ndjson(ndjson_path(fc, "sdm26"))
        sim25 = load_ndjson(ndjson_path(fc, "sdm25"))
        m26 = metric(sim26, load_dyno(DYNO["sdm26"]), 7000, 11500)
        m25 = metric(sim25, load_dyno(DYNO["sdm25"]), 7000, 11500)
        if m26 and m25:
            score = m26[1]**2 + m25[1]**2
            mark = "  ★" if score < 5 else ""
            print(f"  {fc:>8}  {m26[0]:11.2f}  {m26[1]:+11.2f}  {m25[0]:11.2f}  {m25[1]:+11.2f}  {score:8.2f}{mark}")
    print()

    # Same on the full 6-13k WOT band
    print("Combined bias² score on 6-13k WOT band:")
    print(f"  {'fmep_c':>8}  {'SDM26 RMSE':>11}  {'SDM26 bias':>11}  {'SDM25 RMSE':>11}  {'SDM25 bias':>11}  {'score':>8}")
    for fc in FC_VALUES:
        sim26 = load_ndjson(ndjson_path(fc, "sdm26"))
        sim25 = load_ndjson(ndjson_path(fc, "sdm25"))
        m26 = metric(sim26, load_dyno(DYNO["sdm26"]), 6000, 13000)
        m25 = metric(sim25, load_dyno(DYNO["sdm25"]), 6000, 13000)
        if m26 and m25:
            score = m26[1]**2 + m25[1]**2
            mark = "  ★" if score < 5 else ""
            print(f"  {fc:>8}  {m26[0]:11.2f}  {m26[1]:+11.2f}  {m25[0]:11.2f}  {m25[1]:+11.2f}  {score:8.2f}{mark}")


if __name__ == "__main__":
    main()
